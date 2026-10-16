// Run with: node --experimental-vm-modules --test frontend.test.mjs (no packages required).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');

async function setup() {
    const element = () => ({ style: {}, textContent: '', children: [], value: '', listeners: {}, classList: { contains: () => false },
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }, appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
    const els = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], element()]));
    for (const [id, value] of Object.entries({ 'symbol-select': 'BTCUSDT', 'interval-select': '1h' })) els[id].value = value;
    const chartSeries = { lines: new Set(), setData(data) { this.data = data; }, setMarkers(markers) { this.markers = markers; }, applyOptions() {},
        createPriceLine(options) { this.lines.add(options); return options; }, removePriceLine(line) { this.lines.delete(line); } };
    const timeScale = {
        range: null,
        getVisibleLogicalRange() { return this.range; },
        setVisibleLogicalRange(range) { this.range = range; this.onChange?.(range); },
        subscribeVisibleLogicalRangeChange(fn) { this.onChange = fn; },
        resetTimeScale() { this.setVisibleLogicalRange({ from: Math.max(0, chartSeries.data.length - 100), to: chartSeries.data.length - 1 }); }
    };
    const timeouts = [];
    const intervals = [];
    const document = { hidden: true, getElementById(id) { assert.ok(els[id], `Missing HTML element ${id}`); return els[id]; }, querySelectorAll: () => [], createElement: element, addEventListener() {} };
    const context = vm.createContext({ document, window: { matchMedia: () => ({ matches: true, addEventListener() {} }) },
        console: { log() {}, error() {} }, AbortSignal, URLSearchParams, setTimeout: (fn, ms) => timeouts.push([fn, ms]), setInterval: (fn, ms) => intervals.push([fn, ms]),
        ResizeObserver: class { observe() {} },
        LightweightCharts: { CrosshairMode: { Normal: 0 }, createChart: () => ({ addCandlestickSeries: () => chartSeries, addLineSeries: () => { throw new Error('Moving average series should not be created'); }, applyOptions() {}, timeScale: () => timeScale }) }
    });
    const modules = new Map();
    function getModule(url) {
        if (!modules.has(url.href)) {
            modules.set(url.href, new vm.SourceTextModule(readFileSync(url, 'utf8'), { context, identifier: url.href }));
        }
        return modules.get(url.href);
    }
    const entry = getModule(new URL('./public/main.js', import.meta.url));
    await entry.link((specifier, parent) => getModule(new URL(specifier, parent.identifier)));
    await entry.evaluate();
    // Keep exports out of the VM global scope so missing imports cannot pass accidentally.
    const exports = Object.assign({}, ...[...modules.values()].map(module => module.namespace));
    Object.defineProperty(exports, 'fetch', { get: () => context.fetch, set: value => { context.fetch = value; } });
    return { context: exports, els, document, chartSeries, timeScale, timeouts, intervals, globals: context };
}
const position = { status: 'active', last_updated: '2026-10-09T12:00:00', data: { symbol: 'BTC/USDT', side: 'LONG', size: 0.002, entry_price: 60000, mark_price: 61000, unrealized_pnl: 2, roi: 1.67, timestamp: null } };
const chart = (price = 100) => [[100000, String(price), String(price + 1), String(price - 1), String(price)]];

test('module entry loads once and keeps functions and chart state out of global scope', async () => {
    assert.match(html, /<script type="module" src="main\.js"><\/script>/);
    assert.ok(!html.includes('script.js'));
    const { globals, els, intervals } = await setup();
    for (const name of ['fetchData', 'loadApiData', 'refreshDashboard', 'candlestickSeries', 'recentTrades']) assert.equal(globals[name], undefined);
    for (const id of ['symbol-select', 'interval-select']) assert.equal(els[id].listeners.change.length, 1);
    assert.equal(els['refresh-history-btn'].listeners.click.length, 1);
    assert.equal(intervals.length, 1);
});

