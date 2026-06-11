import { createCheerioRouter } from '@crawlee/cheerio';
import { Actor, log } from 'apify';

export const router = createCheerioRouter();

router.addDefaultHandler(async ({ request, response, body, sendRequest, pushData }) => {
    const headers = response?.headers ?? {};

    // Reddit's per-IP rate-limit counter. If the proxy rotates the IP, a fresh request shows
    // used=1 / remaining=99; if the IP is reused, `used` climbs and `remaining` drops.
    const rateLimit = {
        used: headers['x-ratelimit-used'],
        remaining: headers['x-ratelimit-remaining'],
        reset: headers['x-ratelimit-reset'],
    };

    // Best-effort egress IP. This is a separate connection, so under per-request rotation it
    // may differ from the exact IP Reddit saw — the rate-limit headers above are the rigorous proof.
    let egressIp: string | null = null;
    try {
        const ipResponse = await sendRequest({ url: 'https://api.ipify.org?format=json' });
        egressIp = JSON.parse(String(ipResponse.body)).ip;
    } catch (err) {
        log.warning(`Could not fetch egress IP: ${(err as Error).message}`);
    }

    const diagnostics = {
        query: request.userData.query as string,
        url: request.loadedUrl ?? request.url,
        fetchedAt: new Date().toISOString(),
        statusCode: response?.statusCode ?? null,
        egressIp,
        rateLimit,
        serverTiming: headers['server-timing'] ?? null,
        date: headers.date ?? null,
    };

    log.info('Reddit RSS fetch diagnostics', diagnostics);

    // Persist the rate-limit / IP evidence so it is reviewable in the Console after the run.
    await Actor.setValue('RATE_LIMIT_LOG', diagnostics);

    // Store the whole RSS feed as-is (no Atom parsing).
    await pushData({
        query: diagnostics.query,
        url: diagnostics.url,
        fetchedAt: diagnostics.fetchedAt,
        statusCode: diagnostics.statusCode,
        rawRss: body.toString(),
    });
});
