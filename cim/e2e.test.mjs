import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
    profile = fs.mkdtempSync(path.join('/tmp/opencode', 'cim-e2e-'));
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
      globalThis.__slowSignals = [];
      globalThis.__rerunAttempt = 1;
      globalThis.fetch = async (input, options = {}) => {
        const url = String(input), auth = options.headers?.Authorization;
        globalThis.__cimRequests.push({ url, auth, method: options.method || 'GET', body: options.body || '' });
        if (!url.startsWith('https://api.github.com/')) throw new Error('Blocked unexpected network URL');
        if (!['Bearer e2e-token','Bearer work-pat','Bearer expired-pat'].includes(auth)) throw new Error('Unexpected or missing token');
        if (auth === 'Bearer expired-pat') return new Response('{"message":"Bad credentials"}', {status:401});
        if (url.includes('/repos/acme/slow/')) { globalThis.__slowSignals.push(options.signal); await new Promise(resolve=>setTimeout(resolve,700)); return new Response(JSON.stringify({total_count:1,workflow_runs:[{id:90,name:'Slow',display_title:'Slow private result',status:'completed',conclusion:'success',created_at:'2025-01-01T00:00:00Z'}]}),{status:200,headers:{'content-type':'application/json'}}); }
        if (url.includes('/repos/acme/forbidden/')) return new Response('{"message":"Not Found"}', {status:404});
        if (url.endsWith('/actions/runs/1/rerun') || url.endsWith('/actions/runs/1/rerun-failed-jobs')) { setTimeout(()=>globalThis.__rerunAttempt++,600); return new Response(null, {status:201}); }
        if (url.endsWith('/actions/runs/1') && !url.includes('/jobs')) return new Response(JSON.stringify({id:1,run_attempt:globalThis.__rerunAttempt,status:'completed',conclusion:globalThis.__rerunAttempt === 1 ? 'failure' : 'success',name:'Build',head_branch:'main',head_sha:'abc123',created_at:new Date(Date.now()-86400000).toISOString()}), {status:200,headers:{'content-type':'application/json','etag':'"run-'+globalThis.__rerunAttempt+'"'}});
        if (url.includes('/actions/runs/1/attempts/') && url.includes('/jobs')) {
          const page = Number(new URL(url).searchParams.get('page') || '1'), headers = new Headers({'content-type':'application/json'});
          if (page === 1) headers.set('Link','<https://api.github.com/repos/acme/app/actions/runs/1/attempts/'+globalThis.__rerunAttempt+'/jobs?per_page=100&page=2>; rel="next"');
          const jobs = page === 1 ? [{id:100+globalThis.__rerunAttempt,name:'Compile <script>',status:'completed',conclusion:globalThis.__rerunAttempt === 1 ? 'failure' : 'success',started_at:'2025-02-01T00:00:00Z',completed_at:'2025-02-01T00:00:30Z',runner_name:'ubuntu-latest',html_url:'https://github.com/acme/app/actions/runs/1/job/101',steps:[{name:'Checkout',status:'completed',conclusion:'success'},{name:'Build',status:'completed',conclusion:'success'}]}] : [{id:200+globalThis.__rerunAttempt,name:'Package checks',status:'completed',conclusion:'success',steps:[]}];
          return new Response(JSON.stringify({total_count:2,jobs}), {status:200,headers});
        }
         const page = Number(new URL(url).searchParams.get('page') || '1');
         if (page === 4) { globalThis.__slowSignals.push(options.signal); await new Promise(resolve=>setTimeout(resolve,700)); }
         const runId = auth === 'Bearer work-pat' ? 20 : page + 2;
         const runs = page > 1 ? [{id:runId,name:'Deploy',display_title:'Older page '+page,head_branch:'main',status:'completed',conclusion:page===2?'success':'cancelled',run_number:runId,run_attempt:1,event:'push',actor:{login:'ci'},created_at:'2025-01-01T00:00:00Z',updated_at:'2025-01-01T00:01:00Z',html_url:'https://github.com/acme/app/actions/runs/'+runId}] : auth === 'Bearer work-pat' ? [{id:20,name:'Work Build',display_title:'Work-only result',head_branch:'work',status:'completed',conclusion:'action_required',run_number:20,run_attempt:1,event:'push',actor:{login:'worker'},created_at:'2025-03-01T00:00:00Z',updated_at:'2025-03-01T00:01:00Z',html_url:'https://github.com/acme/app/actions/runs/20'}] : [
          {id:1,name:'Build',display_title:'Compile app',head_branch:'main',status:'completed',conclusion:'success',run_number:12,run_attempt:1,event:'push',actor:{login:'alice'},created_at:'2025-02-01T00:00:00Z',updated_at:'2025-02-01T00:02:00Z',run_started_at:'2025-02-01T00:00:00Z',html_url:'https://github.com/acme/app/actions/runs/1'},
          {id:2,name:'Deploy',display_title:'Deploy to preview',head_branch:'feature/demo',status:'in_progress',conclusion:null,run_number:13,run_attempt:2,event:'workflow_dispatch',actor:{login:'bob'},created_at:'2025-02-02T00:00:00Z',updated_at:'2025-02-02T00:01:00Z',html_url:'https://evil.example/steal'}
        ];
        const headers = new Headers({'content-type':'application/json','etag':'"fixture"'});
         if (page < 4 && auth === 'Bearer e2e-token') headers.set('Link', '<https://api.github.com/repos/acme/app/actions/runs?per_page=30&page='+(page+1)+'>; rel="next"');
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

test('profiles route their own PATs, filter identity, paginate without rewind, and pause when hidden', { skip: !CHROME && 'Chrome not found' }, async () => {
    await waitFor(`document.querySelector('#setup-empty') && !document.querySelector('#setup-empty').hidden`);
    await evaluate(`document.querySelector('#setup-open').click()`);
    await evaluate(`document.querySelector('#profile-new').click(); document.querySelector('#profile-name').value='Personal'; document.querySelector('#repositories').value='acme/app\\nacme/forbidden'; document.querySelector('#token').value='e2e-token'; document.querySelector('#settings-form').requestSubmit()`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Compile app')`);
    await waitFor(`document.querySelector('#repo-errors').textContent.includes('inaccessible')`);
    const firstAuthCount = await evaluate(`globalThis.__cimRequests.length`);
    await evaluate(`document.querySelector('#profile-new').click(); document.querySelector('#repositories').value='acme/app'; document.querySelector('#test-access').click()`);
    assert.equal(await evaluate(`document.querySelector('#settings-mode').textContent`), 'New connection');
    assert.equal(await evaluate(`document.querySelector('#profile-delete').disabled && document.querySelector('#forget-token').disabled`), true);
    assert.equal(await evaluate(`document.querySelector('#profile-id').value === '' && document.querySelector('#settings-message').textContent.includes('personal access token')`), true);
    assert.equal(await evaluate(`globalThis.__cimRequests.length`), firstAuthCount);
    await evaluate(`document.querySelector('#settings-close').click()`);
    const dashboardUrls = await evaluate(`chrome.tabs.query({url:chrome.runtime.getURL('dashboard.html')}).then(tabs=>tabs.map(tab=>tab.url))`);
    assert.ok(dashboardUrls.includes(`chrome-extension://${extensionId}/dashboard.html`));
    assert.equal(await evaluate(`chrome.storage.session.get(null).then(x=>Object.values(x).includes('e2e-token'))`), true);
    assert.equal(await evaluate(`chrome.storage.local.get(null).then(x=>Object.entries(x).filter(([k])=>k.startsWith('cimProfile:')).every(([,v])=>!v.token))`), true);
    assert.equal(await evaluate(`document.querySelectorAll('#run-list a').length`), 1);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('Running')`), true);
    assert.equal(await evaluate(`document.querySelector('#run-list a').href`), 'https://github.com/acme/app/actions/runs/1');
    await evaluate(`document.querySelector('#search').value='Compile'; document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelectorAll('#run-list .run-card').length`), 1);
    await evaluate(`document.querySelector('#search').value='no match'; document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}))`);
    assert.equal(await evaluate(`!document.querySelector('#filtered-empty').hidden`), true);
    await evaluate(`document.querySelector('#search').value=''; document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#older').click()`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Older page 2')`);
    await evaluate(`document.querySelector('#refresh').click()`);
    await sleep(100);
    await evaluate(`document.querySelector('#older').click()`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Older page 3')`);
    await evaluate(`document.querySelector('#profile-new').click(); document.querySelector('#profile-name').value='Work'; document.querySelector('#repositories').value='acme/work'; document.querySelector('#token').value='work-pat'; document.querySelector('#settings-form').requestSubmit()`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Work-only result')`);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('Work')`), true);
    assert.equal(await evaluate(`document.querySelector('#run-list .profile-badge').textContent`), 'Work');
    assert.equal(await evaluate(`globalThis.__cimRequests.some(x=>x.auth==='Bearer work-pat' && x.url.includes('/repos/acme/work/'))`), true);
    assert.equal(await evaluate(`document.querySelectorAll('#repo-filter option').length === new Set([...document.querySelectorAll('#repo-filter option')].map(o=>o.value)).size`), true);
    await evaluate(`document.querySelector('#repo-filter').value='acme/app'; document.querySelector('#repo-filter').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#profile-filter').value=[...document.querySelector('#profile-filter').options].find(o=>o.text==='Work').value; document.querySelector('#profile-filter').dispatchEvent(new Event('change',{bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelector('#repo-filter').value === 'all' && document.querySelector('#run-list').textContent.includes('Work-only result')`), true);
    await evaluate(`document.querySelector('#profile-filter').value=[...document.querySelector('#profile-filter').options].find(o=>o.text==='Personal').value; document.querySelector('#profile-filter').dispatchEvent(new Event('change',{bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('Work-only result')`), false);
    await evaluate(`document.querySelector('#profile-filter').value='all'; document.querySelector('#profile-filter').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#status-filter').value='action_required'; document.querySelector('#status-filter').dispatchEvent(new Event('change',{bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('Work-only result')`), true);
    await evaluate(`document.querySelector('#status-filter').value='all'; document.querySelector('#status-filter').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#profile-new').click(); document.querySelector('#profile-name').value='Expired'; document.querySelector('#repositories').value='acme/app'; document.querySelector('#token').value='expired-pat'; document.querySelector('#settings-form').requestSubmit()`);
    await waitFor(`document.querySelector('#repo-errors').textContent.includes('invalid or expired')`);
    const expiredCount = await evaluate(`globalThis.__cimRequests.length`);
    await evaluate(`document.querySelector('#profile-select').value=[...document.querySelector('#profile-select').options].find(o=>o.text.startsWith('Expired')).value; document.querySelector('#profile-select').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#test-access').click()`);
    await waitFor(`document.querySelector('#settings-message').textContent.includes('invalid or expired')`);
    assert.equal(await evaluate(`globalThis.__cimRequests.length`), expiredCount);
    await evaluate(`document.querySelector('#settings-close').click()`);
    const healthyCount = await evaluate(`globalThis.__cimRequests.filter(x=>x.auth==='Bearer work-pat').length`);
    await evaluate(`document.querySelector('#refresh').click()`);
    await sleep(100);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.auth==='Bearer work-pat').length > ${healthyCount}`), true);
    const personalId = await evaluate(`[...document.querySelector('#profile-filter').options].find(o=>o.text==='Personal').value`);
    await evaluate(`document.querySelector('#profile-filter').value='${personalId}'; document.querySelector('#profile-filter').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#older').click()`);
    await waitFor(`globalThis.__slowSignals.length > 0`);
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}); document.dispatchEvent(new Event('visibilitychange'))`);
    await waitFor(`globalThis.__slowSignals.at(-1).aborted`);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('Older page 4')`), false);
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange'))`);
    await evaluate(`document.querySelector('#profile-new').click(); document.querySelector('#profile-name').value='Slow'; document.querySelector('#repositories').value='acme/slow'; document.querySelector('#token').value='e2e-token'; document.querySelector('#settings-form').requestSubmit()`);
    await waitFor(`globalThis.__slowSignals.length > 1`);
    await waitFor(`document.querySelector('#history-note').textContent.includes('Slow · acme/slow: 1 loaded')`);
    await evaluate(`document.querySelector('#settings-open').click(); document.querySelector('#test-access').click()`);
    await waitFor(`globalThis.__slowSignals.length > 2`);
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}); document.dispatchEvent(new Event('visibilitychange'))`);
    await waitFor(`globalThis.__slowSignals.at(-1).aborted`);
    await waitFor(`!document.querySelector('#test-access').disabled`);
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange'))`);
    await waitFor(`globalThis.__slowSignals.length > 3`);
    await evaluate(`window.confirm=()=>true; document.querySelector('#profile-delete').click()`);
    await waitFor(`globalThis.__slowSignals.at(-1).aborted`);
    await waitFor(`!document.querySelector('#run-list').textContent.includes('Slow private result')`);
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}); document.dispatchEvent(new Event('visibilitychange'))`);
    const hiddenCount = await evaluate(`globalThis.__cimRequests.length`);
    await sleep(200);
    assert.equal(await evaluate(`globalThis.__cimRequests.length`), hiddenCount);
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange'))`);
    await waitFor(`globalThis.__cimRequests.length > ${hiddenCount}`);
    assert.equal(await evaluate(`globalThis.__cimRequests.every(x=>x.url.startsWith('https://api.github.com/') && ['Bearer e2e-token','Bearer work-pat','Bearer expired-pat'].includes(x.auth))`), true);
});

