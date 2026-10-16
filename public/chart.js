import { loadBinanceCandles } from './api.js';
import { numberOrNull } from './format.js';

export function entryMarkers(trades, candles, symbol, interval) {
    const seconds = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }[interval];
    const markers = new Map();
    for (const trade of trades) {
        const pnl = numberOrNull(trade.realizedPnl ?? trade.info?.realizedPnl);
        const timestamp = numberOrNull(trade.timestamp);
        const tradeSymbol = String(trade.symbol || trade.info?.symbol || '').split(':')[0].replace('/', '');
        const side = String(trade.side || '').toUpperCase();
        // shortcut: zero-PnL exits also look like entries; use explicit entry metadata if exact classification is needed.
        if (pnl !== 0 || timestamp === null || timestamp <= 0 || tradeSymbol !== symbol || !['BUY', 'SELL'].includes(side)) continue;
        const time = timestamp / 1000;
        const candle = candles.find(c => c.time <= time && time < c.time + seconds);
        if (!candle) continue;
        const isLong = side === 'BUY';
        // Multiple fills in the same candle and direction share one arrow.
        markers.set(`${candle.time}:${side}`, {
            time: candle.time,
            position: isLong ? 'belowBar' : 'aboveBar',
            color: isLong ? '#26a69a' : '#ef5350',
            shape: isLong ? 'arrowUp' : 'arrowDown',
            text: isLong ? 'LONG ENTRY' : 'SHORT ENTRY'
        });
    }
    return [...markers.values()].sort((a, b) => a.time - b.time);
}

function renderEntryMarkers() {
    if (candlestickSeries) candlestickSeries.setMarkers(entryMarkers(recentTrades, chartCandles, currentSymbol, currentInterval));
}

// DOM Elements
const chartContainer = document.getElementById('chart-container');
const symbolSelect = document.getElementById('symbol-select');
const intervalSelect = document.getElementById('interval-select');
const connectionStatus = document.getElementById('connection-status');
const lastPriceEl = document.getElementById('last-price');

// State
let currentSymbol = symbolSelect.value;
let currentInterval = intervalSelect.value;
let chart;
let candlestickSeries;
let chartCandles = [];
let recentTrades = [];

export function initChart() {
    if (typeof LightweightCharts === 'undefined') {
        console.error('LightweightCharts library not loaded!');
        connectionStatus.textContent = 'Error: Lib not loaded';
        connectionStatus.style.color = 'red';
        return;
    }

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

    candlestickSeries = chart.addCandlestickSeries({
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
    });
    new ResizeObserver(() => {
        chart.applyOptions({ width: chartContainer.clientWidth, height: chartContainer.clientHeight });
    }).observe(chartContainer);
}

let currentPriceLine = null;

export function updatePositionLine(data) {
    if (currentPriceLine && candlestickSeries) candlestickSeries.removePriceLine(currentPriceLine);
    currentPriceLine = null;
    if (!candlestickSeries || data?.status !== 'active') return;
    const pos = data.data;
    if (currentSymbol !== pos.symbol.split(':')[0].replace('/', '')) return;

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
}

export function setTradeMarkers(trades) {
    recentTrades = trades;
    renderEntryMarkers();
}

export function resizeChart(fitContent = false) {
    if (!chart) return;
    chart.applyOptions({ width: chartContainer.clientWidth, height: chartContainer.clientHeight });
    if (fitContent) chart.timeScale().fitContent();
}

let chartRequest = 0;
let displayedChart = '';
export async function fetchData() {
    if (!chart) return;
    currentSymbol = symbolSelect.value;
    currentInterval = intervalSelect.value;
    const requestId = ++chartRequest;
    // Capture current state at the start of the request
    const requestSymbol = currentSymbol;
    const requestInterval = currentInterval;

    const chartKey = [requestSymbol, requestInterval].join(':');
    if (chartKey !== displayedChart) {
        chartCandles = [];
        candlestickSeries.setData([]);
        candlestickSeries.setMarkers([]);
        if (currentPriceLine) candlestickSeries.removePriceLine(currentPriceLine);
        currentPriceLine = null;
        lastPriceEl.textContent = '—';
    }
    connectionStatus.textContent = '차트 조회 중';
    try {
        const data = await loadBinanceCandles(requestSymbol, requestInterval);

        // Check if the state has changed while we were fetching
        if (requestId !== chartRequest || requestSymbol !== currentSymbol ||
            requestInterval !== currentInterval) {
            console.log('Discarding stale data');
            return;
        }

        if (!Array.isArray(data.candles) || !data.candles.length ||
            data.candles.some((c, i, a) => ![c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) || (i > 0 && c.time <= a[i - 1].time))) {
            throw new Error('차트 데이터가 비어 있거나 잘못됐어.');
        }
        displayedChart = chartKey;
        // Update Series
        candlestickSeries.setData(data.candles);
        chartCandles = data.candles;
        renderEntryMarkers();

        // Update UI
        const lastCandle = data.candles[data.candles.length - 1];
        lastPriceEl.textContent = lastCandle.close.toFixed(2);
        connectionStatus.textContent = `차트 조회 ${new Date().toLocaleTimeString()}`;
        connectionStatus.style.color = '#26a69a';
    } catch (error) {
        // Only report error if it's for the current state
        if (requestId === chartRequest) {
            console.error(error);
            connectionStatus.textContent = `차트 갱신 실패 · 이전 조회 결과 · ${error.message}`;
            lastPriceEl.textContent = '—';
            connectionStatus.style.color = 'red';
        }
    }
}