test('position panel updates the chart line through its module API and clears mismatched symbols', async () => {
    const { context, els, chartSeries } = await setup();
    context.updatePositionDashboard(position);
    assert.equal(chartSeries.lines.size, 1);
    assert.equal([...chartSeries.lines][0].price, 60000);
    context.updatePositionDashboard(position);
    assert.equal(chartSeries.lines.size, 1);
    els['symbol-select'].value = 'ETHUSDT';
    context.fetch = async () => Response.json(chart());
    await context.fetchData();
    context.updatePositionDashboard(position);
    assert.equal(chartSeries.lines.size, 0);
    els['symbol-select'].value = 'BTCUSDT';
    await context.fetchData();
    context.updatePositionDashboard(position);
    assert.equal(chartSeries.lines.size, 1);
    context.updatePositionDashboard(null);
    assert.equal(chartSeries.lines.size, 0);
});

test('chart fetch goes directly to Binance Futures without credentials and converts candle timestamps/prices', async () => {
    const { context } = await setup();
    let calls = 0;
    context.fetch = async (url, options) => {
        calls++;
        const target = new URL(url);
        assert.equal(target.origin, 'https://fapi.binance.com');
        assert.equal(target.pathname, '/fapi/v1/klines');
        assert.equal(target.searchParams.get('symbol'), 'BTCUSDT');
        assert.equal(target.searchParams.get('interval'), '1m');
        assert.equal(target.searchParams.get('limit'), '500');
        assert.equal(options.credentials, 'omit');
        assert.equal(options.headers, undefined);
        assert.equal(options.redirect, 'error');
        return Response.json(chart());
    };
    const data = await context.loadBinanceCandles('BTCUSDT', '1m');
    assert.equal(data.candles[0].time, 100);
    assert.equal(data.candles[0].open, 100);
    assert.equal(data.candles[0].high, 101);
    await assert.rejects(context.loadBinanceCandles('UNKNOWN', '1m'));
    await assert.rejects(context.loadBinanceCandles('BTCUSDT', 'bad'));
    assert.equal(calls, 1);
    for (const status of [403, 429, 500]) {
        context.fetch = async () => new Response('', { status });
        await assert.rejects(context.loadBinanceCandles('BTCUSDT', '1m'), new RegExp(`HTTP ${status}`));
    }
    for (const invalid of [[], {}, [null], [[100000, '', '101', '99', '100']], [[100000, '100', '98', '99', '100']]]) {
        context.fetch = async () => Response.json(invalid);
        await assert.rejects(context.loadBinanceCandles('BTCUSDT', '1m'));
    }
});

