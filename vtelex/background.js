// Relays Alt+Space and icon clicks to the tab, which flips VI/EN for its site, and shows each tab's mode on the badge.
const TOGGLE_COMMAND = 'toggle-telex';

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
    if (command !== TOGGLE_COMMAND) return;
    toggle(tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]);
});

chrome.runtime.onMessage.addListener((msg, sender) => {
    const tabId = sender.tab && sender.tab.id;
    if (msg.type !== 'state' || tabId === undefined) return;
    chrome.action.setBadgeText({ tabId, text: msg.enabled ? 'VI' : 'EN' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: msg.enabled ? '#c62828' : '#757575' });
    chrome.action.setTitle({ tabId, title: `vtelex: ${msg.enabled ? 'Vietnamese' : 'English'} on this site` });
});

// 0.2.x kept one global switch; modes are per site now.
chrome.runtime.onInstalled.addListener(() => chrome.storage.local.remove('enabled'));
