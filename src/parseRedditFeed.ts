// Reddit Atom search-feed -> JSON parser, built on fast-xml-parser.
//
// Reusable:  import { parseRedditFeed, parseAtomXml } from './parseRedditFeed.js'
// CLI:       tsx src/parseRedditFeed.ts rss-response.atom            # normalized JSON
//            tsx src/parseRedditFeed.ts rss-response.atom --raw      # faithful generic parse
//            cat rss-response.atom | tsx src/parseRedditFeed.ts      # read from stdin
//            curl -s 'https://www.reddit.com/search.rss?q=devtools' | tsx src/parseRedditFeed.ts
//
// The feed comes from https://www.reddit.com/search.rss?q=... . Two parse layers run:
//
//   1. The Atom XML itself -> faithful generic parse (every tag + attribute kept).
//   2. Each <content> element is ITSELF an HTML document; we parse that inner HTML too and
//      lift out the post body, the [link] / [comments] targets, and the inline image — data
//      that exists nowhere else in the entry. The full decoded HTML is still kept as
//      `contentHtml`, so absolutely nothing from the feed is dropped.
//
// Entry shapes handled:
//   - text/self post   : <content> = <div class="md">…body…</div> + "submitted by" footer
//   - image/link post  : <content> = <table><img …><a>[link]</a><a>[comments]</a></table>
//                        (may ALSO carry a <div class="md"> body in the second cell)
//   - subreddit result : <content> = <div>…description…</div> <div><a>[link]</a></div>
//                        (no author / category / published in these)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

// --- Layer 1: faithful, lossless Atom XML -> JSON ----------------------------

const atomParser = new XMLParser({
    // Keep attributes (term/label/href/url/type/rel) — they hold real data here.
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    // Decode XML entities (&lt; &amp; &quot; …) so `content` becomes real HTML text.
    processEntities: true,
    trimValues: true,
    // Keep ALL element text + attribute values as strings — never coerce a numeric
    // title/id into a number. Fidelity over convenience.
    parseTagValue: false,
    parseAttributeValue: false,
    // Stable shape: a feed with one result and one with many produce the same types.
    isArray: (tag: string) => tag === 'entry' || tag === 'link',
});

/** Parse Atom XML into a faithful, generic JSON object (every node + attribute kept). */
export function parseAtomXml(xml: string): any {
    if (typeof xml !== 'string' || xml.trim().length === 0) {
        throw new Error('parseAtomXml: input must be a non-empty XML string.');
    }
    const validation = XMLValidator.validate(xml);
    if (validation !== true) {
        const { msg, line, col } = validation.err;
        throw new Error(`Invalid XML: ${msg} (line ${line}, column ${col})`);
    }
    return atomParser.parse(xml);
}

// --- Layer 2: inner-HTML helpers (body, links, image) ------------------------

// Lenient parser for the HTML *inside* <content>. unpairedTags + htmlEntities keep it from
// choking on <br>, <img>, or named entities like &nbsp; that aren't valid bare XML.
const htmlParser = new XMLParser({
    ignoreAttributes: true,
    processEntities: true,
    htmlEntities: true,
    trimValues: false,
    unpairedTags: ['br', 'hr', 'img'],
});

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
};