test('real fetch uses same-origin credentials and rejects login/error responses', async () => {
    const { context } = await setup();
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
    const { context, els } = await setup();
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
    const { context, els } = await setup();
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

test('trade PnL accepts nested strings; server text is rendered as text, missing values are not zero', async () => {
    const { context, els } = await setup();
    context.updateTradeHistoryUI([{ side: '<img src=x>', amount: 0.00001, price: 60000, info: { realizedPnl: '-1.23' } }, { side: 'buy', realizedPnl: 0 }]);
    const rows = els['trade-history-body'].children;
    assert.equal(rows[0].children[1].textContent, '<IMG SRC=X>');
    assert.equal(rows[0].children[4].textContent, '-1.23');
    assert.equal(rows[1].children[4].textContent, '0.00');
    assert.equal(rows[1].children[2].textContent, '—');
});

test('stale chart requests cannot overwrite newer selection; empty chart shows failure', async () => {
    const { context, els } = await setup();
    assert.ok(!html.includes('signal-panel'));
    assert.ok(!html.includes('ma1-input'));
    let resolveOld;
    context.fetch = () => new Promise(resolve => { resolveOld = resolve; });
    const old = context.fetchData();
    els['symbol-select'].value = 'ETHUSDT';
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
    const { context, document, intervals } = await setup();
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0][1], 30000);
    let calls = 0, release;
    context.fetch = async path => {
        calls++;
        if (path.startsWith('https://fapi.binance.com/fapi/v1/klines?')) return new Promise(resolve => { release = () => resolve(Response.json(chart())); });
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

test('zero raw PnL produces entry arrows in the containing hour or minute, with fills grouped', async () => {
    const { context } = await setup();
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
    const { context, chartSeries, els } = await setup();
    const hour = Date.parse('2026-10-16T10:00:00Z') / 1000;
    const candle = time => [time * 1000, '100', '101', '99', '100'];
    let failHistory = false;
    context.fetch = async path => {
        if (path.startsWith('https://fapi.binance.com/fapi/v1/klines?')) return Response.json([candle(path.includes('interval=1m') ? hour + 2220 : hour)]);
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
    els['interval-select'].value = '1m';
    await context.fetchData();
    assert.equal(chartSeries.markers[0].time, hour + 2220);
    els['symbol-select'].value = 'ETHUSDT';
    await context.fetchData();
    assert.equal(chartSeries.markers.length, 0);
    els['symbol-select'].value = 'BTCUSDT';
    await context.fetchData();
    assert.equal(chartSeries.markers.length, 1);
    failHistory = true;
    await context.fetchTradeHistory();
    assert.equal(chartSeries.markers.length, 0);
});

const candleTime = index => Date.parse('2026-10-01T00:00:00Z') / 1000 + index * 60;
const candleRows = (start, count, price = 100) => Array.from({ length: count }, (_, i) =>
    [candleTime(start + i) * 1000, String(price), String(price + 1), String(price - 1), String(price)]);
const settle = () => new Promise(resolve => setImmediate(resolve));

test('history API uses a millisecond end cursor, accepts an exhausted page, and rejects malformed ordering', async () => {
    const { context } = await setup();
    let calls = 0;
    context.fetch = async url => {
        calls++;
        assert.equal(new URL(url).searchParams.get('endTime'), '99999');
        return Response.json([]);
    };
    assert.equal((await context.loadBinanceCandles('BTCUSDT', '1m', 99999)).candles.length, 0);
    for (const invalid of [-1, NaN, Infinity, null, '99999', 1.5]) {
        await assert.rejects(context.loadBinanceCandles('BTCUSDT', '1m', invalid));
    }
    assert.equal(calls, 1);
    for (const rows of [[...chart(), ...chart()], [...candleRows(2, 1), ...candleRows(1, 1)], [[1, '', 1, 1, 1]]]) {
        context.fetch = async () => Response.json(rows);
        await assert.rejects(context.loadBinanceCandles('BTCUSDT', '1m', 99999));
    }
});

test('left-edge scrolling prepends one page, keeps the current viewport, and draws older DB trade markers', async () => {
    const { context, els, chartSeries, timeScale } = await setup();
    els['interval-select'].value = '1m';
    let release, historyCalls = 0;
    context.fetch = async url => {
        const end = new URL(url).searchParams.get('endTime');
        if (end) {
            historyCalls++;
            assert.equal(Number(end), candleTime(1000) * 1000 - 1);
            return new Promise(resolve => { release = () => resolve(Response.json(candleRows(500, 501))); });
        }
        return Response.json(candleRows(1000, 500));
    };
    await context.fetchData();
    context.setTradeMarkers([{symbol:'BTC/USDT',side:'buy',timestamp:(candleTime(900)+12)*1000,realizedPnl:0}]);
    assert.equal(chartSeries.markers.length, 0);
    timeScale.setVisibleLogicalRange({from:100,to:200});
    assert.equal(historyCalls, 0);
    timeScale.setVisibleLogicalRange({from:10.25,to:80.25});
    timeScale.setVisibleLogicalRange({from:20.25,to:90.25});
    await context.loadOlderCandles();
    assert.equal(historyCalls, 1);
    release();
    await settle();
    assert.equal(chartSeries.data.length, 1000);
    assert.equal(new Set(chartSeries.data.map(c => c.time)).size, 1000);
    assert.equal(timeScale.range.from, 520.25);
    assert.equal(timeScale.range.to, 590.25);
    assert.equal(chartSeries.markers[0].time, candleTime(900));
    assert.equal(chartSeries.markers[0].shape, 'arrowUp');
    // The history can also arrive after its candles (e.g. a DB refresh).
    context.setTradeMarkers([{symbol:'BTC/USDT',side:'sell',timestamp:(candleTime(800)+12)*1000,realizedPnl:0}]);
    assert.equal(chartSeries.markers[0].time, candleTime(800));
    assert.equal(chartSeries.markers[0].shape, 'arrowDown');
});

test('latest refresh and history can finish in either order without dropping history or jumping to the latest candles', async () => {
    for (const historyFirst of [false, true]) {
        const { context, chartSeries, timeScale } = await setup();
        context.fetch = async () => Response.json(candleRows(1000, 500));
        await context.fetchData();
        timeScale.range = {from:20,to:100};
        let releaseHistory, releaseLatest;
        context.fetch = async url => new Promise(resolve => {
            if (new URL(url).searchParams.has('endTime')) releaseHistory = () => resolve(Response.json(candleRows(500, 500)));
            else releaseLatest = () => resolve(Response.json(candleRows(1001, 500, 200)));
        });
        const older = context.loadOlderCandles();
        const latest = context.fetchData();
        if (historyFirst) { releaseHistory(); await older; releaseLatest(); await latest; }
        else { releaseLatest(); await latest; releaseHistory(); await older; }
        assert.equal(chartSeries.data.length, 1001);
        assert.equal(chartSeries.data[0].time, candleTime(500));
        assert.equal(chartSeries.data.at(-1).close, 200);
        assert.equal(timeScale.range.from, 520);
        assert.equal(timeScale.range.to, 600);
    }
});

test('history errors retain candles and can retry, while an empty or non-progressing page stops requests', async () => {
    for (const ending of [[], candleRows(1000, 1)]) {
        const { context, chartSeries, els } = await setup();
        context.fetch = async () => Response.json(candleRows(1000, 500));
        await context.fetchData();
        context.fetch = async () => new Response('', {status:429});
        await context.loadOlderCandles();
        assert.match(els['connection-status'].textContent, /과거 차트 조회 실패/);
        assert.equal(chartSeries.data.length, 500);
        assert.equal(els['last-price'].textContent, '100.00');
        let calls = 0;
        context.fetch = async () => { calls++; return Response.json(ending); };
        await context.loadOlderCandles();
        await context.loadOlderCandles();
        assert.equal(calls, 1);
        assert.match(els['connection-status'].textContent, /더 이전/);
        // Exhaustion belongs to this symbol/interval only.
        els['interval-select'].value = '1m';
        context.fetch = async () => Response.json(candleRows(1000, 500));
        await context.fetchData();
        context.fetch = async () => Response.json(candleRows(500, 500));
        await context.loadOlderCandles();
        assert.equal(chartSeries.data.length, 1000);
    }
});

test('old history results and failures cannot affect a new symbol or release its request lock', async () => {
    for (const failOld of [false, true]) {
        const { context, chartSeries, els } = await setup();
        context.fetch = async () => Response.json(candleRows(1000, 500));
        await context.fetchData();
        let finishOld;
        context.fetch = async () => new Promise((resolve, reject) => {
            finishOld = () => failOld ? reject(new Error('old request')) : resolve(Response.json(candleRows(500, 500)));
        });
        const old = context.loadOlderCandles();
        els['symbol-select'].value = 'ETHUSDT';
        context.fetch = async () => Response.json(candleRows(2000, 500, 200));
        await context.fetchData();
        let finishNew, calls = 0;
        context.fetch = async () => { calls++; return new Promise(resolve => { finishNew = () => resolve(Response.json(candleRows(1500, 500, 200))); }); };
        const fresh = context.loadOlderCandles();
        finishOld();
        await old;
        assert.equal(chartSeries.data.length, 500);
        assert.equal(chartSeries.data[0].time, candleTime(2000));
        assert.ok(!els['connection-status'].textContent.includes('old request'));
        await context.loadOlderCandles();
        assert.equal(calls, 1);
        finishNew();
        await fresh;
        assert.equal(chartSeries.data.length, 1000);
        assert.ok(chartSeries.data.every(c => c.close === 200));
    }
});

test('a wide pan requests consecutive pages until the visible left edge is filled', async () => {
    const { context, chartSeries, timeScale, timeouts } = await setup();
    context.fetch = async () => Response.json(candleRows(1000, 500));
    await context.fetchData();
    let calls = 0;
    context.fetch = async url => {
        calls++;
        const end = Number(new URL(url).searchParams.get('endTime'));
        return Response.json(candleRows(end === candleTime(1000)*1000-1 ? 500 : 0, 500));
    };
    timeScale.setVisibleLogicalRange({from:-600,to:100});
    await settle();
    assert.equal(chartSeries.data.length, 1000);
    assert.equal(timeScale.range.from, -100);
    timeouts.shift()[0]();
    await settle();
    assert.equal(chartSeries.data.length, 1500);
    assert.equal(timeScale.range.from, 400);
    timeouts.shift()[0]();
    await settle();
    assert.equal(calls, 2);
});
