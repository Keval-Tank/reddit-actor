// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
// --- RSS approach (kept for reference, disabled) ---
// import { CheerioCrawler } from '@crawlee/cheerio';
import { PlaywrightCrawler } from '@crawlee/playwright';
// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';

// this is ESM project, and as such, it requires you to specify extensions in your relative imports
// note that we need to use `.js` even when inside TS files
import { router } from './routes.js';

interface Input {
    query: string;
}

// --- RSS approach (kept for reference, disabled) ---
// Reddit blocks default library User-Agents, so we send an honest, descriptive one.
// const USER_AGENT = 'reddit-search-scraper/1.0';

// The init() call wires the Actor into the Apify-provided environment (storage, etc.).
await Actor.init();

// Input: only `query` is editable. Everything else about the request is fixed below.
const { query = 'saas developer' } = (await Actor.getInput<Input>()) ?? ({} as Input);

if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('Input "query" is required and must be a non-empty string.');
}

// --- RSS approach (kept for reference, disabled) ---
// Fixed endpoint — nothing added on top of this.
// const searchUrl = `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=new&type=link`;
// log.info(`Reddit RSS search URL: ${searchUrl}`);

// Warm-up page — a real Reddit app page whose JS mints the token_v2 session cookie.
// We load this FIRST so the browser context holds the token before we hit the JSON endpoint.
const warmupUrl = 'https://www.reddit.com/';
// JSON data endpoint — fetched as a second navigation inside the handler, after warm-up.
const jsonUrl = `https://old.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&type=link`;
log.info(`Warm-up URL: ${warmupUrl}`);
log.info(`Reddit JSON search URL: ${jsonUrl}`);

// Apify proxy. Each run is a fresh process, so it gets a fresh session and therefore a fresh
// exit IP from the proxy pool — that's what rotates IPs across runs. On a free account without
// proxy access this resolves to `undefined` and the request goes out directly from the
// container's own IP — which the RATE_LIMIT_LOG output will reveal (the rate-limit counter
// will not reset across runs).
const proxyConfiguration = await Actor.createProxyConfiguration({
    checkAccess: true,
    groups: ['RESIDENTIAL']
});

// --- RSS approach (kept for reference, disabled) ---
// const crawler = new CheerioCrawler({
//     proxyConfiguration,
//     // Keep the session pool ON: the run gets one sticky IP, so the in-handler ipify call and the
//     // Reddit request go out through the SAME IP — making the logged egress IP the real IP Reddit saw.
//     useSessionPool: true,
//     maxRequestsPerCrawl: 1,
//     // CheerioCrawler refuses non-HTML content types by default; Reddit RSS is application/atom+xml.
//     additionalMimeTypes: ['application/atom+xml', 'application/rss+xml', 'application/xml', 'text/xml'],
//     // Set our descriptive User-Agent right before the request is sent.
//     preNavigationHooks: [
//         async (_crawlingContext, gotOptions) => {
//             gotOptions.headers = {
//                 ...gotOptions.headers,
//                 'User-Agent': USER_AGENT,
//             };
//         },
//     ],
//     requestHandler: router,
// });
//
// await crawler.run([{ url: searchUrl, userData: { query } }]);

// Warm-up approach: PlaywrightCrawler navigates to a real Reddit app page first (warmupUrl) so
// its JS mints token_v2, THEN the handler fetches the JSON endpoint in the same context with the
// cookie attached. Headful-under-Xvfb (the image default) is kept — it's the strongest fingerprint
// and mirrors the residential-incognito conditions that worked.
const crawler = new PlaywrightCrawler({
    launchContext : {
        launchOptions : {
            headless : true,
            channel : 'chrome'
        }
    },
    proxyConfiguration,
    // One sticky IP for the run, so the logged egress IP is the IP Reddit actually saw.
    useSessionPool: true,
    maxRequestsPerCrawl: 1,
    maxConcurrency: 1,
    // A genuine single request: no retries.
    maxRequestRetries: 0,
    retryOnBlocked: false,
    // CRITICAL for this probe: by default the session pool treats 401/403/429 as "blocked" and
    // THROWS before our handler runs — which is why the first runs failed with no diagnostics.
    // Emptying blockedStatusCodes lets the handler execute on a 403 so we can read the actual
    // body, the egress IP, and whether token_v2 minted instead of flying blind.
    sessionPoolOptions: { blockedStatusCodes: [] },
    // Leave Crawlee's fingerprint injection ON (default) and use no custom User-Agent —
    // the real browser fingerprint is the whole point.
    requestHandler: router,
});

await crawler.run([{ url: warmupUrl, userData: { query, warmupUrl, jsonUrl } }]);

// Gracefully exit the Actor process.
await Actor.exit();
