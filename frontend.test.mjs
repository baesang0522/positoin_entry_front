// Run with: node --test frontend.test.mjs (no packages required).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
const source = readFileSync(new URL('./public/script.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');

function setup() {
    const element = () => ({ style: {}, textContent: '', children: [], value: '', classList: { contains: () => false },
        addEventListener() {}, appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
    const els = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], element()]));
    for (const [id, value] of Object.entries({ 'symbol-select': 'BTCUSDT', 'interval-select': '1h' })) els[id].value = value;
    const chartSeries = { setData(data) { this.data = data; }, setMarkers(markers) { this.markers = markers; }, applyOptions() {}, createPriceLine() { return {}; }, removePriceLine() {} };
    const intervals = [];
    const document = { hidden: true, getElementById(id) { assert.ok(els[id], `Missing HTML element ${id}`); return els[id]; }, querySelectorAll: () => [], createElement: element, addEventListener() {} };
    const context = vm.createContext({ document, window: { matchMedia: () => ({ matches: true, addEventListener() {} }) },
        console: { log() {}, error() {} }, AbortSignal, setTimeout, setInterval: (fn, ms) => intervals.push([fn, ms]),
        ResizeObserver: class { observe() {} },
        LightweightCharts: { CrosshairMode: { Normal: 0 }, createChart: () => ({ addCandlestickSeries: () => chartSeries, addLineSeries: () => { throw new Error('Moving average series should not be created'); }, applyOptions() {} }) }
    });
    vm.runInContext(source, context);
    return { context, els, document, chartSeries, intervals };
}
const position = { status: 'active', last_updated: '2026-10-09T12:00:00', data: { symbol: 'BTC/USDT', side: 'LONG', size: 0.002, entry_price: 60000, mark_price: 61000, unrealized_pnl: 2, roi: 1.67, timestamp: null } };
const chart = (price = 100) => ({ candles: [{ time: 100, open: price, close: price, high: price + 1, low: price - 1 }] });

test('real fetch uses same-origin credentials and rejects login/error responses', async () => {
    const { context } = setup();
    context.fetch = async (path, options) => {
        assert.equal(path, '/api/position');
        assert.equal(options.credentials, 'same-origin');
        assert.equal(options.cache, 'no-store');
        assert.equal(options.redirect, 'error');
        return Response.json(position);
    };
    assert.deepEqual(await context.loadApiData('/api/position'), position);
    for (const value of [null, undefined, '', '  ', [], {}, false, Infinity]) assert.equal(context.numberOrNull(value), null);
    for (const status of [401, 403, 502]) {
        context.fetch = async () => new Response('', { status });
        await assert.rejects(context.loadApiData('/api/position'));
    }
    context.fetch = async () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } });
    await assert.rejects(context.loadApiData('/api/position'));
});

test('position failure clears active details and differs from no position or no data', async () => {
    const { context, els } = setup();
    context.fetch = async () => Response.json(position);
    await context.fetchPosition();
    assert.equal(els['pos-pnl'].textContent, '+2.00');
    assert.equal(els['pos-time'].textContent, '—');
    assert.match(els['position-status'].textContent, /2026-10-09/);
    context.fetch = async () => { throw new Error('offline'); };
    await context.fetchPosition();
    assert.equal(els['position-details'].style.display, 'none');
    assert.equal(els['no-position-msg'].textContent, '포지션 조회 실패');
    for (const [status, text] of [['no_position', '보유 포지션 없음'], ['no_data', '저장된 포지션 정보 없음']]) {
        context.fetch = async () => Response.json({ status });
        await context.fetchPosition();
        assert.equal(els['no-position-msg'].textContent, text);
    }
});

test('sparse predictions clear old probabilities, thresholds, latency and features', async () => {
    const { context, els } = setup();
    context.updateScheduledPredictionUI({ prediction: 'LONG', confidence: 0.7, latency_ms: 200, probabilities: { long: 0.7, short: 0.3 }, thresholds: { long: 0.6, short: 0.6 }, features: { rsi_14: 50 } });
    assert.equal(els['prob-val-long'].textContent, '70.0%');
    context.updateScheduledPredictionUI({ prediction: 'HOLD', confidence: 0 });
    for (const id of ['prob-val-long', 'prob-val-short', 'feat-rsi', 'feat-slope', 'feat-bear', 'feat-adx', 'sched-latency']) assert.equal(els[id].textContent, '—');
    assert.equal(els['prob-bar-long'].style.width, '0%');
    assert.equal(els['prob-threshold-text'].textContent, '모델 기준 정보 없음');
    context.fetch = async () => Response.json({ status: 'no_data' });
    await context.fetchScheduledPrediction();
    assert.equal(els['sched-result'].textContent, '—');
});

test('trade PnL accepts nested strings; server text is rendered as text, missing values are not zero', () => {
    const { context, els } = setup();
    context.updateTradeHistoryUI([{ side: '<img src=x>', amount: 0.00001, price: 60000, info: { realizedPnl: '-1.23' } }, { side: 'buy', realizedPnl: 0 }]);
    const rows = els['trade-history-body'].children;
    assert.equal(rows[0].children[1].textContent, '<IMG SRC=X>');
    assert.equal(rows[0].children[4].textContent, '-1.23');
    assert.equal(rows[1].children[4].textContent, '0.00');
    assert.equal(rows[1].children[2].textContent, '—');
});

