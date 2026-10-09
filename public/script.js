// Standalone preview: synthetic values only; no backend or exchange requests.
const DEMO_TIME = Date.parse('2026-10-09T00:00:00Z') / 1000;

function createDemoChart(symbol, interval, periods) {
    const base = { BTCUSDT: 61000, ETHUSDT: 2400, SOLUSDT: 140, XRPUSDT: 0.55 }[symbol];
    const step = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }[interval];
    if (!base || !step || periods.length !== 3 || periods.some(p => !Number.isInteger(p) || p < 1 || p > 500)) {
        throw new Error('종목·간격과 이동평균 기간(1~500 정수)을 확인해줘.');
    }
    const price = i => base * (1 + (i - 499) / 50000 + 0.018 * (Math.sin(i / 13) - Math.sin(499 / 13)));
    const candles = Array.from({ length: 500 }, (_, i) => {
        const open = price(i - 1), close = price(i);
        return { time: DEMO_TIME - (499 - i) * step, open, close,
            high: Math.max(open, close) + base * 0.002,
            low: Math.min(open, close) - base * 0.002 };
    });
    const result = { candles, markers: [], lastSignal: null };
    periods.forEach((period, index) => {
        let sum = 0;
        const data = [];
        candles.forEach((candle, i) => {
            sum += candle.close;
            if (i >= period) sum -= candles[i - period].close;
            if (i >= period - 1) data.push({ time: candle.time, value: sum / period });
        });
        result[`ma${index + 1}`] = { period, data };
    });
    return result;
}

async function loadDemoData(path) {
    const url = new URL(path, 'https://demo.invalid');
    if (url.pathname === '/api/data') {
        const q = url.searchParams;
        return createDemoChart(q.get('symbol'), q.get('interval'), ['ma1', 'ma2', 'ma3'].map(key => Number(q.get(key))));
    }
    if (url.pathname === '/api/position') return { status: 'active', data: {
        symbol: 'BTC/USDT', side: 'LONG', size: 0.002, entry_price: 60000,
        mark_price: 61000, unrealized_pnl: 2, roi: 100 / 60,
        timestamp: String((DEMO_TIME - 3600) * 1000)
    } };
    if (url.pathname === '/api/latest_prediction') return { status: 'success', data: {
        time_str: '2026-10-09 09:00 KST · 샘플', prediction: 'WAITING', confidence: 0.62,
        latency_ms: 120, probabilities: { long: 0.62, short: 0.38 },
        features: { rsi_14: 54.2, slope_ma25: 0.0123, bear_power: -12.4, adx: 21.7 }
    } };
    if (url.pathname === '/api/trades') return { status: 'success', data: [
        { timestamp: (DEMO_TIME - 7200) * 1000, side: 'SELL', price: 60500, amount: 0.002, realizedPnl: 1 },
        { timestamp: (DEMO_TIME - 10800) * 1000, side: 'BUY', price: 60000, amount: 0.002, realizedPnl: 0 }
    ] };
    throw new Error('지원하지 않는 샘플 요청');
}

// Runnable check: open index.html?selftest and inspect the console.
function checkDemoData() {
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    for (const interval of ['1m', '5m', '15m', '1h', '4h', '1d']) {
        const data = createDemoChart('BTCUSDT', interval, [1, 25, 500]);
        check(data.candles.length === 500 && data.ma3.data.length === 1, 'Demo lengths');
        check(data.candles.every((c, i, a) => c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close) && (!i || c.time > a[i - 1].time)), 'Demo candles');
        check(Math.abs(data.ma3.data[0].value - data.candles.reduce((s, c) => s + c.close, 0) / 500) < 1e-8, 'Demo moving average');
    }
    for (const invalid of [0, 501, 1.5, NaN]) {
        let rejected = false;
        try { createDemoChart('BTCUSDT', '1h', [invalid, 25, 99]); } catch { rejected = true; }
        check(rejected, 'Invalid MA period accepted');
    }
    console.info('Demo data checks passed');
}
if (new URLSearchParams(location.search).has('selftest')) checkDemoData();

// DOM Elements
const chartContainer = document.getElementById('chart-container');
const symbolSelect = document.getElementById('symbol-select');
const intervalSelect = document.getElementById('interval-select');
const ma1Input = document.getElementById('ma1-input');
const ma2Input = document.getElementById('ma2-input');
const ma3Input = document.getElementById('ma3-input');
const connectionStatus = document.getElementById('connection-status');
const lastPriceEl = document.getElementById('last-price');
const signalText = document.getElementById('signal-text');

