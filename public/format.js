export function numberOrNull(value) {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

export function formatNumber(value, digits = 2) {
    const number = numberOrNull(value);
    return number === null ? '—' : number.toFixed(digits);
}

export function snapshotStatus(data) {
    const saved = data.last_updated ? `서버 저장: ${data.last_updated.replace('T', ' ').replace(/(\d{2}:\d{2}:\d{2})\.\d+/, '$1')}` : '서버 저장 시각 없음';
    return `${saved} · 조회: ${new Date().toLocaleTimeString()}`;
}
