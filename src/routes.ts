import { createPlaywrightRouter } from '@crawlee/playwright';
import { Actor, log } from 'apify';

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ page, request, response, pushData }) => {
    const { query, jsonUrl } = request.userData as { query: string; warmupUrl: string; jsonUrl: string };

    // --- Stage 1: warm-up ---
    // The start URL is the Reddit app page; Crawlee already navigated to it, so `response` is that
    // warm-up page's navigation response. Its JS mints token_v2 asynchronously after load.
    const warmupStatus = response?.status() ?? null;
    log.info(`Warm-up page loaded (${request.url}) status ${warmupStatus}; waiting for token_v2 to mint...`);

    // Let the app JS run (it mints token_v2 asynchronously).
    try {
        await page.waitForLoadState('networkidle', { timeout: 15_000 });
    } catch {
        // networkidle can time out on a busy page — proceed; the cookie poll below is the real wait.
    }

    // Poll for the token_v2 cookie, which the app mints asynchronously after load.
    let tokenMinted = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const cookies = await page.context().cookies();
        if (cookies.some((c) => c.name === 'token_v2')) {
            tokenMinted = true;
            break;
        }
        await page.waitForTimeout(500);
    }
    log.info(`token_v2 minted during warm-up: ${tokenMinted}`);

    // --- Stage 2: fetch the JSON in the SAME context (token cookie auto-attaches) ---
    const jsonResp = await page.goto(jsonUrl, { waitUntil: 'domcontentloaded' });
    const initialStatus = jsonResp?.status() ?? null;
    const rawJson = (await jsonResp?.text()) ?? '';

    // Best-effort egress IP (ipify returns Access-Control-Allow-Origin: *, so an in-page fetch is fine).
    let egressIp: string | null = null;
    try {
        const ipText = await page.evaluate(async () => {
            const r = await fetch('https://api.ipify.org?format=json');
            return r.text();
        });
        egressIp = JSON.parse(ipText).ip;
    } catch (err) {
        log.warning(`Could not fetch egress IP: ${(err as Error).message}`);
    }

    // Try to parse the body as Reddit listing JSON. postCount > 0 == the route is validated.
    let postCount: number | null = null;
    try {
        const parsed = JSON.parse(rawJson);
        postCount = Array.isArray(parsed?.data?.children) ? parsed.data.children.length : null;
    } catch {
        // Non-JSON body (e.g. a 403 block page) — leave postCount null.
    }

    // Capture the cookies the browser context holds — these are what grant access to the endpoint.
    // They are the actor's own anonymous, logged-out session cookies minted during warm-up (e.g.
    // token_v2, loid, edgebucket, csv, session_tracker) — NOT a personal account — and they expire.
    const cookies = (await page.context().cookies()).map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        // expires is a UNIX timestamp in seconds (or -1 for a session cookie).
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
    }));

    const diagnostics = {
        query,
        jsonUrl,
        fetchedAt: new Date().toISOString(),
        warmupStatus,
        tokenMinted,
        initialStatus,
        egressIp,
        bodyLength: rawJson.length,
        postCount,
        // Quick-scan list of names, plus the full cookie objects (name/value/domain/expiry).
        cookieNames: cookies.map((c) => c.name),
        cookies,
    };

    log.info('Reddit JSON warm-up probe diagnostics', diagnostics);

    // Persist the probe evidence so it is reviewable in the Console after the run.
    await Actor.setValue('HEADLESS_PROBE_LOG', diagnostics);

    // Store the full JSON body as-is (the raw JSON when it works, the block page when it doesn't).
    await pushData({
        query,
        jsonUrl,
        fetchedAt: diagnostics.fetchedAt,
        warmupStatus,
        initialStatus,
        rawJson,
    });
});
