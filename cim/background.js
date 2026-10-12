const DASHBOARD_PATH = 'dashboard.html';
const DASHBOARD_URL = chrome.runtime.getURL(DASHBOARD_PATH);
let opening;

async function openDashboard() {
    if (opening) return opening;
    opening = (async () => {
        const stored = await chrome.storage.session.get('dashboardTabId');
        let tab = null;
        if (Number.isInteger(stored.dashboardTabId)) {
            try {
                const candidate = await chrome.tabs.get(stored.dashboardTabId);
                if (candidate.url === DASHBOARD_URL) tab = candidate;
            } catch { /* The dashboard tab was closed. */ }
        }
        if (!tab) {
            const matches = await chrome.tabs.query({ url: DASHBOARD_URL });
            tab = matches.find((candidate) => candidate.url === DASHBOARD_URL) || null;
        }
        if (!tab) tab = await chrome.tabs.create({ url: DASHBOARD_URL });
        await chrome.storage.session.set({ dashboardTabId: tab.id });
        await chrome.windows.update(tab.windowId, { focused: true });
        await chrome.tabs.update(tab.id, { active: true });
        return tab;
    })();
    try { return await opening; } finally { opening = undefined; }
}

chrome.action.onClicked.addListener(() => { void openDashboard(); });

if (typeof module !== 'undefined') module.exports = { openDashboard };
