// Loads bcoin (and vtelex, which users run alongside it) into headless Chrome over CDP, against a fake
// /infill server. Run: node --test bcoin/e2e.test.mjs (skips when Chrome is missing; set CHROME to its path).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VTELEX = path.join(HERE, '..', 'vtelex');
const CHROME = [process.env.CHROME, '/opt/google/chrome/chrome', '/usr/bin/google-chrome'].find((p) => p && fs.existsSync(p));
const KEY = 'test-key';
const MODEL = 'test-model';
const PAGE = '<!doctype html><body><textarea id=t rows=6 cols=60></textarea><input id=i><input id=p type=password>'
    + '<div id=r contenteditable style="width:420px;min-height:60px;border:1px solid #888;font:15px sans-serif"></div>'
    // Like CKEditor 5: it inserts typed text itself from beforeinput, so no input event ever fires.
    + '<div id=m contenteditable style="width:420px;min-height:60px;border:1px solid #888;white-space:pre-wrap"></div>'
    + '<script>m.addEventListener("beforeinput", (e) => {'
    + '  if (e.inputType !== "insertText") return;'
    + '  e.preventDefault();'
    + '  const sel = getSelection(), r = sel.getRangeAt(0), t = document.createTextNode(e.data);'
    + '  r.deleteContents(); r.insertNode(t); r.setStartAfter(t); r.collapse(true);'
    + '  sel.removeAllRanges(); sel.addRange(r);'
    + '});</script></body>';
// Fake model answers by the current line before the caret.
const ANSWERS = { 'x = ': '1 + 2', 'y = ': 'x * 2', 'z = ': 'first\nsecond', 'tiếng ': 'Việt' };
const PAUSE_MS = 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const requests = [];
let chrome, server, ws, profile, site, bcoinWorker, vtelexWorker, page;
let nextId = 0;
const pending = new Map();

function send(method, params = {}, sessionId) {
    return new Promise((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
}

async function evaluate(sessionId, expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception.description);
    return r.result.result.value;
}

async function attach(match) {
    const { targetInfos } = (await send('Target.getTargets')).result;
    const target = targetInfos.find(match);
    return (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).result.sessionId;
}

const toggle = (worker) => evaluate(worker, `(async () => {
    const [tab] = await chrome.tabs.query({});
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' }, { frameId: 0 });
})()`);
const badge = () => evaluate(bcoinWorker, `(async () => chrome.action.getBadgeText({ tabId: (await chrome.tabs.query({}))[0].id }))()`);
const ghostText = () => evaluate(page, `(() => {
    const host = document.querySelector('[data-bcoin]');
    const ghost = host && host.shadowRoot.querySelector('[data-ghost]');
    return ghost ? ghost.textContent : null;
})()`);
// A textarea's value, or a rich editor's text with non-breaking spaces as spaces.
const value = (selector) => evaluate(page, `(e => e.tagName === 'TEXTAREA' ? e.value : e.innerText.replace(/\\u00a0/g, ' '))(document.querySelector('${selector}'))`);

async function key(k, { code = k, vk = 0, text, modifiers = 0 } = {}) {
    await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, text, windowsVirtualKeyCode: vk, modifiers }, page);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }, page);
}

async function type(selector, text) {
    await evaluate(page, `document.querySelector('${selector}').focus()`);
    for (const ch of text) {
        if (ch === '\n') await key('Enter', { vk: 13, text: '\r' });
        else await key(ch, { code: ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), text: ch });
    }
}

async function reset(selector) {
    await evaluate(page, `(e => {
        if (e.tagName === 'TEXTAREA') e.value = ''; else e.replaceChildren();
        e.focus();
        e.removeAttribute('aria-expanded');
    })(document.querySelector('${selector}'))`);
    await key('Escape', { vk: 27 });
}

