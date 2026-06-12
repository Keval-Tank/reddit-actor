import { createPlaywrightRouter } from '@crawlee/playwright';
import { Actor, log } from 'apify';

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ page, request, response, pushData }) => {
    // Status of the very first navigation. A working request may surface here as a 403 challenge
    // that the page's JS instantly resolves — so this is diagnostic only, not the success signal.
    const initialStatus = response?.status() ?? null;

    // Let any inline token handshake / JS settle, then read the FINAL rendered body.
    try {
        await page.waitForLoadState('networkidle', { timeout: 15_000 });
    } catch {
        // networkidle can time out on a busy/streaming page — proceed with whatever rendered.
    }

    // When Chromium renders a JSON document it shows the raw text in <body>, so innerText is the body.
    const finalBody = await page.evaluate(() => document.body.innerText);

    // Did the edge mint the logged-out session token during this single navigation?
    const tokenMinted = (await page.context().cookies()).some((c) => c.name === 'token_v2');

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
        const parsed = JSON.parse(finalBody);
        postCount = Array.isArray(parsed?.data?.children) ? parsed.data.children.length : null;
    } catch {
        // Non-JSON body (e.g. a 403 block page) — leave postCount null.
    }

    const diagnostics = {
        query: request.userData.query as string,
        jsonUrl: request.userData.jsonUrl as string,
        fetchedAt: new Date().toISOString(),
        initialStatus,
        tokenMinted,
        egressIp,
        bodyLength: finalBody.length,
        postCount,
    };

    log.info('Reddit JSON headless probe diagnostics', diagnostics);

    // Persist the probe evidence so it is reviewable in the Console after the run.
    await Actor.setValue('HEADLESS_PROBE_LOG', diagnostics);

    // Store the full final body as-is (the raw JSON when it works, the block page when it doesn't).
    await pushData({
        query: diagnostics.query,
        jsonUrl: diagnostics.jsonUrl,
        fetchedAt: diagnostics.fetchedAt,
        initialStatus: diagnostics.initialStatus,
        rawJson: finalBody,
    });
});
