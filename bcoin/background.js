// Talks to the llama.cpp server for the tabs (pages never see it), relays the per-site toggle,
// and shows each tab's state on the badge.
const SETTINGS = 'settings';
const TOGGLE_COMMAND = 'toggle-bcoin';
const DEFAULT_SETTINGS = { url: 'http://127.0.0.1:8012', key: '', model: '', nPredict: 128, tMaxPredictMs: 250 };
// Loading or waking a model takes seconds; only a newer request cuts an older one short.
const REQUEST_TIMEOUT_MS = 120000;
const LOOPBACK_RE = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?\/?$/;
const inflight = new Map();

async function settings() {
    const { [SETTINGS]: s } = await chrome.storage.local.get(SETTINGS);
    return { ...DEFAULT_SETTINGS, ...s };
}

function headers(s) {
    const h = { 'Content-Type': 'application/json' };
    if (s.key) h.Authorization = `Bearer ${s.key}`;
    return h;
}

function badge(tabId, text, color, title) {
    chrome.action.setBadgeText({ tabId, text });
    chrome.action.setBadgeBackgroundColor({ tabId, color });
    chrome.action.setTitle({ tabId, title });
}

async function infill(tabId, ctx) {
    const s = await settings();
    if (!LOOPBACK_RE.test(s.url)) throw new Error(`server URL must be http on 127.0.0.1 or localhost: ${s.url}`);
    if (inflight.has(tabId)) inflight.get(tabId).abort();
    const controller = new AbortController();
    inflight.set(tabId, controller);
    const body = {
        input_prefix: ctx.prefix,
        input_suffix: ctx.suffix,
        prompt: ctx.middle,
        input_extra: [],
        n_predict: s.nPredict,
        n_indent: ctx.nIndent,
        t_max_predict_ms: s.tMaxPredictMs,
        stream: false,
        cache_prompt: true,
        top_k: 40,
        top_p: 0.9,
        samplers: ['top_k', 'top_p', 'infill'],
        response_fields: ['content'],
    };
    if (s.model) body.model = s.model;
    try {
        const res = await fetch(s.url.replace(/\/$/, '') + '/infill', {
            method: 'POST',
            headers: headers(s),
            body: JSON.stringify(body),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((json.error && json.error.message) || `HTTP ${res.status}`);
        const first = Array.isArray(json) ? json[0] : json;
        return typeof (first && first.content) === 'string' ? first.content : '';
    } finally {
        if (inflight.get(tabId) === controller) inflight.delete(tabId);
    }
}

// What the options page shows for "Test connection".
async function testConnection() {
    const s = await settings();
    if (!LOOPBACK_RE.test(s.url)) return `URL must be http on 127.0.0.1 or localhost: ${s.url}`;
    const base = s.url.replace(/\/$/, '');
    try {
        const health = await fetch(base + '/health', { signal: AbortSignal.timeout(5000) });
        if (!health.ok) return `Server answered /health with HTTP ${health.status}`;
        const models = await fetch(base + '/models', { headers: headers(s), signal: AbortSignal.timeout(5000) });
        if (models.status === 401) return 'Server is up, but it rejected the API key';
        if (!models.ok) return 'Server is up';
        const list = ((await models.json()).data || []).map((m) => ({ id: m.id, status: m.status && m.status.value }));
        if (!s.model) return list.length > 1 ? `Server is up; it serves several models, so set one: ${list.map((m) => m.id).join(', ')}` : 'Server is up';
        const m = list.find((x) => x.id === s.model);
        if (!m) return `Server is up, but it has no model "${s.model}"; it has: ${list.map((x) => x.id).join(', ')}`;
        return `Server is up; ${s.model} is ${m.status || 'available'}${m.status === 'unloaded' ? ' (the first suggestion loads it)' : ''}`;
    } catch (e) {
        return `Cannot reach ${base}: ${e.message}`;
    }
}

async function toggle(tab) {
    if (!tab || tab.id === undefined) return;
    try {
        await chrome.tabs.sendMessage(tab.id, { type: 'toggle' }, { frameId: 0 });
    } catch {
        // No content script in this tab (brave:// pages).
    }
}

chrome.action.onClicked.addListener(toggle);
chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command !== TOGGLE_COMMAND) return;
    toggle(tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const tabId = sender.tab && sender.tab.id;
    if (msg.type === 'state' && tabId !== undefined) {
        badge(tabId, msg.enabled ? 'AI' : '', '#2e7d32', `bcoin: ${msg.enabled ? 'on' : 'off'} for this site`);
    } else if (msg.type === 'infill' && tabId !== undefined) {
        infill(tabId, msg.ctx).then(
            (content) => {
                badge(tabId, 'AI', '#2e7d32', 'bcoin: on for this site');
                sendResponse({ content });
            },
            (e) => {
                if (e.name !== 'AbortError') badge(tabId, '!', '#c62828', `bcoin: ${e.message}`);
                sendResponse({ error: e.message, aborted: e.name === 'AbortError' });
            });
        return true;
    } else if (msg.type === 'test') {
        testConnection().then(sendResponse);
        return true;
    }
});