test('stale chart requests cannot overwrite newer selection; empty chart shows failure', async () => {
    const { context, els } = setup();
    assert.ok(!html.includes('signal-panel'));
    assert.ok(!html.includes('ma1-input'));
    let resolveOld;
    context.fetch = () => new Promise(resolve => { resolveOld = resolve; });
    const old = context.fetchData();
    vm.runInContext("currentSymbol = 'ETHUSDT'", context);
    context.fetch = async () => Response.json(chart(200));
    await context.fetchData();
    resolveOld(Response.json(chart(100)));
    await old;
    assert.equal(els['last-price'].textContent, '200.00');
    context.fetch = async () => Response.json({ candles: [] });
    await context.fetchData();
    assert.match(els['connection-status'].textContent, /갱신 실패/);
    assert.equal(els['last-price'].textContent, '—');
});

test('refresh is every 30 seconds, stops while hidden and does not overlap', async () => {
    const { context, document, intervals } = setup();
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0][1], 30000);
    let calls = 0, release;
    context.fetch = async path => {
        calls++;
        if (path.startsWith('/api/data')) return new Promise(resolve => { release = () => resolve(Response.json(chart())); });
        return Response.json(path === '/api/position' ? position : path === '/api/trades' ? { status: 'success', data: [] } : { status: 'no_data' });
    };
    await context.refreshDashboard();
    assert.equal(calls, 0);
    document.hidden = false;
    const pending = context.refreshDashboard();
    await context.refreshDashboard();
    assert.equal(calls, 1);
    release();
    await pending;
    assert.equal(calls, 4);
});

test('zero raw PnL produces entry arrows in the containing hour or minute, with fills grouped', () => {
    const { context } = setup();
    const hour = Date.parse('2026-10-16T10:00:00Z') / 1000;
    const entry = { symbol: 'BTC/USDT:USDT', side: 'buy', timestamp: (hour + 37 * 60 + 12) * 1000, info: { realizedPnl: '0.00000000' } };
    const trades = [entry, { ...entry, timestamp: entry.timestamp + 100 },
        { ...entry, side: 'sell', timestamp: (hour + 3600) * 1000 },
        ...[1, -1, 0.000001, null, undefined, ''].map(pnl => ({ ...entry, info: { realizedPnl: pnl } })),
        { ...entry, symbol: 'ETH/USDT' }, { ...entry, timestamp: null },
        { ...entry, timestamp: (hour - 1) * 1000 }, { ...entry, timestamp: (hour + 7200) * 1000 }];
    const hourly = context.entryMarkers(trades, [{ time: hour }, { time: hour + 3600 }], 'BTCUSDT', '1h');
    assert.equal(hourly.length, 2);
    assert.equal(hourly[0].time, hour);
    assert.equal(hourly[0].shape, 'arrowUp');
    assert.equal(hourly[0].position, 'belowBar');
    assert.equal(hourly[1].time, hour + 3600);
    assert.equal(hourly[1].shape, 'arrowDown');
    assert.equal(hourly[1].position, 'aboveBar');
    const minute = hour + 37 * 60;
    const minuteMarkers = context.entryMarkers(trades, [{ time: minute }], 'BTCUSDT', '1m');
    assert.equal(minuteMarkers.length, 1);
    assert.equal(minuteMarkers[0].time, minute);
    assert.equal(context.entryMarkers([entry], [{ time: minute - 60 }, { time: minute + 60 }], 'BTCUSDT', '1m').length, 0);
});

test('arrows survive position refresh, clear on history failure, and follow chart interval and symbol changes', async () => {
    const { context, chartSeries } = setup();
    const hour = Date.parse('2026-10-16T10:00:00Z') / 1000;
    const candle = time => ({ time, open: 100, high: 101, low: 99, close: 100 });
    let failHistory = false;
    context.fetch = async path => {
        if (path.startsWith('/api/data')) return Response.json({ candles: [candle(path.includes('interval=1m') ? hour + 2220 : hour)] });
        if (path === '/api/trades') {
            if (failHistory) throw new Error('offline');
            return Response.json({ status: 'success', data: [{ symbol: 'BTC/USDT', side: 'buy', timestamp: (hour + 2232) * 1000, realizedPnl: 0 }] });
        }
        return Response.json(position);
    };
    await context.fetchData();
    await context.fetchTradeHistory();
    assert.equal(chartSeries.markers[0].time, hour);
    await context.fetchPosition();
    context.updatePositionDashboard({ status: 'no_position' });
    assert.equal(chartSeries.markers.length, 1);
    vm.runInContext("currentInterval = '1m'", context);
    await context.fetchData();
    assert.equal(chartSeries.markers[0].time, hour + 2220);
    vm.runInContext("currentSymbol = 'ETHUSDT'", context);
    await context.fetchData();
    assert.equal(chartSeries.markers.length, 0);
    vm.runInContext("currentSymbol = 'BTCUSDT'", context);
    await context.fetchData();
    assert.equal(chartSeries.markers.length, 1);
    failHistory = true;
    await context.fetchTradeHistory();
    assert.equal(chartSeries.markers.length, 0);
});