/** Decode the entity subset that survives into already-once-decoded content (urls + text). */
function decodeEntities(s: string): string {
    return s
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
        .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

function safeCodePoint(code: number): string {
    try {
        return String.fromCodePoint(code);
    } catch {
        return '';
    }
}

/** Recursively gather text nodes from a parsed HTML tree. */
function collectText(node: unknown): string {
    if (node == null) return '';
    if (typeof node === 'string' || typeof node === 'number') return ` ${node} `;
    if (Array.isArray(node)) return node.map(collectText).join('');
    if (typeof node === 'object') {
        return Object.entries(node as Record<string, unknown>)
            .map(([k, v]) => (k.startsWith('@_') ? '' : collectText(v)))
            .join('');
    }
    return '';
}

/** Turn an HTML fragment into clean, single-spaced plain text. */
function htmlToText(html: string | null): string | null {
    if (!html) return null;
    let text: string;
    try {
        const tree = htmlParser.parse(`<root>${html}</root>`);
        text = collectText(tree);
    } catch {
        // Fallback: strip tags + decode entities manually.
        text = decodeEntities(html.replace(/<[^>]+>/g, ' '));
    }
    const cleaned = text.replace(/\s+/g, ' ').trim();
    return cleaned.length ? cleaned : null;
}

/**
 * Extract the first balanced <div>…</div> from the content HTML. For self posts and
 * image+text posts this is the `<div class="md">` body; for subreddit results it is the
 * description div. Depth-counting handles nested <div>s inside the body (spoilers, tables).
 */
function extractBodyHtml(html: string): string | null {
    const tagRe = /<(\/?)div\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    let start = -1;
    let depth = 0;
    while ((m = tagRe.exec(html)) !== null) {
        const closing = m[1] === '/';
        if (start === -1) {
            if (closing) continue; // stray </div> before any open — ignore
            start = m.index;
            depth = 1;
            continue;
        }
        depth += closing ? -1 : 1;
        if (depth === 0) return html.slice(start, m.index + m[0].length);
    }
    return start === -1 ? null : html.slice(start); // unbalanced -> take to end
}

function firstHref(html: string, re: RegExp): string | null {
    const m = re.exec(html);
    return m ? decodeEntities(m[1]) : null;
}

// Anchor whose visible text is "[link]" / "[comments]"; first <img src>.
const LINK_RE = /<a\b[^>]*\bhref="([^"]*)"[^>]*>\s*\[link\]\s*<\/a>/i;
const COMMENTS_RE = /<a\b[^>]*\bhref="([^"]*)"[^>]*>\s*\[comments\]\s*<\/a>/i;
const IMG_RE = /<img\b[^>]*\bsrc="([^"]*)"/i;

interface ContentParts {
    bodyHtml: string | null;
    bodyText: string | null;
    externalUrl: string | null;
    commentsUrl: string | null;
    imageUrl: string | null;
}

function extractContent(contentHtml: string | null): ContentParts {
    if (!contentHtml) {
        return { bodyHtml: null, bodyText: null, externalUrl: null, commentsUrl: null, imageUrl: null };
    }
    const bodyHtml = extractBodyHtml(contentHtml);
    return {
        bodyHtml,
        bodyText: htmlToText(bodyHtml),
        externalUrl: firstHref(contentHtml, LINK_RE),
        commentsUrl: firstHref(contentHtml, COMMENTS_RE),
        imageUrl: firstHref(contentHtml, IMG_RE),
    };
}

// --- Normalization helpers ---------------------------------------------------

// Reddit "thing" type prefixes (the part before the underscore in an id/fullname).
const KIND_TO_TYPE: Record<string, string> = {
    t1: 'comment',
    t2: 'account',
    t3: 'post',
    t4: 'message',
    t5: 'subreddit',
    t6: 'award',
};

/** A node is either a bare string (text-only element) or an object with `#text`. */
function text(node: unknown): string | null {
    if (node == null) return null;
    if (typeof node === 'string') return node;
    if (typeof node === 'number' || typeof node === 'boolean') return String(node);
    if (typeof node === 'object' && '#text' in (node as Record<string, unknown>)) {
        const t = (node as Record<string, unknown>)['#text'];
        return t == null ? null : String(t);
    }
    return null;
}

function attr(node: unknown, name: string): string | null {
    if (node && typeof node === 'object') {
        const v = (node as Record<string, unknown>)[`@_${name}`];
        return v == null ? null : String(v);
    }
    return null;
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
}

// --- Typed, normalized output ------------------------------------------------

export interface FeedAuthor {
    name: string | null; // e.g. "/u/alejandrobrega"
    username: string | null; // e.g. "alejandrobrega"
    uri: string | null;
}

export interface FeedCategory {
    term: string | null; // e.g. "SaaS"
    label: string | null; // e.g. "r/SaaS"
}

