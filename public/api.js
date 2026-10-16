import { numberOrNull } from './format.js';

// Same-origin requests pass through Cloudflare Access and the Worker to EC2.
export async function loadApiData(path) {
    const response = await fetch(path, {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000)
    });
    if (response.status === 401 || response.status === 403) throw new Error('로그인이 필요해. 새로고침해줘.');
    if (!response.ok) throw new Error(`조회 실패 (HTTP ${response.status})`);
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('로그인 또는 서버 응답을 확인해줘.');
    return response.json();
}

export async function loadBinanceCandles(symbol, interval, endTime) {
    if (!['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].includes(symbol) ||
        !['1m', '5m', '15m', '1h', '4h', '1d'].includes(interval)) throw new Error('지원하지 않는 차트 설정이야.');
    const query = new URLSearchParams({ symbol, interval, limit: '500' });
    if (endTime !== undefined) {
        if (!Number.isSafeInteger(endTime) || endTime < 0) throw new Error('과거 차트 조회 시각 오류');
        query.set('endTime', String(endTime));
    }
    const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?${query}`, {
        credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`바이낸스 차트 조회 실패 (HTTP ${response.status})`);
    const rows = await response.json();
    if (!Array.isArray(rows) || (!rows.length && endTime === undefined)) throw new Error('바이낸스 캔들 데이터가 비어 있거나 잘못됐어.');
    const candles = rows.map(row => {
        if (!Array.isArray(row) || row.length < 5) throw new Error('바이낸스 캔들 형식 오류');
        const [timestamp, open, high, low, close] = row.slice(0, 5).map(numberOrNull);
        if (!Number.isSafeInteger(timestamp) || timestamp <= 0 ||
            [open, high, low, close].some(price => price === null || price <= 0) ||
            low > Math.min(open, close) || high < Math.max(open, close)) throw new Error('바이낸스 캔들 값 오류');
        return { time: timestamp / 1000, open, high, low, close };
    });
    if (candles.some((c, i) => i > 0 && c.time <= candles[i - 1].time)) throw new Error('바이낸스 캔들 시간 순서 오류');
    return { candles };
}