// State
let currentSymbol = symbolSelect.value;
let currentInterval = intervalSelect.value;
let currentMa1 = parseInt(ma1Input.value);
let currentMa2 = parseInt(ma2Input.value);
let currentMa3 = parseInt(ma3Input.value);
let chart;
let candlestickSeries;
let ma1Series;
let ma2Series;
let ma3Series;
let horizontalSplit;
let verticalSplit;

// Desktop split panels; mobile uses normal vertical scrolling.
const mobileLayout = window.matchMedia('(max-width: 760px)');
function initSplits() {
    horizontalSplit?.destroy();
    verticalSplit?.destroy();
    horizontalSplit = verticalSplit = null;
    if (mobileLayout.matches || typeof Split === 'undefined') return;
    // Horizontal split (chart | sidebar)
    horizontalSplit = Split(['#horizontal-split > .chart-panel', '#horizontal-split > .sidebar'], {
        sizes: [75, 25],
        minSize: [400, 300],
        gutterSize: 3,
        cursor: 'col-resize',
        onDragEnd: function () {
            // Resize chart when horizontal split is dragged
            if (chart && chartContainer) {
                setTimeout(() => {
                    chart.applyOptions({
                        width: chartContainer.clientWidth,
                        height: chartContainer.clientHeight
                    });
                    chart.timeScale().fitContent();
                }, 0);
            }
        }
    });

    // Vertical split in sidebar (orderbook | predictions)
    verticalSplit = Split(['#vertical-split > .orderbook-panel', '#vertical-split > .predictions-panel'], {
        direction: 'vertical',
        sizes: [50, 50],
        cursor: 'row-resize'
    });
}

// Fullscreen Toggle
function setupFullscreenButtons() {
    document.querySelectorAll('.btn-fullscreen').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const panelClass = e.target.dataset.panel;
            const panel = document.querySelector(`.${panelClass}`);

            if (document.body.classList.contains('panel-fullscreen')) {
                // Exit fullscreen
                document.body.classList.remove('panel-fullscreen');
                document.querySelectorAll('.fullscreen-active').forEach(p => p.classList.remove('fullscreen-active'));
                e.target.textContent = '⛶';

                // Resize chart
                setTimeout(() => {
                    if (chart) {
                        chart.applyOptions({
                            width: chartContainer.clientWidth,
                            height: chartContainer.clientHeight
                        });
                    }
                }, 100);
            } else {
                // Enter fullscreen
                document.body.classList.add('panel-fullscreen');
                panel.classList.add('fullscreen-active');
                e.target.textContent = '⛝';

                // Resize chart
                setTimeout(() => {
                    if (chart) {
                        chart.applyOptions({
                            width: chartContainer.clientWidth,
                            height: chartContainer.clientHeight
                        });
                    }
                }, 100);
            }
        });
    });
}

function initChart() {
    console.log('initChart called');
    console.log('LightweightCharts:', typeof LightweightCharts);

    if (typeof LightweightCharts === 'undefined') {
        console.error('LightweightCharts library not loaded!');
        connectionStatus.textContent = 'Error: Lib not loaded';
        connectionStatus.style.color = 'red';
        return;
    }

    console.log('Creating chart...');
    console.log('chartContainer:', chartContainer, chartContainer.clientWidth, chartContainer.clientHeight);

    const chartOptions = {
        width: chartContainer.clientWidth,
        height: chartContainer.clientHeight || 600,
        layout: {
            textColor: '#d1d4dc',
            background: { type: 'solid', color: '#161a25' },
        },
        grid: {
            vertLines: { color: '#2a2e39' },
            horzLines: { color: '#2a2e39' },
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
        },
        rightPriceScale: {
            borderColor: '#2a2e39',
        },
        timeScale: {
            borderColor: '#2a2e39',
            timeVisible: true,
            secondsVisible: false,
        },
        localization: {
            locale: 'ko-KR',
            dateFormat: 'yyyy-MM-dd',
            timeFormatter: businessDayOrTimestamp => {
                const date = new Date(businessDayOrTimestamp * 1000);
                const hours = date.getHours().toString().padStart(2, '0');
                const minutes = date.getMinutes().toString().padStart(2, '0');
                const seconds = date.getSeconds().toString().padStart(2, '0');
                return `${hours}:${minutes}:${seconds}`;
            },
        },
    };

    chart = LightweightCharts.createChart(chartContainer, chartOptions);
    console.log('Chart created:', chart);

    candlestickSeries = chart.addCandlestickSeries({
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
    });

    ma1Series = chart.addLineSeries({ color: '#e91e63', lineWidth: 1, title: `MA${currentMa1}` });
    ma2Series = chart.addLineSeries({ color: '#9c27b0', lineWidth: 1, title: `MA${currentMa2}` });
    ma3Series = chart.addLineSeries({ color: '#2196f3', lineWidth: 1, title: `MA${currentMa3}` });

    console.log('Calling fetchData...');
    fetchData();
    fetchScheduledPrediction();
    fetchPosition();
    // Fixed demo snapshot; refresh only when a control changes.
    new ResizeObserver(() => {
        chart.applyOptions({ width: chartContainer.clientWidth, height: chartContainer.clientHeight });
    }).observe(chartContainer);
}


