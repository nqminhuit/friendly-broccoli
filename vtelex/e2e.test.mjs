// Loads the real extension into headless Chrome over CDP and types into a local page.
// Run: node --test vtelex/e2e.test.mjs (skips when Chrome is missing; set CHROME to its path).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.dirname(fileURLToPath(import.meta.url));
const CHROME = [process.env.CHROME, '/opt/google/chrome/chrome', '/usr/bin/google-chrome'].find((p) => p && fs.existsSync(p));
const CDP_PORT = 19432;
const WEB_PORT = 19433;
const SITE = `http://127.0.0.1:${WEB_PORT}/`;
const OTHER_SITE = `http://localhost:${WEB_PORT}/`;
const PAGE = '<!doctype html><body><input id=i><textarea id=t></textarea><div id=d contenteditable></div></body>';
const FIELDS = ['#i', '#t', '#d'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chrome, server, ws, profile, extId, sw, page;
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

const ACTIVE_TAB = '(await chrome.tabs.query({}))[0]';
const toggle = () => evaluate(sw, `(async () => { await chrome.tabs.sendMessage(${ACTIVE_TAB}.id, { type: 'toggle' }, { frameId: 0 }); })()`);
const badge = () => evaluate(sw, `(async () => chrome.action.getBadgeText({ tabId: ${ACTIVE_TAB}.id }))()`);

async function open(url) {
    await send('Page.navigate', { url }, page);
    await sleep(800);
}

// Types text into the field; \b is Backspace. Returns the field's text with non-breaking spaces as spaces.
async function type(selector, text) {
    await evaluate(page, `document.querySelector('${selector}').focus()`);
    for (const ch of text) {
        if (ch === '\b') {
            await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, page);
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, page);
            continue;
        }
        const code = { ' ': 'Space', '?': 'Slash', '.': 'Period' }[ch] || `Key${ch.toUpperCase()}`;
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, code, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) }, page);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code }, page);
    }
    const value = await evaluate(page, `(e => e.tagName === 'DIV' ? e.innerText : e.value)(document.querySelector('${selector}'))`);
    return value.replace(/ /g, ' ');
}

before(async () => {
    if (!CHROME) return;
    server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); }).listen(WEB_PORT);
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vtelex-e2e-'));
    // Some runner images block Chrome's sandbox (AppArmor user namespaces), so CI runs without it.
    const sandbox = process.env.CI ? ['--no-sandbox'] : [];
    chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
                            '--no-first-run', '--enable-unsafe-extension-debugging', ...sandbox, 'about:blank'],
                   { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    chrome.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    let version;
    for (let i = 0; i < 150 && !version && chrome.exitCode === null; i++) {
        try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch { await sleep(200); }
    }
    if (!version) throw new Error(`Chrome did not start (exit ${chrome.exitCode}):\n${stderr}`);
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    };
    extId = (await send('Extensions.loadUnpacked', { path: EXT })).result.id;
    await sleep(1000);
    sw = await attach((t) => t.type === 'service_worker' && t.url.includes(extId));
    page = await attach((t) => t.type === 'page');
    await open(SITE);
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
    // Helper processes can still be writing the profile; it is only a temp dir.
    try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
        // Left for the OS to clean.
    }
});

const it = (name, fn) => test(name, { skip: !CHROME && 'Chrome not found' }, fn);

it('a new site starts in English', async () => {
    assert.equal(await badge(), 'EN');
    assert.equal(await type('#i', 'tieengs'), 'tieengs');
});

it('toggling switches the site to Vietnamese and flashes the mode', async () => {
    await toggle();
    await sleep(100);
    assert.equal(await evaluate(page, `[...document.body.children].filter((e) => !e.id).length`), 1);
    assert.equal(await badge(), 'VI');
    await sleep(1500);
    assert.equal(await evaluate(page, `[...document.body.children].filter((e) => !e.id).length`), 0);
});

for (const selector of FIELDS) {
    it(`${selector}: telex, shortcuts and Backspace undo`, async () => {
        await evaluate(page, `(e => { e.value = ''; e.textContent = ''; })(document.querySelector('${selector}'))`);
        assert.equal(await type(selector, 'tieengs ko?'), 'tiếng không?');
        assert.equal(await type(selector, ' ko \b'), 'tiếng không? ko ');
        assert.equal(await type(selector, '\b'), 'tiếng không? ko');
        assert.equal(await type(selector, '. tieengs\b'), 'tiếng không? không. tiến');
    });
}

it('the mode is per site and remembered', async () => {
    await open(SITE + 'again');
    assert.equal(await badge(), 'VI');
    await open(OTHER_SITE);
    assert.equal(await badge(), 'EN');
    assert.equal(await type('#i', 'tieengs'), 'tieengs');
});

it('shortcuts saved on the options page apply', async () => {
    await open(`chrome-extension://${extId}/options.html`);
    assert.match(await evaluate(page, `document.getElementById('macros').value`), /ko = không/);
    await evaluate(page, `document.getElementById('macros').value += 'xyz = xin chào\\n'; document.getElementById('save').click()`);
    await sleep(300);
    assert.match(await evaluate(page, `document.getElementById('status').textContent`), /^Saved/);
    await open(SITE);
    assert.equal(await type('#i', 'xyz '), 'xin chào ');
});