test('expanded details stay text-safe and a failed-only rerun waits for a fresh attempt', { skip: !CHROME && 'Chrome not found' }, async () => {
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange')); document.querySelector('#search').value=''; document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#status-filter').value='all'; document.querySelector('#status-filter').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#profile-filter').value='all'; document.querySelector('#profile-filter').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Compile app')`);
    await evaluate(`[...document.querySelectorAll('#run-list .run-card')].find(card=>card.textContent.includes('Compile app')).querySelector('.details-toggle').click()`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Compile <script>')`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('2 of 2 jobs loaded') && document.querySelector('#run-list').textContent.includes('Package checks')`);
    assert.equal(await evaluate(`document.querySelector('#run-list script') === null`), true);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('Runner: ubuntu-latest') && document.querySelector('#run-list').textContent.includes('Checkout')`), true);
    await evaluate(`window.confirm=()=>false; [...document.querySelectorAll('#run-list .run-card')].find(card=>card.textContent.includes('Compile app')).querySelector('.rerun-controls button:nth-child(2)').click()`);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST').length`), 0);
    await evaluate(`window.confirm=()=>true`);
    await evaluate(`[...document.querySelectorAll('#run-list .run-card')].find(card=>card.textContent.includes('Compile app')).querySelector('.rerun-controls button:nth-child(2)').click(); [...document.querySelectorAll('#run-list .run-card')].find(card=>card.textContent.includes('Compile app')).querySelector('.rerun-controls button:nth-child(2)').click()`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Rerun requested')`);
    await sleep(700);
    await evaluate(`[...document.querySelectorAll('#run-list .run-card')].find(card=>card.textContent.includes('Compile app')).querySelector('.run-details .detail-heading button').click()`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('attempt 2') && document.querySelector('#run-list').textContent.includes('Compile <script>')`);
    assert.equal(await evaluate(`[...document.querySelectorAll('#run-list .run-card')].find(card=>card.textContent.includes('Compile app')).textContent.includes('failure')`), false);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.endsWith('/rerun-failed-jobs')).length`), 1);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('Rerun requested')`), false);
});
