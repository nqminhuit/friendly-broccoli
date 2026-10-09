// Toggles telex from the toolbar icon or the Alt+Space command and shows the state on the badge.
const ENABLED = 'enabled';
const TOGGLE_COMMAND = 'toggle-telex';

async function paint() {
    const { [ENABLED]: on } = await chrome.storage.local.get(ENABLED);
    await chrome.action.setBadgeText({ text: on ? 'VI' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
    await chrome.action.setTitle({ title: `vtelex: ${on ? 'on' : 'off'}` });
}

async function toggle() {
    const { [ENABLED]: on } = await chrome.storage.local.get(ENABLED);
    await chrome.storage.local.set({ [ENABLED]: !on });
    await paint();
}

chrome.action.onClicked.addListener(toggle);
chrome.commands.onCommand.addListener((command) => { if (command === TOGGLE_COMMAND) toggle(); });
chrome.runtime.onStartup.addListener(paint);
chrome.runtime.onInstalled.addListener(paint);
