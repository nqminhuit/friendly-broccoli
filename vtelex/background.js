// Relays toggle requests (icon, command, Super+Space in a page) to the tab, which flips VI/EN for its site,
// shows each tab's mode on the badge, and opens the pad window.
const TOGGLE_COMMAND = 'toggle-telex';
const PAD_COMMAND = 'open-pad';
const PAD_PAGE = 'pad.html';

// Focuses the pad window if one is open (the worker may have restarted, so look at tabs), else opens one.
async function openPad() {
    const [tab] = await chrome.tabs.query({ url: chrome.runtime.getURL(PAD_PAGE) });
    if (tab) {
        await chrome.windows.update(tab.windowId, { focused: true });
        await chrome.tabs.update(tab.id, { active: true });
        return;
    }
    await chrome.windows.create({ url: PAD_PAGE, type: 'popup', width: 480, height: 220, focused: true });
}

// Only the tab's content script knows its site, so the toggle happens there; pages without one (brave://) ignore it.
async function toggle(tab) {
    if (!tab || tab.id === undefined) return;
    try {
        await chrome.tabs.sendMessage(tab.id, { type: 'toggle' }, { frameId: 0 });
    } catch {
        // No content script in this tab.
    }
}

chrome.action.onClicked.addListener(toggle);
chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command === PAD_COMMAND) {
        openPad();
        return;
    }
    if (command !== TOGGLE_COMMAND) return;
    toggle(tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]);
});

chrome.runtime.onMessage.addListener((msg, sender) => {
    const tabId = sender.tab && sender.tab.id;
    if (msg.type === 'open-pad') openPad();
    if (msg.type === 'toggle') toggle(sender.tab);
    if (msg.type !== 'state' || tabId === undefined) return;
    chrome.action.setBadgeText({ tabId, text: msg.enabled ? 'VI' : 'EN' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: msg.enabled ? '#c62828' : '#757575' });
    chrome.action.setTitle({ tabId, title: `vtelex: ${msg.enabled ? 'Vietnamese' : 'English'} on this site` });
});

// 0.2.x kept one global switch; modes are per site now.
chrome.runtime.onInstalled.addListener(() => chrome.storage.local.remove('enabled'));