// Position Dashboard
let currentPriceLine = null;
let positionMarker = null; // Store current position marker

function updateScheduledPredictionUI(data) {
    // Time & Latency
    document.getElementById('sched-time').textContent = data.time_str;
    if (data.latency_ms) {
        document.getElementById('sched-latency').textContent = (data.latency_ms / 1000).toFixed(2) + '초';
    }

    // Main Result
    const resultEl = document.getElementById('sched-result');
    resultEl.textContent = data.prediction;
    resultEl.className = 'result-value ' + (data.prediction === 'LONG' ? 'positive' : (data.prediction === 'SHORT' ? 'negative' : ''));

    document.getElementById('sched-conf').textContent = (data.confidence * 100).toFixed(1) + '%';

    // Probabilities
    if (data.probabilities) {
        const longP = (data.probabilities.long * 100).toFixed(1);
        const shortP = (data.probabilities.short * 100).toFixed(1);

        document.getElementById('prob-bar-long').style.width = longP + '%';
        document.getElementById('prob-val-long').textContent = longP + '%';

        document.getElementById('prob-bar-short').style.width = shortP + '%';
        document.getElementById('prob-val-short').textContent = shortP + '%';

        // Update Threshold Text
        if (data.thresholds) {
            const longTh = (data.thresholds.long * 100).toFixed(0);
            const shortTh = (data.thresholds.short * 100).toFixed(0);
            document.getElementById('prob-threshold-text').textContent =
                `Limit: Long > ${longTh}%, Short > ${shortTh}%`;
        }
    }

    // Features
    if (data.features) {
        document.getElementById('feat-rsi').textContent = data.features.rsi_14.toFixed(1);
        document.getElementById('feat-slope').textContent = data.features.slope_ma25.toFixed(4);
        document.getElementById('feat-bear').textContent = data.features.bear_power.toFixed(4);
        document.getElementById('feat-adx').textContent = data.features.adx.toFixed(1);
    }
}

