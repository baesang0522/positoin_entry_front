// Same-origin requests pass through Cloudflare Access and the Worker to EC2.
async function loadApiData(path) {
    const response = await fetch(path, {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000)
    });
    if (response.status === 401 || response.status === 403) throw new Error('로그인이 필요해. 새로고침해줘.');
    if (!response.ok) throw new Error(`조회 실패 (HTTP ${response.status})`);
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('로그인 또는 서버 응답을 확인해줘.');
    return response.json();
}

function numberOrNull(value) {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

function formatNumber(value, digits = 2) {
    const number = numberOrNull(value);
    return number === null ? '—' : number.toFixed(digits);
}

function showStatus(id, message, failed = false) {
    const el = document.getElementById(id);
    el.textContent = message;
    el.style.color = failed ? '#ef5350' : '';
}

function snapshotStatus(data) {
    const saved = data.last_updated ? `서버 저장: ${data.last_updated.replace('T', ' ')}` : '서버 저장 시각 없음';
    return `${saved} · 조회: ${new Date().toLocaleTimeString()}`;
}

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

    new ResizeObserver(() => {
        chart.applyOptions({ width: chartContainer.clientWidth, height: chartContainer.clientHeight });
    }).observe(chartContainer);
}


// Position Dashboard
let currentPriceLine = null;

function updateScheduledPredictionUI(data = {}) {
    const timestamp = numberOrNull(data.timestamp);
    document.getElementById('sched-time').textContent = timestamp === null ? (data.time_str || '—') : new Date(timestamp * 1000).toLocaleString();
    document.getElementById('sched-latency').textContent = numberOrNull(data.latency_ms) === null ? '—' : formatNumber(data.latency_ms / 1000) + '초';
    const resultEl = document.getElementById('sched-result');
    resultEl.textContent = data.prediction || '—';
    resultEl.className = 'result-value ' + (data.prediction === 'LONG' ? 'positive' : (data.prediction === 'SHORT' ? 'negative' : ''));
    document.getElementById('sched-conf').textContent = numberOrNull(data.confidence) === null ? '—' : formatNumber(data.confidence * 100, 1) + '%';
    for (const side of ['long', 'short']) {
        const probability = numberOrNull(data.probabilities?.[side]);
        const valid = probability !== null && probability >= 0 && probability <= 1;
        document.getElementById(`prob-bar-${side}`).style.width = valid ? `${probability * 100}%` : '0%';
        document.getElementById(`prob-val-${side}`).textContent = valid ? formatNumber(probability * 100, 1) + '%' : '—';
    }
    const longTh = numberOrNull(data.thresholds?.long), shortTh = numberOrNull(data.thresholds?.short);
    document.getElementById('prob-threshold-text').textContent = longTh === null || shortTh === null ? '모델 기준 정보 없음' :
        `모델 기준: Long ${formatNumber(longTh * 100, 1)}% · Short ${formatNumber(shortTh * 100, 1)}%`;
    for (const [id, key, digits] of [['feat-rsi', 'rsi_14', 1], ['feat-slope', 'slope_ma25', 4], ['feat-bear', 'bear_power', 4], ['feat-adx', 'adx', 1]]) {
        document.getElementById(id).textContent = formatNumber(data.features?.[key], digits);
    }
}

function updatePositionDashboard(data) {
    const noPosMsg = document.getElementById('no-position-msg');
    const posDetails = document.getElementById('position-details');

    // Clear price line if no position or error
    if (!data || data.status !== 'active') {
        noPosMsg.textContent = data?.status === 'no_position' ? '보유 포지션 없음' : data?.status === 'no_data' ? '저장된 포지션 정보 없음' : '포지션 조회 실패';
        noPosMsg.style.display = 'flex';
        posDetails.style.display = 'none';

        if (currentPriceLine && candlestickSeries) {
            candlestickSeries.removePriceLine(currentPriceLine);
            currentPriceLine = null;
        }
        if (candlestickSeries) candlestickSeries.setMarkers([]);
        return;
    }

    const pos = data.data;

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
    document.getElementById('pos-size').textContent = Number(pos.size).toLocaleString(undefined, { maximumFractionDigits: 8 });

    const pnlEl = document.getElementById('pos-pnl');
    const pnlVal = parseFloat(pos.unrealized_pnl);
    pnlEl.textContent = `${pnlVal >= 0 ? '+' : ''}${pnlVal.toFixed(2)}`;
    pnlEl.className = `value ${pnlVal >= 0 ? 'positive' : 'negative'}`;

    document.getElementById('pos-time').textContent = numberOrNull(pos.timestamp) === null ? '—' : new Date(Number(pos.timestamp)).toLocaleString();

    // Update Chart Price Line
    if (candlestickSeries && currentSymbol !== pos.symbol.split(':')[0].replace('/', '')) {
        if (currentPriceLine) candlestickSeries.removePriceLine(currentPriceLine);
        currentPriceLine = null;
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

        // Exchange position timestamp is not a confirmed entry timestamp.
        candlestickSeries.setMarkers([]);
    }
}

