// Run with: node --test worker.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import worker from './worker.mjs';

const request = (path, options) => new Request(`https://position-entry-front.example${path}`, options);

test('VPC configuration points at the supplied service and keeps assets separate', () => {
    const config = JSON.parse(readFileSync(new URL('./wrangler.jsonc', import.meta.url), 'utf8'));
    assert.equal(config.main, 'worker.mjs');
    assert.equal(config.assets.directory, './public');
    assert.deepEqual(config.assets.run_worker_first, ['/api/*']);
    assert.deepEqual(config.vpc_services, [{ binding: 'POSITION_API', service_id: '01a11f7e-ebc4-7311-bab1-31db6059d7db' }]);
});

test('four read endpoints return upstream JSON without forwarding browser credentials or upstream cookies', async () => {
    for (const path of ['/api/position', '/api/latest_prediction', '/api/trades', '/api/data']) {
        const payload = { status: 'no_data', data: null };
        const response = await worker.fetch(request(path, { headers: { Cookie: 'private', Authorization: 'private' } }), {
            POSITION_API: { async fetch(url, options) {
                const target = new URL(url);
                assert.equal(target.origin, 'http://127.0.0.1:8004');
                assert.equal(target.pathname, path);
                assert.equal(options.method, 'GET');
                assert.equal(options.redirect, 'manual');
                assert.deepEqual(options.headers, { Accept: 'application/json' });
                assert.ok(options.signal instanceof AbortSignal);
                return Response.json(payload, { headers: { 'Set-Cookie': 'private', 'Access-Control-Allow-Origin': '*' } });
            } }
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), payload);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.equal(response.headers.get('Set-Cookie'), null);
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    }
});

test('chart controls reach EC2 with bounded periods and server defaults', async () => {
    let query;
    const env = { POSITION_API: { async fetch(url) { query = new URL(url).searchParams; return Response.json({ candles: [] }); } } };
    await worker.fetch(request('/api/data?symbol=ETHUSDT&interval=1h&ma1=1&ma2=25&ma3=500'), env);
    assert.deepEqual(Object.fromEntries(query), { symbol: 'ETHUSDT', interval: '1h', ma1: '1', ma2: '25', ma3: '500' });
    await worker.fetch(request('/api/data'), env);
    assert.deepEqual(Object.fromEntries(query), { symbol: 'BTCUSDT', interval: '5m', ma1: '7', ma2: '25', ma3: '99' });
});

test('invalid paths, methods and queries never reach EC2', async () => {
    let calls = 0;
    const env = { POSITION_API: { async fetch() { calls++; return Response.json({}); } } };
    for (const path of ['/api/orders', '/api/position/extra', '/api/position%2fextra', '/.env', '/src/web_server.py']) {
        assert.equal((await worker.fetch(request(path), env)).status, 404);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
        const response = await worker.fetch(request('/api/position', { method }), env);
        assert.equal(response.status, 405);
        assert.equal(response.headers.get('Allow'), 'GET');
    }
    for (const path of ['/api/position?foo=1', '/api/data?url=http://other', '/api/data?ma1=0', '/api/data?ma1=501', '/api/data?ma1=1.5', '/api/data?ma1=', '/api/data?ma1=7&ma1=9', '/api/data?symbol=UNKNOWN', '/api/data?interval=1s']) {
        assert.equal((await worker.fetch(request(path), env)).status, 400);
    }
    assert.equal(calls, 0);
});

test('network failures, redirects, HTML and malformed JSON return safe uncached errors', async () => {
    for (const fetch of [
        async () => { throw new Error('internal secret'); },
        async () => new Response('internal secret', { status: 500 }),
        async () => new Response(null, { status: 302, headers: { Location: 'http://other' } }),
        async () => new Response('<html>internal secret</html>', { headers: { 'Content-Type': 'text/html' } }),
        async () => new Response('invalid JSON', { headers: { 'Content-Type': 'application/json' } })
    ]) {
        const response = await worker.fetch(request('/api/position'), { POSITION_API: { fetch } });
        assert.equal(response.status, 502);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.ok((await response.json()).error.startsWith('upstream_'));
    }
});

test('a hung upstream request aborts after 15 seconds', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal;
    const pending = worker.fetch(request('/api/position'), { POSITION_API: {
        fetch(_url, options) {
            signal = options.signal;
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        }
    } });
    t.mock.timers.tick(14999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    const response = await pending;
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: 'upstream_timeout' });
});
