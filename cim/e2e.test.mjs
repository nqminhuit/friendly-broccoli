import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = [process.env.CHROME, '/opt/google/chrome/chrome', '/usr/bin/google-chrome'].find((item) => item && fs.existsSync(item));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let chrome, ws, profile, pageSession, extensionId, nextId = 0;
const pending = new Map();

function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
}
async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, pageSession);
    if (result.result.exceptionDetails) throw new Error(result.result.exceptionDetails.exception.description);
    return result.result.result.value;
}
async function waitFor(expression, timeout = 7000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        if (await evaluate(expression)) return;
        await sleep(50);
    }
    let page = 'unavailable';
    try { page = await evaluate(`location.href + ' | ' + document.title + ' | ' + document.body?.innerText + ' | scripts=' + typeof CimSettings + '/' + typeof CimApi + '/' + typeof CimMonitor + '/' + typeof chrome + ' | hidden=' + document.querySelector('#setup-empty')?.hidden + ' | requests=' + JSON.stringify(globalThis.__cimRequests) + ' | errors=' + document.querySelector('#repo-errors')?.textContent`); } catch (error) { page = String(error); }
    throw new Error(`Timed out waiting for ${expression}; page=${page}`);
}

before(async () => {
    if (!CHROME) return;
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cim-e2e-'));
    const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--enable-unsafe-extension-debugging'];
    if (process.env.CI) args.push('--no-sandbox');
    chrome = spawn(CHROME, [...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    chrome.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
    let version;
    for (let i = 0; i < 150 && !version && chrome.exitCode === null; i++) {
        try {
            const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
            version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        } catch { await sleep(200); }
    }
    if (!version) throw new Error(`Chrome did not start (exit ${chrome.exitCode}):\n${stderr}`);
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve) => { ws.onopen = resolve; });
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') console.error('CIM E2E page exception:', message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
        if (pending.has(message.id)) {
            const item = pending.get(message.id); pending.delete(message.id);
            if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message);
        }
    };
    extensionId = (await send('Extensions.loadUnpacked', { path: HERE })).result.id;
    await sleep(600);
    const target = (await send('Target.createTarget', { url: 'about:blank' })).result.targetId;
    pageSession = (await send('Target.attachToTarget', { targetId: target, flatten: true })).result.sessionId;
    await send('Page.enable', {}, pageSession);
    await send('Runtime.enable', {}, pageSession);
    const mock = `(() => {
      globalThis.__cimRequests = [];
      globalThis.fetch = async (input, options = {}) => {
        const url = String(input), auth = options.headers?.Authorization;
        globalThis.__cimRequests.push({ url, auth });
        if (!url.startsWith('https://api.github.com/')) throw new Error('Blocked unexpected network URL');
        if (auth !== 'Bearer e2e-token') throw new Error('Unexpected or missing token');
        if (url.includes('/repos/acme/forbidden/')) return new Response('{"message":"Not Found"}', {status:404});
        const older = url.includes('page=2');
        const runs = older ? [{id:3,name:'Deploy',display_title:'Older deploy',head_branch:'main',status:'completed',conclusion:'success',run_number:3,run_attempt:1,event:'push',actor:{login:'ci'},created_at:'2025-01-01T00:00:00Z',updated_at:'2025-01-01T00:01:00Z',html_url:'https://github.com/acme/app/actions/runs/3'}] : [
          {id:1,name:'Build',display_title:'Compile app',head_branch:'main',status:'completed',conclusion:'success',run_number:12,run_attempt:1,event:'push',actor:{login:'alice'},created_at:'2025-02-01T00:00:00Z',updated_at:'2025-02-01T00:02:00Z',run_started_at:'2025-02-01T00:00:00Z',html_url:'https://github.com/acme/app/actions/runs/1'},
          {id:2,name:'Deploy',display_title:'Deploy to preview',head_branch:'feature/demo',status:'in_progress',conclusion:null,run_number:13,run_attempt:2,event:'workflow_dispatch',actor:{login:'bob'},created_at:'2025-02-02T00:00:00Z',updated_at:'2025-02-02T00:01:00Z',html_url:'https://evil.example/steal'}
        ];
        const headers = new Headers({'content-type':'application/json','etag':'"fixture"'});
        if (!older) headers.set('Link', '<https://api.github.com/repos/acme/app/actions/runs?per_page=30&page=2>; rel="next"');
        if (options.headers?.['If-None-Match']) return new Response(null, {status:304,headers});
        return new Response(JSON.stringify({total_count:3,workflow_runs:runs}), {status:200,headers});
      };
    })()`;
    await send('Page.addScriptToEvaluateOnNewDocument', { source: mock }, pageSession);
    await send('Page.navigate', { url: `chrome-extension://${extensionId}/dashboard.html` }, pageSession);
});

after(async () => {
    if (!CHROME) return;
    if (chrome && chrome.exitCode === null) {
        const exited = new Promise((resolve) => chrome.once('exit', resolve));
        if (ws?.readyState === WebSocket.OPEN) send('Browser.close'); else chrome.kill();
        const killer = setTimeout(() => chrome.kill('SIGKILL'), 5000);
        await exited; clearTimeout(killer);
    }
    ws?.close();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Leave cleanup to the OS. */ }
});

test('dashboard saves session config, filters history, renders safe links/errors, and pauses when hidden', { skip: !CHROME && 'Chrome not found' }, async () => {
    await waitFor(`document.querySelector('#setup-empty') && !document.querySelector('#setup-empty').hidden`);
    await evaluate(`document.querySelector('#setup-open').click()`);
    await evaluate(`document.querySelector('#repositories').value='acme/app\\nacme/forbidden'; document.querySelector('#token').value='e2e-token'; document.querySelector('#settings-form').requestSubmit()`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Compile app')`);
    await waitFor(`document.querySelector('#repo-errors').textContent.includes('inaccessible')`);
    const dashboardUrls = await evaluate(`chrome.tabs.query({url:chrome.runtime.getURL('dashboard.html')}).then(tabs=>tabs.map(tab=>tab.url))`);
    assert.ok(dashboardUrls.includes(`chrome-extension://${extensionId}/dashboard.html`));
    assert.equal(await evaluate(`chrome.storage.session.get('token').then(x=>x.token)`), 'e2e-token');
    assert.equal(await evaluate(`chrome.storage.local.get('token').then(x=>x.token||null)`), null);
    assert.equal(await evaluate(`document.querySelectorAll('#run-list a').length`), 1);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('Running')`), true);
    assert.equal(await evaluate(`document.querySelector('#run-list a').href`), 'https://github.com/acme/app/actions/runs/1');
    await evaluate(`document.querySelector('#search').value='Compile'; document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelectorAll('#run-list .run-card').length`), 1);
    await evaluate(`document.querySelector('#search').value='no match'; document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}))`);
    assert.equal(await evaluate(`!document.querySelector('#filtered-empty').hidden`), true);
    await evaluate(`document.querySelector('#search').value=''; document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#older').click()`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Older deploy')`);
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}); document.dispatchEvent(new Event('visibilitychange'))`);
    const hiddenCount = await evaluate(`globalThis.__cimRequests.length`);
    await sleep(200);
    assert.equal(await evaluate(`globalThis.__cimRequests.length`), hiddenCount);
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange'))`);
    await waitFor(`globalThis.__cimRequests.length > ${hiddenCount}`);
    assert.equal(await evaluate(`globalThis.__cimRequests.every(x=>x.url.startsWith('https://api.github.com/') && x.auth==='Bearer e2e-token')`), true);
});
