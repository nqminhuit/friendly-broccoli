const DASHBOARD_PATH = 'dashboard.html';
const DASHBOARD_URL = chrome.runtime.getURL(DASHBOARD_PATH);
let opening;

// getContexts lists only this extension's live dashboard pages (Chrome 116+,
// no tabs permission). Frame filter keeps one entry per dashboard tab.
async function ownDashboardContexts() {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [DASHBOARD_URL] });
    return (contexts || []).filter((entry) => entry.documentUrl === DASHBOARD_URL
        && Number.isInteger(entry.tabId)
        && Number.isInteger(entry.windowId)
        && (entry.frameId === undefined || entry.frameId === 0));
}

async function findDashboardContext() {
    const owned = await ownDashboardContexts();
    if (!owned.length) return null;
    const stored = await chrome.storage.session.get('dashboardTabId');
    if (Number.isInteger(stored.dashboardTabId)) {
        const preferred = owned.find((entry) => entry.tabId === stored.dashboardTabId);
        if (preferred) return preferred;
    }
    return owned[0];
}

async function openDashboard() {
    if (opening) return opening;
    opening = (async () => {
        const target = await findDashboardContext().catch(() => null);
        if (!target) {
            const created = await chrome.tabs.create({ url: DASHBOARD_URL });
            await chrome.storage.session.set({ dashboardTabId: created.id });
            await chrome.windows.update(created.windowId, { focused: true });
            await chrome.tabs.update(created.id, { active: true });
            return created;
        }
        await chrome.storage.session.set({ dashboardTabId: target.tabId });
        try {
            await chrome.windows.update(target.windowId, { focused: true });
            await chrome.tabs.update(target.tabId, { active: true });
            return { id: target.tabId, windowId: target.windowId };
        } catch {
            // Tab closed between discovery and focus: reuse a live one or create once.
            const retry = await findDashboardContext().catch(() => null);
            if (retry) {
                await chrome.storage.session.set({ dashboardTabId: retry.tabId });
                await chrome.windows.update(retry.windowId, { focused: true });
                await chrome.tabs.update(retry.tabId, { active: true });
                return { id: retry.tabId, windowId: retry.windowId };
            }
            const created = await chrome.tabs.create({ url: DASHBOARD_URL });
            await chrome.storage.session.set({ dashboardTabId: created.id });
            await chrome.windows.update(created.windowId, { focused: true });
            await chrome.tabs.update(created.id, { active: true });
            return created;
        }
    })();
    try { return await opening; } finally { opening = undefined; }
}

chrome.action.onClicked.addListener(() => { void openDashboard(); });

if (typeof module !== 'undefined') module.exports = { openDashboard };