let positionLoading = false;
async function fetchPosition() {
    if (positionLoading) return;
    positionLoading = true;
    try {
        const data = await loadApiData('/api/position');
        if (!['active', 'no_position', 'no_data'].includes(data.status)) throw new Error('포지션 응답 오류');
        if (data.status === 'active' && (!data.data || typeof data.data.symbol !== 'string' ||
            !['LONG', 'SHORT'].includes(data.data.side) ||
            ['size', 'entry_price', 'mark_price', 'unrealized_pnl', 'roi'].some(key => numberOrNull(data.data[key]) === null))) {
            throw new Error('포지션 응답 오류');
        }
        updatePositionDashboard(data);
        showStatus('position-status', snapshotStatus(data));
    } catch (error) {
        updatePositionDashboard(null);
        showStatus('position-status', `${error.message} · 연결과 로그인을 확인해줘.`, true);
    } finally {
        positionLoading = false;
    }
}

let chartRequest = 0;
let displayedChart = '';
// Fetch Data
async function fetchData() {
    if (!chart) return;
    const requestId = ++chartRequest;
    // Capture current state at the start of the request
    const requestSymbol = currentSymbol;
    const requestInterval = currentInterval;
    const requestMa1 = currentMa1;
    const requestMa2 = currentMa2;
    const requestMa3 = currentMa3;

    const chartKey = [requestSymbol, requestInterval, requestMa1, requestMa2, requestMa3].join(':');
    if (chartKey !== displayedChart) {
        for (const series of [candlestickSeries, ma1Series, ma2Series, ma3Series]) series.setData([]);
        candlestickSeries.setMarkers([]);
        if (currentPriceLine) candlestickSeries.removePriceLine(currentPriceLine);
        currentPriceLine = null;
        lastPriceEl.textContent = '—';
    }
    connectionStatus.textContent = '차트 조회 중';
    try {
        const data = await loadApiData(`/api/data?symbol=${requestSymbol}&interval=${requestInterval}&ma1=${requestMa1}&ma2=${requestMa2}&ma3=${requestMa3}`);

        // Check if the state has changed while we were fetching
        if (requestId !== chartRequest || requestSymbol !== currentSymbol ||
            requestInterval !== currentInterval ||
            requestMa1 !== currentMa1 ||
            requestMa2 !== currentMa2 ||
            requestMa3 !== currentMa3) {
            console.log('Discarding stale data');
            return;
        }

        if (!Array.isArray(data.candles) || !data.candles.length ||
            data.candles.some((c, i, a) => ![c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) || (i > 0 && c.time <= a[i - 1].time)) ||
            ['ma1', 'ma2', 'ma3'].some(key => !Array.isArray(data[key]?.data))) {
            throw new Error('차트 데이터가 비어 있거나 잘못됐어.');
        }
        displayedChart = chartKey;
        // Update Series
        candlestickSeries.setData(data.candles);
        ma1Series.setData(data.ma1.data);
        ma2Series.setData(data.ma2.data);
        ma3Series.setData(data.ma3.data);

        // Update series titles with actual periods
        ma1Series.applyOptions({ title: `MA${data.ma1.period}` });
        ma2Series.applyOptions({ title: `MA${data.ma2.period}` });
        ma3Series.applyOptions({ title: `MA${data.ma3.period}` });

        // Update UI
        const lastCandle = data.candles[data.candles.length - 1];
        lastPriceEl.textContent = lastCandle.close.toFixed(2);
        connectionStatus.textContent = `차트 조회 ${new Date().toLocaleTimeString()}`;
        connectionStatus.style.color = '#26a69a';

        signalText.textContent = '모델의 최근 판단은 ML Predictions에서 확인해줘.';
        signalText.className = 'signal-neutral';

    } catch (error) {
        // Only report error if it's for the current state
        if (requestId === chartRequest) {
            console.error(error);
            connectionStatus.textContent = `차트 갱신 실패 · ${error.message}`;
            lastPriceEl.textContent = '—';
            signalText.textContent = '차트 갱신 실패 · 남아 있는 차트는 이전 조회 결과야.';
            connectionStatus.style.color = 'red';
        }
    }
}

