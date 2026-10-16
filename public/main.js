import { initChart, fetchData, resizeChart } from './chart.js';
import { fetchPosition, fetchTradeHistory, fetchScheduledPrediction } from './dashboard.js';

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
            setTimeout(() => resizeChart(true), 0);
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
                setTimeout(() => resizeChart(), 100);
            } else {
                // Enter fullscreen
                document.body.classList.add('panel-fullscreen');
                panel.classList.add('fullscreen-active');
                e.target.textContent = '⛝';

                // Resize chart
                setTimeout(() => resizeChart(), 100);
            }
        });
    });
}

// Event Listeners
document.getElementById('symbol-select').addEventListener('change', () => {
    fetchData();
    fetchPosition();
});

document.getElementById('interval-select').addEventListener('change', () => {
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

let refreshing = false;
export async function refreshDashboard() {
    if (refreshing || document.hidden) return;
    refreshing = true;
    try {
        // Sequential requests suit the EC2 viewer's single-threaded server.
        await fetchData();
        await fetchPosition();
        await fetchScheduledPrediction();
        await fetchTradeHistory();
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
