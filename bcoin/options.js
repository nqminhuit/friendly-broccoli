// Edits the server settings in chrome.storage.local; the background script reads them per request.
const SETTINGS = 'settings';
const DEFAULT_SETTINGS = { url: 'http://127.0.0.1:8012', key: '', model: '', nPredict: 128, tMaxPredictMs: 250, debug: false, pageContext: false };
const LOOPBACK_RE = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?\/?$/;
const FIELDS = Object.keys(DEFAULT_SETTINGS);
const status = document.getElementById('status');
const input = (name) => document.getElementById(name);

chrome.storage.local.get(SETTINGS, (r) => {
    const s = { ...DEFAULT_SETTINGS, ...r[SETTINGS] };
    for (const f of FIELDS) {
        if (typeof DEFAULT_SETTINGS[f] === 'boolean') input(f).checked = s[f];
        else input(f).value = s[f];
    }
});

function read() {
    const s = {};
    for (const f of FIELDS) {
        const kind = typeof DEFAULT_SETTINGS[f];
        s[f] = kind === 'boolean' ? input(f).checked : kind === 'number' ? Number(input(f).value) : input(f).value.trim();
    }
    return s;
}

async function save() {
    const s = read();
    if (!LOOPBACK_RE.test(s.url)) {
        status.textContent = 'The URL must be http on 127.0.0.1 or localhost, like http://127.0.0.1:8012';
        return false;
    }
    await chrome.storage.local.set({ [SETTINGS]: s });
    status.textContent = 'Saved';
    return true;
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('test').addEventListener('click', async () => {
    if (!(await save())) return;
    status.textContent = 'Testing...';
    status.textContent = await chrome.runtime.sendMessage({ type: 'test' });
});
