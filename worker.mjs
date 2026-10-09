const API_PATHS = new Set(['/api/position', '/api/latest_prediction', '/api/trades', '/api/data']);
const CHART_DEFAULTS = { symbol: 'BTCUSDT', interval: '5m', ma1: '7', ma2: '25', ma3: '99' };

function json(data, status = 200) {
    return Response.json(data, {
        status,
        headers: {
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...(status === 405 ? { Allow: 'GET' } : {})
        }
    });
}

// Authentication is enforced by the Worker's Cloudflare Access "All traffic" policy.
// Static files are served by Cloudflare's assets router before this handler.
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (!API_PATHS.has(url.pathname)) return json({ error: 'not_found' }, 404);
        if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

        const target = new URL(url.pathname, 'http://127.0.0.1:8004');
        const allowedParams = url.pathname === '/api/data' ? Object.keys(CHART_DEFAULTS) : [];
        for (const key of url.searchParams.keys()) {
            if (!allowedParams.includes(key) || url.searchParams.getAll(key).length !== 1) {
                return json({ error: 'invalid_query' }, 400);
            }
        }
        if (url.pathname === '/api/data') {
            const params = { ...CHART_DEFAULTS, ...Object.fromEntries(url.searchParams) };
            if (!['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].includes(params.symbol) ||
                !['1m', '5m', '15m', '1h', '4h', '1d'].includes(params.interval) ||
                ['ma1', 'ma2', 'ma3'].some(key => !/^\d{1,3}$/.test(params[key]) || Number(params[key]) < 1 || Number(params[key]) > 500)) {
                return json({ error: 'invalid_chart_parameters' }, 400);
            }
            target.search = new URLSearchParams(params).toString();
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            // Send only the fixed read-only request, never browser cookies or auth headers.
            const response = await env.POSITION_API.fetch(target.href, {
                method: 'GET',
                headers: { Accept: 'application/json' },
                redirect: 'manual',
                signal: controller.signal
            });
            if (!response.ok || response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
                await response.body?.cancel();
                return json({ error: 'upstream_response_error' }, 502);
            }
            return json(await response.json());
        } catch {
            return controller.signal.aborted
                ? json({ error: 'upstream_timeout' }, 504)
                : json({ error: 'upstream_unavailable' }, 502);
        } finally {
            clearTimeout(timeout);
        }
    }
};