// Event Listeners
symbolSelect.addEventListener('change', (e) => {
    currentSymbol = e.target.value;
    fetchData();
    fetchPosition();
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

let historyLoading = false;
async function fetchTradeHistory() {
    if (historyLoading) return;
    historyLoading = true;
    try {
        const result = await loadApiData('/api/trades');
        if (result.status !== 'success' || !Array.isArray(result.data)) throw new Error('거래내역 응답 오류');
        updateTradeHistoryUI(result.data);
        showStatus('history-status', snapshotStatus(result));
    } catch (error) {
        document.getElementById('trade-history-body').replaceChildren();
        showStatus('history-status', `${error.message} · 연결과 로그인을 확인해줘.`, true);
    } finally {
        historyLoading = false;
    }
}

function updateTradeHistoryUI(trades) {
    const tbody = document.getElementById('trade-history-body');
    tbody.replaceChildren();
    if (!trades.length) {
        const cell = document.createElement('td');
        cell.colSpan = 5;
        cell.textContent = '저장된 거래내역 없음';
        const row = document.createElement('tr');
        row.appendChild(cell);
        tbody.appendChild(row);
        return;
    }
    for (const trade of trades) {
        const row = document.createElement('tr');
        const pnl = numberOrNull(trade.realizedPnl ?? trade.info?.realizedPnl);
        const side = String(trade.side || '?').toUpperCase();
        const values = [
            numberOrNull(trade.timestamp) === null ? '—' : new Date(Number(trade.timestamp)).toLocaleString(),
            side, formatNumber(trade.price, 2), formatNumber(trade.amount, 8),
            pnl === null ? '—' : `${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}`
        ];
        for (const [index, value] of values.entries()) {
            const cell = document.createElement('td');
            cell.textContent = value;
            if (index === 1) cell.className = `trade-side ${side === 'BUY' ? 'buy' : side === 'SELL' ? 'sell' : ''}`;
            if (index === 4) cell.className = `trade-pnl ${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : ''}`;
            row.appendChild(cell);
        }
        tbody.appendChild(row);
    }
}

async function fetchScheduledPrediction() {
    try {
        const result = await loadApiData('/api/latest_prediction');
        if (result.status === 'no_data') {
            updateScheduledPredictionUI();
            showStatus('prediction-status', '저장된 예측 정보 없음');
        } else if (result.status === 'success' && result.data && typeof result.data.prediction === 'string') {
            updateScheduledPredictionUI(result.data);
            showStatus('prediction-status', `조회: ${new Date().toLocaleTimeString()} · 아래는 마지막 저장된 판단이야.`);
        } else {
            throw new Error('예측 응답 오류');
        }
    } catch (error) {
        updateScheduledPredictionUI();
        showStatus('prediction-status', `${error.message} · 연결과 로그인을 확인해줘.`, true);
    }
}

let refreshing = false;
async function refreshDashboard() {
    if (refreshing || document.hidden) return;
    refreshing = true;
    try {
        // Sequential requests suit the EC2 viewer's single-threaded server.
        await fetchData();
        await fetchPosition();
        await fetchScheduledPrediction();
        if (document.getElementById('history-tab').classList.contains('active')) await fetchTradeHistory();
    } finally {
        refreshing = false;
    }
}

initSplits();
mobileLayout.addEventListener('change', initSplits);
setupFullscreenButtons();
initChart();
refreshDashboard();
setInterval(refreshDashboard, 30000);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshDashboard();
});
