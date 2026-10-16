import { loadApiData } from './api.js';
import { numberOrNull, formatNumber, snapshotStatus } from './format.js';
import { updatePositionLine, setTradeMarkers } from './chart.js';

function showStatus(id, message, failed = false) {
    const el = document.getElementById(id);
    el.textContent = message;
    el.style.color = failed ? '#ef5350' : '';
}

export function updateScheduledPredictionUI(data = {}) {
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

export function updatePositionDashboard(data) {
    updatePositionLine(data);
    const noPosMsg = document.getElementById('no-position-msg');
    const posDetails = document.getElementById('position-details');

    if (!data || data.status !== 'active') {
        noPosMsg.textContent = data?.status === 'no_position' ? '보유 포지션 없음' : data?.status === 'no_data' ? '저장된 포지션 정보 없음' : '포지션 조회 실패';
        noPosMsg.style.display = 'flex';
        posDetails.style.display = 'none';

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
}

let positionLoading = false;
export async function fetchPosition() {
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

let historyLoading = false;
export async function fetchTradeHistory() {
    if (historyLoading) return;
    historyLoading = true;
    try {
        const result = await loadApiData('/api/trades');
        if (result.status !== 'success' || !Array.isArray(result.data)) throw new Error('거래내역 응답 오류');
        updateTradeHistoryUI(result.data);
        setTradeMarkers(result.data);
        showStatus('history-status', snapshotStatus(result));
    } catch (error) {
        setTradeMarkers([]);
        document.getElementById('trade-history-body').replaceChildren();
        showStatus('history-status', `${error.message} · 연결과 로그인을 확인해줘.`, true);
    } finally {
        historyLoading = false;
    }
}

export function updateTradeHistoryUI(trades) {
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
    for (const trade of [...trades].sort((a, b) => (numberOrNull(b.timestamp) ?? -Infinity) - (numberOrNull(a.timestamp) ?? -Infinity))) {
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

export async function fetchScheduledPrediction() {
    try {
        const result = await loadApiData('/api/latest_prediction');
        if (result.status === 'no_data') {
            updateScheduledPredictionUI();
            showStatus('prediction-status', '저장된 예측 정보 없음');
        } else if (result.status === 'success' && result.data && typeof result.data.prediction === 'string') {
            updateScheduledPredictionUI(result.data);
            showStatus('prediction-status', `조회: ${new Date().toLocaleTimeString()}`);
        } else {
            throw new Error('예측 응답 오류');
        }
    } catch (error) {
        updateScheduledPredictionUI();
        showStatus('prediction-status', `${error.message} · 연결과 로그인을 확인해줘.`, true);
    }
}