before(async () => {
    if (!CHROME) return;
    server = http.createServer((req, res) => {
        if (req.url !== '/infill') {
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.end(PAGE);
            return;
        }
        let raw = '';
        req.on('data', (d) => { raw += d; });
        req.on('end', () => {
            const body = JSON.parse(raw);
            requests.push({ auth: req.headers.authorization, body });
            // No CORS headers on purpose: the host permission alone must let the extension in.
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ content: ANSWERS[body.prompt] ?? '' }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    site = `http://127.0.0.1:${server.address().port}`;
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bcoin-e2e-'));
    // Some runner images block Chrome's sandbox (AppArmor user namespaces), so CI runs without it.
    const sandbox = process.env.CI ? ['--no-sandbox'] : [];
    chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
                            '--no-first-run', '--enable-unsafe-extension-debugging', ...sandbox, 'about:blank'],
                   { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    chrome.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    const portFile = path.join(profile, 'DevToolsActivePort');
    let version;
    for (let i = 0; i < 150 && !version && chrome.exitCode === null; i++) {
        try {
            const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
            version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        } catch {
            await sleep(200);
        }
    }
    if (!version) throw new Error(`Chrome did not start (exit ${chrome.exitCode}):\n${stderr}`);
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    };
    const bcoinId = (await send('Extensions.loadUnpacked', { path: HERE })).result.id;
    const vtelexId = (await send('Extensions.loadUnpacked', { path: VTELEX })).result.id;
    await sleep(1000);
    bcoinWorker = await attach((t) => t.type === 'service_worker' && t.url.includes(bcoinId));
    vtelexWorker = await attach((t) => t.type === 'service_worker' && t.url.includes(vtelexId));
    await evaluate(bcoinWorker, `chrome.storage.local.set({ settings: { url: '${site}', key: '${KEY}', model: '${MODEL}', nPredict: 64, tMaxPredictMs: 250 } })`);
    page = await attach((t) => t.type === 'page');
    await send('Page.navigate', { url: site + '/' }, page);
    await sleep(800);
});

after(async () => {
    if (!CHROME) return;
    if (server) server.close();
    if (chrome && chrome.exitCode === null) {
        const exited = new Promise((r) => chrome.once('exit', r));
        // Not awaited: a wedged Chrome may never answer, and the kill below covers that.
        if (ws && ws.readyState === WebSocket.OPEN) send('Browser.close');
        else chrome.kill();
        const killer = setTimeout(() => chrome.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(killer);
    }
    if (ws) ws.close();
    try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
        // Left for the OS to clean.
    }
});

const it = (name, fn) => test(name, { skip: !CHROME && 'Chrome not found' }, fn);

it('a site that is off sends nothing', async () => {
    assert.equal(await badge(), '');
    await type('#t', 'x = ');
    await sleep(PAUSE_MS);
    assert.equal(requests.length, 0);
});

it('after a pause the suggestion shows as a ghost', async () => {
    await toggle(bcoinWorker);
    await sleep(200);
    assert.equal(await badge(), 'AI');
    await reset('#t');
    await type('#t', 'x = ');
    await sleep(PAUSE_MS);
    assert.equal(requests.length, 1);
    const { auth, body } = requests[0];
    assert.equal(auth, `Bearer ${KEY}`);
    assert.equal(body.model, MODEL);
    assert.equal(body.prompt, 'x = ');
    assert.equal(body.input_prefix, '');
    assert.equal(body.input_suffix, '\n');
    assert.equal(body.n_predict, 64);
    assert.equal(await ghostText(), '1 + 2');
});

it('typing the ghost shrinks it without a request', async () => {
    await type('#t', '1');
    assert.equal(await ghostText(), ' + 2');
    await sleep(PAUSE_MS);
    assert.equal(requests.length, 1);
});

it('Ctrl+Right accepts a word and Tab the rest', async () => {
    await key('ArrowRight', { vk: 39, modifiers: 2 });
    assert.equal(await value('#t'), 'x = 1 +');
    assert.equal(await ghostText(), ' 2');
    await key('Tab', { vk: 9 });
    assert.equal(await value('#t'), 'x = 1 + 2');
    assert.equal(await ghostText(), null);
});

it('Esc dismisses and leaves the text alone', async () => {
    await type('#t', '\ny = ');
    await sleep(PAUSE_MS);
    assert.equal(await ghostText(), 'x * 2');
    await key('Escape', { vk: 27 });
    assert.equal(await ghostText(), null);
    assert.equal(await value('#t'), 'x = 1 + 2\ny = ');
});

it('no request in the middle of a line', async () => {
    await reset('#t');
    await type('#t', 'f()');
    await sleep(PAUSE_MS);
    const before = requests.length;
    await key('ArrowLeft', { vk: 37 });
    await type('#t', 'a');
    await sleep(PAUSE_MS);
    assert.equal(requests.length, before);
});

it('inputs and password fields never send anything', async () => {
    const before = requests.length;
    await type('#i', 'x = ');
    await type('#p', 'x = ');
    await sleep(PAUSE_MS);
    assert.equal(requests.length, before);
});

it('Tab goes to an open autocomplete list instead', async () => {
    await reset('#t');
    await type('#t', 'x = ');
    await sleep(PAUSE_MS);
    assert.equal(await ghostText(), '1 + 2');
    await evaluate(page, `document.querySelector('#t').setAttribute('aria-expanded', 'true')`);
    await key('Tab', { vk: 9 });
    assert.equal(await value('#t'), 'x = ');
    assert.equal(await ghostText(), null);
});

it('works alongside vtelex telex typing', async () => {
    await toggle(vtelexWorker);
    await sleep(200);
    await reset('#t');
    await type('#t', 'tieengs ');
    await sleep(PAUSE_MS);
    assert.equal(await value('#t'), 'tiếng ');
    assert.equal(requests.at(-1).body.prompt, 'tiếng ');
    assert.equal(await ghostText(), 'Việt');
    await key('Tab', { vk: 9 });
    assert.equal(await value('#t'), 'tiếng Việt');
});

it('rich editor: a ghost at the caret, typing through it and Tab', async () => {
    await reset('#r');
    await type('#r', 'x = ');
    await sleep(PAUSE_MS);
    assert.equal(await ghostText(), '1 + 2');
    const before = requests.length;
    await type('#r', '1');
    assert.equal(await ghostText(), ' + 2');
    await key('Tab', { vk: 9 });
    assert.equal(await value('#r'), 'x = 1 + 2');
    assert.equal(requests.length, before);
});

it('rich editor: only the first line of a suggestion, and context across paragraphs', async () => {
    await reset('#r');
    await type('#r', 'line one\nz = ');
    await sleep(PAUSE_MS);
    const { body } = requests.at(-1);
    assert.equal(body.input_prefix, 'line one\n');
    assert.equal(body.prompt, 'z = ');
    assert.equal(await ghostText(), 'first');
    await key('Escape', { vk: 27 });
    assert.equal(await ghostText(), null);
});

it('rich editor that types itself without input events, as CKEditor 5 does', async () => {
    await reset('#m');
    await type('#m', 'x = ');
    await sleep(PAUSE_MS);
    assert.equal(await ghostText(), '1 + 2');
    await type('#m', '1');
    assert.equal(await ghostText(), ' + 2');
    await key('Tab', { vk: 9 });
    assert.equal(await value('#m'), 'x = 1 + 2');
});