function updatePositionDashboard(data) {
    const noPosMsg = document.getElementById('no-position-msg');
    const posDetails = document.getElementById('position-details');

    // Clear price line if no position or error
    if (!data || data.status !== 'active') {
        noPosMsg.style.display = 'flex';
        posDetails.style.display = 'none';

        if (currentPriceLine && candlestickSeries) {
            candlestickSeries.removePriceLine(currentPriceLine);
            currentPriceLine = null;
        }
        positionMarker = null; // Clear marker
        if (candlestickSeries) candlestickSeries.setMarkers([]);
        return;
    }

    const pos = data.data;
    console.log('Position Data:', pos); // Debug log

    noPosMsg.style.display = 'none';
    posDetails.style.display = 'block';

    // Update fields
    document.getElementById('pos-symbol').textContent = pos.symbol;

    const sideEl = document.getElementById('pos-side');
    sideEl.textContent = pos.side;
    sideEl.className = `pos-side ${pos.side.toLowerCase()}`;

    const roiEl = document.getElementById('pos-roi');
    const roiVal = parseFloat(pos.roi);
    roiEl.textContent = `${roiVal >= 0 ? '+' : ''}${roiVal.toFixed(2)}%`;
    roiEl.className = `pos-roi-value ${roiVal >= 0 ? 'positive' : 'negative'}`;

    document.getElementById('pos-entry').textContent = parseFloat(pos.entry_price).toLocaleString(undefined, { minimumFractionDigits: 2 });
    document.getElementById('pos-mark').textContent = parseFloat(pos.mark_price).toLocaleString(undefined, { minimumFractionDigits: 2 });
    document.getElementById('pos-size').textContent = parseFloat(pos.size).toFixed(3);

    const pnlEl = document.getElementById('pos-pnl');
    const pnlVal = parseFloat(pos.unrealized_pnl);
    pnlEl.textContent = `${pnlVal >= 0 ? '+' : ''}${pnlVal.toFixed(2)}`;
    pnlEl.className = `value ${pnlVal >= 0 ? 'positive' : 'negative'}`;

    if (pos.timestamp) {
        const date = new Date(parseInt(pos.timestamp));
        document.getElementById('pos-time').textContent = date.toLocaleTimeString();
    }

    // Update Chart Price Line
    if (candlestickSeries && currentSymbol !== 'BTCUSDT') {
        if (currentPriceLine) candlestickSeries.removePriceLine(currentPriceLine);
        currentPriceLine = null;
        positionMarker = null;
        candlestickSeries.setMarkers([]);
        return;
    }
    if (candlestickSeries) {
        // Remove existing line if it exists
        if (currentPriceLine) {
            candlestickSeries.removePriceLine(currentPriceLine);
        }

        // Create new line
        const entryPrice = parseFloat(pos.entry_price);
        const isLong = pos.side.toUpperCase() === 'LONG';
        const color = isLong ? '#26a69a' : '#ef5350'; // Green for Long, Red for Short

        currentPriceLine = candlestickSeries.createPriceLine({
            price: entryPrice,
            color: color,
            lineWidth: 2,
            lineStyle: 2, // Dashed
            axisLabelVisible: true,
            title: `${pos.side} ENTRY`,
        });

        // Create Marker
        if (pos.timestamp) {
            const entryTime = parseInt(pos.timestamp) / 1000;
            positionMarker = {
                time: entryTime,
                position: isLong ? 'belowBar' : 'aboveBar',
                color: color,
                shape: isLong ? 'arrowUp' : 'arrowDown',
                text: 'ENTRY',
                size: 2
            };
            // Force update markers immediately
            candlestickSeries.setMarkers([positionMarker]);
        }
    }
}

async function fetchPosition() {
    try {
        const data = await loadDemoData('/api/position');
        updatePositionDashboard(data);
    } catch (error) {
        console.error('Error fetching position:', error);
    }
}


// Initial Load
console.log('Script loaded, initializing...');
initSplits();
mobileLayout.addEventListener('change', initSplits);
setupFullscreenButtons();
initChart();

// Fetch Data
async function fetchData() {
    // Capture current state at the start of the request
    const requestSymbol = currentSymbol;
    const requestInterval = currentInterval;
    const requestMa1 = currentMa1;
    const requestMa2 = currentMa2;
    const requestMa3 = currentMa3;

    connectionStatus.textContent = 'Fetching...';
    try {
        const data = await loadDemoData(`/api/data?symbol=${requestSymbol}&interval=${requestInterval}&ma1=${requestMa1}&ma2=${requestMa2}&ma3=${requestMa3}`);

        // Check if the state has changed while we were fetching
        if (requestSymbol !== currentSymbol ||
            requestInterval !== currentInterval ||
            requestMa1 !== currentMa1 ||
            requestMa2 !== currentMa2 ||
            requestMa3 !== currentMa3) {
            console.log('Discarding stale data');
            return;
        }

        // Update Series
        candlestickSeries.setData(data.candles);
        ma1Series.setData(data.ma1.data);
        ma2Series.setData(data.ma2.data);
        ma3Series.setData(data.ma3.data);

        // Update series titles with actual periods
        ma1Series.applyOptions({ title: `MA${data.ma1.period}` });
        ma2Series.applyOptions({ title: `MA${data.ma2.period}` });
        ma3Series.applyOptions({ title: `MA${data.ma3.period}` });

        // Merge markers
        let markers = data.markers || [];
        if (positionMarker) {
            markers.push(positionMarker);
        }
        // Sort markers by time (required by library)
        markers.sort((a, b) => a.time - b.time);

        candlestickSeries.setMarkers(markers);

        // Update UI
        const lastCandle = data.candles[data.candles.length - 1];
        lastPriceEl.textContent = lastCandle.close.toFixed(2);
        connectionStatus.textContent = '샘플 · 실시간 아님';
        connectionStatus.style.color = '#26a69a';

        const lastSignal = data.lastSignal;
        if (lastSignal === 'buy') {
            signalText.textContent = 'LONG SIGNAL (MA7 > MA25)';
            signalText.className = 'signal-buy';
        } else if (lastSignal === 'sell') {
            signalText.textContent = 'SHORT SIGNAL (MA7 < MA25)';
            signalText.className = 'signal-sell';
        } else {
            signalText.textContent = '샘플 데이터 · 매매 신호 미연결';
            signalText.className = 'signal-neutral';
        }

    } catch (error) {
        // Only report error if it's for the current state
        if (requestSymbol === currentSymbol && requestInterval === currentInterval) {
            console.error(error);
            connectionStatus.textContent = `Error: ${error.message}`;
            connectionStatus.style.color = 'red';
        }
    }
}