export interface FeedEntry {
    id: string | null; // e.g. "t3_1u3xjbn"
    kind: string | null; // e.g. "t3"
    type: string | null; // e.g. "post" | "subreddit"
    title: string | null;
    link: string | null; // permalink (entry <link href>)
    published: string | null; // ISO date (absent on subreddit results)
    updated: string | null; // ISO date
    author: FeedAuthor | null; // absent on some subreddit results
    subreddit: FeedCategory | null; // from entry <category> (absent on subreddit results)
    thumbnail: string | null; // media:thumbnail url (feed-provided preview)
    // --- pulled out of the <content> HTML ---
    bodyHtml: string | null; // post body / subreddit description as HTML
    bodyText: string | null; // same, as clean plain text
    externalUrl: string | null; // [link] target (destination url; == permalink for self posts)
    commentsUrl: string | null; // [comments] target
    imageUrl: string | null; // inline <img src> from the content
    contentType: string | null; // e.g. "html"
    contentHtml: string | null; // full decoded HTML body — nothing trimmed away
}

export interface FeedMeta {
    title: string | null;
    id: string | null;
    updated: string | null;
    category: FeedCategory | null;
    links: { rel: string | null; href: string | null; type: string | null }[];
}

export interface RedditFeed {
    feed: FeedMeta;
    entryCount: number;
    entries: FeedEntry[];
}

function normalizeCategory(node: unknown): FeedCategory | null {
    if (!node) return null;
    return { term: attr(node, 'term'), label: attr(node, 'label') };
}

function normalizeEntry(e: any): FeedEntry {
    const id = text(e.id);
    const kind = id && id.includes('_') ? id.split('_')[0] : null;

    let author: FeedAuthor | null = null;
    if (e.author) {
        const name = text(e.author.name);
        author = {
            name,
            username: name ? name.replace(/^\/u\//, '') : null,
            uri: text(e.author.uri),
        };
    }

    const contentHtml = text(e.content);
    const parts = extractContent(contentHtml);

    return {
        id,
        kind,
        type: kind ? (KIND_TO_TYPE[kind] ?? 'unknown') : null,
        title: text(e.title),
        // entry link is a single <link href>; isArray forces it to an array, so take [0].
        link: attr(asArray(e.link)[0], 'href'),
        published: text(e.published),
        updated: text(e.updated),
        author,
        subreddit: normalizeCategory(e.category),
        thumbnail: attr(e['media:thumbnail'], 'url'),
        bodyHtml: parts.bodyHtml,
        bodyText: parts.bodyText,
        externalUrl: parts.externalUrl,
        commentsUrl: parts.commentsUrl,
        imageUrl: parts.imageUrl,
        contentType: attr(e.content, 'type'),
        contentHtml,
    };
}

/** Parse a Reddit Atom search feed into clean, named feed + entry objects. */
export function parseRedditFeed(xml: string): RedditFeed {
    const parsed = parseAtomXml(xml);
    const feed = parsed?.feed ?? {};

    const meta: FeedMeta = {
        title: text(feed.title),
        id: text(feed.id),
        updated: text(feed.updated),
        category: normalizeCategory(feed.category),
        links: asArray(feed.link).map((l) => ({
            rel: attr(l, 'rel'),
            href: attr(l, 'href'),
            type: attr(l, 'type'),
        })),
    };

    const entries = asArray(feed.entry).map(normalizeEntry);
    return { feed: meta, entryCount: entries.length, entries };
}

// --- CLI entry point ---------------------------------------------------------

function readStdin(): string {
    try {
        return readFileSync(0, 'utf8'); // fd 0 = stdin
    } catch {
        return '';
    }
}

function main(): void {
    const args = process.argv.slice(2);
    const raw = args.includes('--raw');
    const filePath = args.find((a) => !a.startsWith('--'));
    const xml = filePath ? readFileSync(filePath, 'utf8') : readStdin();

    if (!xml.trim()) {
        process.stderr.write(
            'Usage: tsx src/parseRedditFeed.ts <feed.xml> [--raw]\n' +
                '   or: cat feed.xml | tsx src/parseRedditFeed.ts [--raw]\n',
        );
        process.exit(1);
    }

    try {
        const out = raw ? parseAtomXml(xml) : parseRedditFeed(xml);
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(1);
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main();
}
