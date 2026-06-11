// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler } from '@crawlee/cheerio';
// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';

// this is ESM project, and as such, it requires you to specify extensions in your relative imports
// note that we need to use `.js` even when inside TS files
import { router } from './routes.js';

interface Input {
    query: string;
}

// Reddit blocks default library User-Agents, so we send an honest, descriptive one.
const USER_AGENT = 'reddit-search-scraper/1.0';

// The init() call wires the Actor into the Apify-provided environment (storage, etc.).
await Actor.init();

// Input: only `query` is editable. Everything else about the request is fixed below.
const { query = 'saas developer' } = (await Actor.getInput<Input>()) ?? ({} as Input);

if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('Input "query" is required and must be a non-empty string.');
}

// Fixed endpoint — nothing added on top of this.
const searchUrl = `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=new&type=link`;
log.info(`Reddit RSS search URL: ${searchUrl}`);

// Apify datacenter proxy. Combined with `useSessionPool: false` below, the proxy hands out a
// fresh, rotating IP per request. On a free account without proxy access this resolves to
// `undefined` and the request goes out directly from the container's own IP — which the
// RATE_LIMIT_LOG output will reveal (the rate-limit counter will not reset).
const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['DATACENTER'],
    checkAccess: true,
});

const crawler = new CheerioCrawler({
    proxyConfiguration,
    // Disable the session pool so the proxy is not pinned to a single sticky IP.
    useSessionPool: false,
    maxRequestsPerCrawl: 1,
    // CheerioCrawler refuses non-HTML content types by default; Reddit RSS is application/atom+xml.
    additionalMimeTypes: ['application/atom+xml', 'application/rss+xml', 'application/xml', 'text/xml'],
    // Set our descriptive User-Agent right before the request is sent.
    preNavigationHooks: [
        async (_crawlingContext, gotOptions) => {
            gotOptions.headers = {
                ...gotOptions.headers,
                'User-Agent': USER_AGENT,
            };
        },
    ],
    requestHandler: router,
});

await crawler.run([{ url: searchUrl, userData: { query } }]);

// Gracefully exit the Actor process.
await Actor.exit();