// Event Listeners
symbolSelect.addEventListener('change', (e) => {
    currentSymbol = e.target.value;
    fetchPosition();
    fetchData();
});

intervalSelect.addEventListener('change', (e) => {
    currentInterval = e.target.value;
    fetchData();
});

ma1Input.addEventListener('change', (e) => {
    if (!e.target.reportValidity()) return;
    currentMa1 = Number(e.target.value);
    fetchData();
});

ma2Input.addEventListener('change', (e) => {
    if (!e.target.reportValidity()) return;
    currentMa2 = Number(e.target.value);
    fetchData();
});

ma3Input.addEventListener('change', (e) => {
    if (!e.target.reportValidity()) return;
    currentMa3 = Number(e.target.value);
    fetchData();
});

// Tab Switching Logic
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        // Remove active class from all buttons and contents
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => {
            c.classList.remove('active');
            c.style.display = 'none';
        });

        // Add active class to clicked button
        btn.classList.add('active');

        // Show corresponding content
        const tabId = btn.dataset.tab;
        const content = document.getElementById(tabId);
        content.classList.add('active');
        content.style.display = 'flex'; // Use flex to maintain layout

        // If history tab, fetch data
        if (tabId === 'history-tab') {
            fetchTradeHistory();
        }
    });
});

document.getElementById('refresh-history-btn').addEventListener('click', () => {
    fetchTradeHistory();
});

async function fetchTradeHistory() {
    try {
        console.log('Fetching trade history...');
        const result = await loadDemoData('/api/trades');
        console.log('Trade history result:', result);

        if (result.status === 'success') {
            updateTradeHistoryUI(result.data);
        }
    } catch (error) {
        console.error('Error fetching trade history:', error);
    }
}

function updateTradeHistoryUI(trades) {
    const tbody = document.getElementById('trade-history-body');
    if (!tbody) {
        console.error('Tbody element not found!');
        return;
    }
    tbody.innerHTML = '';

    console.log('Rendering trades:', trades);

    if (!trades || !Array.isArray(trades) || trades.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px;">No trades found</td></tr>';
        return;
    }

    trades.forEach((trade, index) => {
        try {
            const tr = document.createElement('tr');

            const date = new Date(trade.timestamp);
            const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

            const isBuy = (trade.side && trade.side.toUpperCase() === 'BUY');
            const pnl = trade.realizedPnl || 0;
            const pnlClass = pnl > 0 ? 'positive' : (pnl < 0 ? 'negative' : '');
            const pnlStr = pnl !== 0 ? (pnl > 0 ? '+' : '') + pnl.toFixed(2) : '-';

            const priceStr = trade.price ? parseFloat(trade.price).toLocaleString(undefined, { minimumFractionDigits: 1 }) : '-';

            tr.innerHTML = `
                <td>${timeStr}</td>
                <td class="trade-side ${isBuy ? 'buy' : 'sell'}">${trade.side || '?'}</td>
                <td>${priceStr}</td>
                <td>${trade.amount || 0}</td>
                <td class="trade-pnl ${pnlClass}">${pnlStr}</td>
            `;
            tbody.appendChild(tr);
        } catch (err) {
            console.error(`Error rendering trade at index ${index}:`, err, trade);
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="5" style="color: red;">Error rendering row: ${err.message}</td>`;
            tbody.appendChild(tr);
        }
    });
}

async function fetchScheduledPrediction() {
    try {
        const result = await loadDemoData('/api/latest_prediction');

        if (result.status === 'success' && result.data) {
            updateScheduledPredictionUI(result.data);
        }
    } catch (error) {
        console.error('Error fetching scheduled prediction:', error);
    }
}
