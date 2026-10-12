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
const runtimeErrors = [];
async function waitFor(expression, timeout = 7000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        if (await evaluate(expression)) return;
        await sleep(50);
    }
    let diag = 'unavailable';
    try {
        diag = await evaluate(`(() => { const status = document.querySelector('#dispatch-status')?.textContent?.slice(0, 200) || ''; const ref = document.querySelector('#dispatch-ref')?.value || ''; const dialog = document.querySelector('#dispatch-dialog')?.open ? 'open' : 'closed'; const wf = document.querySelector('#dispatch-workflow'); const sel = wf?.selectedOptions?.[0]?.textContent?.slice(0, 120) || wf?.value || 'n/a'; const count = wf?.options?.length ?? -1; const recent = (globalThis.__cimRequests || []).slice(-5).map((x) => (x.method || 'GET') + ' ' + String(x.url).split('?')[0].replace('https://api.github.com', '')); return 'status=' + JSON.stringify(status) + ' ref=' + JSON.stringify(ref) + ' dialog=' + dialog + ' wf=' + JSON.stringify(sel) + ' wfcount=' + count + ' recent=' + JSON.stringify(recent); })()`);
    } catch { diag = 'diagnostic failed'; }
    const pageErrors = runtimeErrors.slice(-3).join(' | ') || 'none';
    throw new Error(`Timed out waiting for ${expression}; ${diag}; pageErrors=${pageErrors}`);
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
        if (message.method === 'Runtime.exceptionThrown') { const text = message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text || 'unknown page exception'; runtimeErrors.push(String(text).slice(0, 500)); console.error('CIM E2E page exception:', text); }
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
      globalThis.__workAttempt = 1;
      globalThis.__rerunHang = false;
      globalThis.__rerunDeny = false;
      globalThis.__dispatchHang = false;
      globalThis.__dispatchDenyContents = false;
      globalThis.__dispatchFlaky = false;
      globalThis.__dispatchFlakyUsed = false;
      globalThis.__dispatchRunId = 77;
      const allowedAuth = ['Bearer e2e-token','Bearer work-pat','Bearer expired-pat','Bearer e2e-rotated','Bearer work-rotated'];
      const isWorkAuth = (auth) => auth === 'Bearer work-pat' || auth === 'Bearer work-rotated';
      const isE2eAuth = (auth) => auth === 'Bearer e2e-token' || auth === 'Bearer e2e-rotated';
      globalThis.fetch = async (input, options = {}) => {
        const url = String(input), auth = options.headers?.Authorization;
        globalThis.__cimRequests.push({ url, auth, method: options.method || 'GET', body: options.body || '' });
        if (!url.startsWith('https://api.github.com/')) throw new Error('Blocked unexpected network URL');
        if (!allowedAuth.includes(auth)) throw new Error('Unexpected or missing token');
        if (auth === 'Bearer expired-pat') return new Response('{"message":"Bad credentials"}', {status:401});
        if (url.includes('/repos/acme/slow/')) { globalThis.__slowSignals.push(options.signal); await new Promise(resolve=>setTimeout(resolve,700)); return new Response(JSON.stringify({total_count:1,workflow_runs:[{id:90,name:'Slow',display_title:'Slow private result',status:'completed',conclusion:'success',created_at:'2025-01-01T00:00:00Z'}]}),{status:200,headers:{'content-type':'application/json'}}); }
        if (url.includes('/repos/acme/forbidden/')) return new Response('{"message":"Not Found"}', {status:404});
        if (url.includes('/rerun') || url.includes('/rerun-failed-jobs')) {
          if (globalThis.__rerunDeny) return new Response('{"message":"Resource not accessible"}', {status:403,headers:{'content-type':'application/json'}});
          if (globalThis.__rerunHang) { globalThis.__slowSignals.push(options.signal); await new Promise((_,reject)=>{ if (options.signal?.aborted) reject(new Error('aborted after send')); else options.signal?.addEventListener('abort',()=>reject(new Error('aborted after send')),{once:true}); }); }
          if (url.includes('/actions/runs/20/')) { setTimeout(()=>globalThis.__workAttempt++,600); return new Response(null, {status:201}); }
          if (url.includes('/actions/runs/1/')) { setTimeout(()=>globalThis.__rerunAttempt++,600); return new Response(null, {status:201}); }
          setTimeout(()=>globalThis.__rerunAttempt++,600); return new Response(null, {status:201});
        }
        if (url.endsWith('/actions/runs/20') && !url.includes('/jobs')) return new Response(JSON.stringify({id:20,run_attempt:globalThis.__workAttempt,status:'completed',conclusion:globalThis.__workAttempt === 1 ? 'action_required' : 'success',name:'Work Build',head_branch:'work',head_sha:'def456',created_at:new Date(Date.now()-86400000).toISOString()}), {status:200,headers:{'content-type':'application/json','etag':'"run-20-'+globalThis.__workAttempt+'"'}});
        if (url.includes('/actions/runs/20/') && url.includes('/jobs')) return new Response(JSON.stringify({total_count:0,jobs:[]}), {status:200,headers:{'content-type':'application/json'}});
        if (url.endsWith('/actions/runs/1') && !url.includes('/jobs')) return new Response(JSON.stringify({id:1,run_attempt:globalThis.__rerunAttempt,status:'completed',conclusion:globalThis.__rerunAttempt === 1 ? 'failure' : 'success',name:'Build',head_branch:'main',head_sha:'abc123',created_at:new Date(Date.now()-86400000).toISOString()}), {status:200,headers:{'content-type':'application/json','etag':'"run-'+globalThis.__rerunAttempt+'"'}});
        if (url.includes('/actions/runs/1/attempts/') && url.includes('/jobs')) {
          const page = Number(new URL(url).searchParams.get('page') || '1'), headers = new Headers({'content-type':'application/json'});
          if (page === 1) headers.set('Link','<https://api.github.com/repos/acme/app/actions/runs/1/attempts/'+globalThis.__rerunAttempt+'/jobs?per_page=100&page=2>; rel="next"');
          const jobs = page === 1 ? [{id:100+globalThis.__rerunAttempt,name:'Compile <script>',status:'completed',conclusion:globalThis.__rerunAttempt === 1 ? 'failure' : 'success',started_at:'2025-02-01T00:00:00Z',completed_at:'2025-02-01T00:00:30Z',runner_name:'ubuntu-latest',html_url:'https://github.com/acme/app/actions/runs/1/job/101',steps:[{name:'Checkout',status:'completed',conclusion:'success'},{name:'Build',status:'completed',conclusion:'success'}]}] : [{id:200+globalThis.__rerunAttempt,name:'Package checks',status:'completed',conclusion:'success',steps:[]}];
          return new Response(JSON.stringify({total_count:2,jobs}), {status:200,headers});
        }
        const dispatchYaml = ['name: CI','on:','  workflow_dispatch:','    inputs:','      greeting:','        description: Say hello <script>','        required: true','        type: string','        default: Hello','      flag:','        description: Enable thing','        required: true','        type: boolean','        default: false','      count:','        description: How many','        required: true','        type: number','        default: 0','      env_choice:','        description: Pick env','        type: choice','        options:','          - dev','          - prod','        default: dev','      target_env:','        description: Deploy target','        type: environment',''].join(String.fromCharCode(10));
        const otherYaml = ['name: Other','on:','  push:','    branches: [main]',''].join(String.fromCharCode(10));
        if (url.startsWith('https://api.github.com/repos/') && !url.includes('/actions') && !url.includes('/contents') && url.split('/').length === 6 && !url.includes('?')) return new Response(JSON.stringify({default_branch:'main'}), {status:200,headers:{'content-type':'application/json'}});
        if (url.includes('/actions/workflows') && (options.method || 'GET') === 'GET' && !url.includes('/dispatches')) {
          if (globalThis.__dispatchDenyContents) return new Response('{"message":"Resource not accessible"}', {status:403,headers:{'content-type':'application/json'}});
          const wpage = Number(new URL(url).searchParams.get('page') || '1');
          if (wpage === 1) { const h = new Headers({'content-type':'application/json'}); h.set('Link','<https://api.github.com/repos/acme/app/actions/workflows?per_page=100&page=2>; rel="next"'); return new Response(JSON.stringify({total_count:3,workflows:[{id:11,name:'CI',path:'.github/workflows/ci.yml',state:'active'},{id:12,name:'Disabled',path:'.github/workflows/disabled.yml',state:'disabled_active'}]}), {status:200,headers:h}); }
          return new Response(JSON.stringify({total_count:3,workflows:[{id:13,name:'Other',path:'.github/workflows/other.yml',state:'active'}]}), {status:200,headers:{'content-type':'application/json'}});
        }
        if (url.includes('/contents/.github/workflows/')) {
          if (globalThis.__dispatchDenyContents) return new Response('{"message":"Resource not accessible"}', {status:403,headers:{'content-type':'application/json'}});
          const ref = new URL(url).searchParams.get('ref') || 'main';
          if (ref === 'slow-branch') { globalThis.__slowSignals.push(options.signal); await new Promise(resolve=>setTimeout(resolve,700)); }
          const isOther = url.includes('/other.yml');
          const yaml = isOther ? otherYaml : dispatchYaml;
          const b64 = btoa(yaml);
          return new Response(JSON.stringify({type:'file',encoding:'base64',content:b64.slice(0,60)+String.fromCharCode(10)+b64.slice(60),size:yaml.length,path: isOther ? '.github/workflows/other.yml' : '.github/workflows/ci.yml'}), {status:200,headers:{'content-type':'application/json'}});
        }
        if (url.includes('/dispatches') && (options.method || 'GET') === 'POST') {
          if (globalThis.__dispatchHang) { globalThis.__slowSignals.push(options.signal); await new Promise((_,reject)=>{ if (options.signal?.aborted) reject(new Error('aborted after send')); else options.signal?.addEventListener('abort',()=>reject(new Error('aborted after send')),{once:true}); }); }
          const id = globalThis.__dispatchRunId;
          return new Response(JSON.stringify({workflow_run_id:id,run_url:'https://api.github.com/repos/acme/app/actions/runs/'+id,html_url:'https://github.com/acme/app/actions/runs/'+id}), {status:200,headers:{'content-type':'application/json'}});
        }
        if (url.endsWith('/actions/runs/77') && !url.includes('/jobs')) {
          if (globalThis.__dispatchRunId === 77 && globalThis.__dispatchFlaky && !globalThis.__dispatchFlakyUsed) { globalThis.__dispatchFlakyUsed = true; return new Response('{"message":"Not Found"}', {status:404,headers:{'content-type':'application/json'}}); }
          return new Response(JSON.stringify({id:77,run_attempt:1,status:'queued',conclusion:null,name:'CI',display_title:'Dispatched CI',head_branch:'main',head_sha:'abc123',event:'workflow_dispatch',actor:{login:'alice'},created_at:new Date().toISOString(),updated_at:new Date().toISOString(),html_url:'https://github.com/acme/app/actions/runs/77'}), {status:200,headers:{'content-type':'application/json','etag':'"dispatch-77"'}});
        }
        if (url.includes('/actions/runs/77/') && url.includes('/jobs')) return new Response(JSON.stringify({total_count:0,jobs:[]}), {status:200,headers:{'content-type':'application/json'}});
        const pinId = Number(globalThis.__dispatchRunId);
        if (pinId !== 77 && url.endsWith('/actions/runs/' + pinId) && !url.includes('/jobs')) {
          if (globalThis.__dispatchFlaky && !globalThis.__dispatchFlakyUsed) { globalThis.__dispatchFlakyUsed = true; return new Response('{"message":"Not Found"}', {status:404,headers:{'content-type':'application/json'}}); }
          return new Response(JSON.stringify({id:pinId,run_attempt:1,status:'queued',conclusion:null,name:'CI',display_title:'Dispatched CI',head_branch:'main',head_sha:'abc123',event:'workflow_dispatch',actor:{login:'alice'},created_at:new Date().toISOString(),updated_at:new Date().toISOString(),html_url:'https://github.com/acme/app/actions/runs/' + pinId}), {status:200,headers:{'content-type':'application/json','etag':'"dispatch-' + pinId + '"'}});
        }
        if (pinId !== 77 && url.includes('/actions/runs/' + pinId + '/') && url.includes('/jobs')) return new Response(JSON.stringify({total_count:0,jobs:[]}), {status:200,headers:{'content-type':'application/json'}});
         const page = Number(new URL(url).searchParams.get('page') || '1');
         if (page === 4) { globalThis.__slowSignals.push(options.signal); await new Promise(resolve=>setTimeout(resolve,700)); }
         const runId = isWorkAuth(auth) ? 20 : page + 2;
         const runs = page > 1 ? [{id:runId,name:'Deploy',display_title:'Older page '+page,head_branch:'main',status:'completed',conclusion:page===2?'success':'cancelled',run_number:runId,run_attempt:1,event:'push',actor:{login:'ci'},created_at:'2025-01-01T00:00:00Z',updated_at:'2025-01-01T00:01:00Z',html_url:'https://github.com/acme/app/actions/runs/'+runId}] : isWorkAuth(auth) ? [{id:20,name:'Work Build',display_title:'Work-only result',head_branch:'work',status:'completed',conclusion:'action_required',run_number:20,run_attempt:1,event:'push',actor:{login:'worker'},created_at:'2025-03-01T00:00:00Z',updated_at:'2025-03-01T00:01:00Z',html_url:'https://github.com/acme/app/actions/runs/20'}] : [
          {id:1,name:'Build',display_title:'Compile app',head_branch:'main',status:'completed',conclusion:'success',run_number:12,run_attempt:1,event:'push',actor:{login:'alice'},created_at:'2025-02-01T00:00:00Z',updated_at:'2025-02-01T00:02:00Z',run_started_at:'2025-02-01T00:00:00Z',html_url:'https://github.com/acme/app/actions/runs/1'},
          {id:2,name:'Deploy',display_title:'Deploy to preview',head_branch:'feature/demo',status:'in_progress',conclusion:null,run_number:13,run_attempt:2,event:'workflow_dispatch',actor:{login:'bob'},created_at:'2025-02-02T00:00:00Z',updated_at:'2025-02-02T00:01:00Z',html_url:'https://evil.example/steal'}
        ];
        const headers = new Headers({'content-type':'application/json','etag':'"fixture"'});
         if (page < 4 && isE2eAuth(auth)) headers.set('Link', '<https://api.github.com/repos/acme/app/actions/runs?per_page=30&page='+(page+1)+'>; rel="next"');
        if (options.headers?.['If-None-Match']) return new Response(null, {status:304,headers});
        return new Response(JSON.stringify({total_count:3,workflow_runs:runs}), {status:200,headers});
      };
    })()`;
    await send('Page.addScriptToEvaluateOnNewDocument', { source: mock }, pageSession);
    await send('Page.navigate', { url: `chrome-extension://${extensionId}/dashboard.html` }, pageSession);
});

after(async () => {
    if (runtimeErrors.length) console.error('CIM E2E unexpected page exceptions:', runtimeErrors.slice(0, 5));
    if (!CHROME) { if (runtimeErrors.length) throw new Error('Unexpected page exceptions: ' + runtimeErrors.slice(0, 3).join(' | ')); return; }
    if (chrome && chrome.exitCode === null) {
        const exited = new Promise((resolve) => chrome.once('exit', resolve));
        if (ws?.readyState === WebSocket.OPEN) send('Browser.close'); else chrome.kill();
        const killer = setTimeout(() => chrome.kill('SIGKILL'), 5000);
        await exited; clearTimeout(killer);
    }
    ws?.close();
    if (runtimeErrors.length) throw new Error('Unexpected page exceptions: ' + runtimeErrors.slice(0, 3).join(' | '));
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

test('aborted sent POST stays uncertain with a single request until acknowledged', { skip: !CHROME && 'Chrome not found' }, async () => {
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange')); document.querySelector('#search').value=''; document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#profile-filter').value='all'; document.querySelector('#profile-filter').dispatchEvent(new Event('change',{bubbles:true})); window.confirm=()=>true; globalThis.__rerunHang=false; globalThis.__rerunDeny=false;`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Compile app')`);
    await evaluate(`var cardA=[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')); var tA=cardA?.querySelector('.details-toggle'); if(tA&&tA.textContent.includes('Show')) tA.click();`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Compile <script>')`);
    const before = await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST').length`);
    await evaluate(`globalThis.__rerunHang=true; window.confirm=()=>true; [...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')).querySelector('.rerun-controls button').click();`);
    await waitFor(`globalThis.__cimRequests.filter(x=>x.method==='POST').length > ${before}`);
    const during = await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST').length`);
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}); document.dispatchEvent(new Event('visibilitychange'))`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('may have been accepted')`);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('Rerun uncertain')`), true);
    assert.equal(await evaluate(`[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')).querySelectorAll('.rerun-controls button')[0].disabled && [...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')).querySelectorAll('.rerun-controls button')[1].disabled`), true);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST').length`), during);
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange'))`);
    await sleep(500);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST').length`), during);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('may have been accepted')`), true);
    await evaluate(`globalThis.__rerunHang=false; [...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')).querySelectorAll('.rerun-controls button'); [...document.querySelectorAll('.rerun-controls button')].find(b=>b.textContent.includes('I checked GitHub')).click();`);
    await waitFor(`!document.querySelector('#run-list').textContent.includes('may have been accepted')`);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST').length`), during);
    assert.equal(await evaluate(`[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')).querySelector('.rerun-controls button').disabled`), false);
});

test('queued rerun hidden before send leaves no request and no pending', { skip: !CHROME && 'Chrome not found' }, async () => {
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange')); window.confirm=()=>true; globalThis.__rerunHang=false; globalThis.__rerunDeny=true;`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Compile app')`);
    await evaluate(`var cardB=[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')); var tB=cardB?.querySelector('.details-toggle'); if(tB&&tB.textContent.includes('Show')) tB.click();`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Re-run all jobs')`);
    await evaluate(`window.confirm=()=>true; [...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')).querySelector('.rerun-controls button').click();`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Actions: write')`);
    const afterDeny = await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST').length`);
    await evaluate(`globalThis.__rerunDeny=false; window.confirm=()=>true; var cardC=[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')); cardC.querySelector('.rerun-controls button').click(); Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}); document.dispatchEvent(new Event('visibilitychange'));`);
    await sleep(500);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST').length`), afterDeny);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('may have been accepted')`), false);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('Rerun requested')`), false);
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange'))`);
    await sleep(400);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST').length`), afterDeny);
    assert.equal(await evaluate(`[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')).querySelector('.rerun-controls button').disabled`), false);
});

test('replacing a PAT clears only that profile pending and allows a fresh rerun', { skip: !CHROME && 'Chrome not found' }, async () => {
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange')); document.querySelector('#search').value=''; document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#profile-filter').value='all'; document.querySelector('#profile-filter').dispatchEvent(new Event('change',{bubbles:true})); window.confirm=()=>true; globalThis.__rerunHang=false; globalThis.__rerunDeny=false;`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Compile app') && document.querySelector('#run-list').textContent.includes('Work-only result')`);
    await evaluate(`for (var textD of ['Compile app','Work-only result']) { var cardD=[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes(textD)); var tD=cardD?.querySelector('.details-toggle'); if(tD&&tD.textContent.includes('Show')) tD.click(); }`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Re-run all jobs')`);
    const postBase = await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST').length`);
    await evaluate(`window.confirm=()=>true; [...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')).querySelector('.rerun-controls button').click();`);
    await waitFor(`[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')).textContent.includes('Rerun requested')`);
    await evaluate(`window.confirm=()=>true; [...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Work-only result')).querySelector('.rerun-controls button').click();`);
    await waitFor(`[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Work-only result')).textContent.includes('Rerun requested')`);
    const bothPending = await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST').length`);
    assert.equal(bothPending, postBase + 2);
    const personalId = await evaluate(`[...document.querySelector('#profile-filter').options].find(o=>o.text==='Personal').value`);
    await evaluate(`document.querySelector('#settings-open').click(); document.querySelector('#profile-select').value='${personalId}'; document.querySelector('#profile-select').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(`document.querySelector('#settings-dialog').open && document.querySelector('#profile-name').value.includes('Personal')`);
    await evaluate(`document.querySelector('#token').value='e2e-rotated'; document.querySelector('#settings-form').requestSubmit()`);
    await waitFor(`globalThis.__cimRequests.some(x=>x.auth==='Bearer e2e-rotated')`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Compile app')`);
    await evaluate(`var cardE=[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')); var tE=cardE?.querySelector('.details-toggle'); if(tE&&tE.textContent.includes('Show')) tE.click();`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Compile <script>') || document.querySelector('#run-list').textContent.includes('2 of 2 jobs loaded') || document.querySelector('#run-list').textContent.includes('No jobs') || document.querySelector('#run-list').textContent.includes('Re-run all jobs')`);
    assert.equal(await evaluate(`[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')).textContent.includes('Rerun requested')`), false);
    assert.equal(await evaluate(`[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')).querySelector('.rerun-controls button').disabled`), false);
    assert.equal(await evaluate(`[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Work-only result')).textContent.includes('Rerun requested')`), true);
    const beforeFresh = await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST').length`);
    await evaluate(`window.confirm=()=>true; [...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')).querySelector('.rerun-controls button').click();`);
    await waitFor(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.auth==='Bearer e2e-rotated').length > 0`);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST').length`), beforeFresh + 1);
    assert.equal(await evaluate(`[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')).textContent.includes('Rerun requested')`), true);
    assert.equal(await evaluate(`[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Work-only result')).textContent.includes('Rerun requested')`), true);
});

test('new run loads schema defaults validates and pins the exact returned run', { skip: !CHROME && 'Chrome not found' }, async () => {
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange')); window.confirm=()=>true; globalThis.__dispatchHang=false; globalThis.__dispatchDenyContents=false;`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Compile app')`);
    await evaluate(`document.querySelector('#new-run').click()`);
    await waitFor(`document.querySelector('#dispatch-dialog').open`);
    await evaluate(`document.querySelector('#dispatch-profile').value=[...document.querySelector('#dispatch-profile').options].find(o=>o.text.startsWith('Personal')).value; document.querySelector('#dispatch-profile').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(`document.querySelector('#dispatch-workflow').options.length >= 3`);
    assert.equal(await evaluate(`document.querySelector('#dispatch-ref').value`), 'main');
    assert.equal(await evaluate(`[...document.querySelector('#dispatch-workflow').options].some(o=>o.text.includes('cannot start'))`), true);
    await waitFor(`document.querySelector('#dispatch-inputs').textContent.includes('greeting')`);
    assert.equal(await evaluate(`document.querySelector('#dispatch-inputs [name=greeting]').value`), 'Hello');
    assert.equal(await evaluate(`document.querySelector('#dispatch-inputs [name=greeting]').tagName`), 'TEXTAREA');
    assert.equal(await evaluate(`document.querySelector('#dispatch-inputs input[name=flag]').checked`), false);
    assert.equal(await evaluate(`document.querySelector('#dispatch-inputs input[name=count]').value`), '0');
    assert.equal(await evaluate(`document.querySelector('#dispatch-inputs select[name=env_choice]').value`), 'dev');
    assert.equal(await evaluate(`document.querySelector('#dispatch-inputs').textContent.includes('<script>')`), true);
    assert.equal(await evaluate(`document.querySelector('#dispatch-inputs script') === null`), true);
    const postBase = await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length`);
    await evaluate(`document.querySelector('#dispatch-inputs [name=greeting]').value=''; document.querySelector('#dispatch-form').requestSubmit()`);
    await waitFor(`document.querySelector('#dispatch-status').textContent.includes('Fix the highlighted')`);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length`), postBase);
    await evaluate(`document.querySelector('#dispatch-inputs [name=greeting]').value='hi'; document.querySelector('#dispatch-inputs input[name=count]').value='not-a-number'; document.querySelector('#dispatch-form').requestSubmit()`);
    await waitFor(`document.querySelector('#dispatch-status').textContent.includes('Fix the highlighted')`);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length`), postBase);
    await evaluate(`document.querySelector('#dispatch-inputs [name=greeting]').value='hi'+String.fromCharCode(10)+'there'; document.querySelector('#dispatch-inputs input[name=count]').value='2'; window.confirm=()=>true; document.querySelector('#dispatch-form').requestSubmit(); document.querySelector('#dispatch-form').requestSubmit()`);
    await waitFor(`document.querySelector('#dispatch-result').textContent.includes('Open run 77')`);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length`), postBase + 1);
    assert.equal(await evaluate(`JSON.parse(globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).at(-1).body).inputs.greeting`), 'hi\nthere');
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).every(x=>x.auth==='Bearer e2e-rotated')`), true);
    assert.equal(await evaluate(`document.querySelector('#dispatch-result a').href`), 'https://github.com/acme/app/actions/runs/77');
    await waitFor(`document.querySelector('#run-list').textContent.includes('Dispatched CI')`);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('Dispatched CI')`), true);
    await evaluate(`document.querySelector('#dispatch-close').click()`);
});

test('stale workflow loads never restore and non-dispatchable workflows cannot start', { skip: !CHROME && 'Chrome not found' }, async () => {
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange')); window.confirm=()=>true; document.querySelector('#new-run').click()`);
    await waitFor(`document.querySelector('#dispatch-dialog').open`);
    await evaluate(`document.querySelector('#dispatch-profile').value=[...document.querySelector('#dispatch-profile').options].find(o=>o.text.startsWith('Personal')).value; document.querySelector('#dispatch-profile').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(`document.querySelector('#dispatch-workflow').options.length >= 3`);
    await evaluate(`document.querySelector('#dispatch-ref').value='slow-branch'; document.querySelector('#dispatch-load').click()`);
    await evaluate(`document.querySelector('#dispatch-workflow').value=[...document.querySelector('#dispatch-workflow').options].find(o=>o.text.startsWith('Other')).value; document.querySelector('#dispatch-workflow').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(`document.querySelector('#dispatch-status').textContent.includes('does not run manually')`);
    assert.equal(await evaluate(`document.querySelector('#dispatch-inputs').children.length`), 0);
    assert.equal(await evaluate(`document.querySelector('#dispatch-start').disabled`), true);
    assert.equal(await evaluate(`document.querySelector('#dispatch-inputs').textContent.includes('greeting')`), false);
    await evaluate(`document.querySelector('#dispatch-close').click()`);
});

test('uncertain dispatch gates retry until acknowledged and unrelated profiles stay usable', { skip: !CHROME && 'Chrome not found' }, async () => {
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange')); window.confirm=()=>true; globalThis.__dispatchHang=true; document.querySelector('#new-run').click()`);
    await waitFor(`document.querySelector('#dispatch-dialog').open`);
    await evaluate(`document.querySelector('#dispatch-profile').value=[...document.querySelector('#dispatch-profile').options].find(o=>o.text.startsWith('Personal')).value; document.querySelector('#dispatch-profile').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(`document.querySelector('#dispatch-inputs').textContent.includes('greeting')`);
    const before = await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length`);
    await evaluate(`window.confirm=()=>true; document.querySelector('#dispatch-form').requestSubmit()`);
    await waitFor(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length > ${before}`);
    const during = await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length`);
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}); document.dispatchEvent(new Event('visibilitychange'))`);
    await waitFor(`document.querySelector('#dispatch-status').textContent.includes('may have been accepted')`);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length`), during);
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange'))`);
    await sleep(400);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length`), during);
    await evaluate(`globalThis.__dispatchHang=false; document.querySelector('#dispatch-form').requestSubmit()`);
    await sleep(300);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length`), during);
    await evaluate(`[...document.querySelectorAll('#dispatch-result button')].find(b=>b.textContent.includes('I checked GitHub')).click()`);
    await waitFor(`document.querySelector('#dispatch-inputs').textContent.includes('greeting')`);
    await evaluate(`window.confirm=()=>true; document.querySelector('#dispatch-form').requestSubmit()`);
    await waitFor(`document.querySelector('#dispatch-result').textContent.includes('Open run 77')`);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length`), during + 1);
    await evaluate(`document.querySelector('#dispatch-close').click()`);
    assert.equal(await evaluate(`globalThis.__cimRequests.some(x=>x.auth==='Bearer work-rotated' || x.auth==='Bearer work-pat')`), true);
});

test('uncertain dispatch survives dialog close and reopen with ack gate', { skip: !CHROME && 'Chrome not found' }, async () => {
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange')); window.confirm=()=>true; globalThis.__dispatchHang=true; globalThis.__dispatchFlaky=false; document.querySelector('#new-run').click()`);
    await waitFor(`document.querySelector('#dispatch-dialog').open`);
    await evaluate(`document.querySelector('#dispatch-profile').value=[...document.querySelector('#dispatch-profile').options].find(o=>o.text.startsWith('Personal')).value; document.querySelector('#dispatch-profile').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(`document.querySelector('#dispatch-inputs').textContent.includes('greeting')`);
    const before = await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length`);
    await evaluate(`window.confirm=()=>true; document.querySelector('#dispatch-form').requestSubmit()`);
    await waitFor(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length > ${before}`);
    const during = await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length`);
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}); document.dispatchEvent(new Event('visibilitychange'))`);
    await waitFor(`document.querySelector('#dispatch-status').textContent.includes('may have been accepted')`);
    await evaluate(`document.querySelector('#dispatch-close').click()`);
    await waitFor(`!document.querySelector('#dispatch-dialog').open`);
    await evaluate(`globalThis.__dispatchHang=false; Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange')); document.querySelector('#new-run').click()`);
    await waitFor(`document.querySelector('#dispatch-dialog').open`);
    await waitFor(`document.querySelector('#dispatch-workflow').options.length >= 3`);
    await evaluate(`document.querySelector('#dispatch-load').click()`);
    await waitFor(`document.querySelector('#dispatch-status').textContent.includes('may have been accepted')`);
    assert.equal(await evaluate(`[...document.querySelectorAll('#dispatch-result button')].some(b=>b.textContent.includes('I checked GitHub'))`), true);
    assert.equal(await evaluate(`document.querySelector('#dispatch-start').disabled`), true);
    await evaluate(`window.confirm=()=>true; document.querySelector('#dispatch-form').requestSubmit()`);
    await sleep(300);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length`), during);
    await evaluate(`[...document.querySelectorAll('#dispatch-result button')].find(b=>b.textContent.includes('I checked GitHub')).click()`);
    await waitFor(`document.querySelector('#dispatch-inputs').textContent.includes('greeting')`);
    await evaluate(`window.confirm=()=>true; document.querySelector('#dispatch-form').requestSubmit()`);
    await waitFor(`document.querySelector('#dispatch-result').textContent.includes('Open run 77')`);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length`), during + 1);
    await evaluate(`document.querySelector('#dispatch-close').click()`);
});

test('dialog close and immediate reopen keeps loading alive', { skip: !CHROME && 'Chrome not found' }, async () => {
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange')); window.confirm=()=>true; globalThis.__dispatchHang=false; globalThis.__dispatchFlaky=false; document.querySelector('#new-run').click()`);
    await waitFor(`document.querySelector('#dispatch-dialog').open`);
    await evaluate(`document.querySelector('#dispatch-profile').value=[...document.querySelector('#dispatch-profile').options].find(o=>o.text.startsWith('Personal')).value; document.querySelector('#dispatch-profile').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(`document.querySelector('#dispatch-workflow').options.length >= 3`);
    await evaluate(`document.querySelector('#dispatch-close').click(); document.querySelector('#new-run').click();`);
    await waitFor(`document.querySelector('#dispatch-dialog').open`);
    await waitFor(`document.querySelector('#dispatch-inputs').textContent.includes('greeting')`);
    assert.equal(await evaluate(`document.querySelector('#dispatch-start').disabled`), false);
    assert.equal(runtimeErrors.length, 0);
    await evaluate(`document.querySelector('#dispatch-close').click()`);
});

test('fresh pin 404 stays transient queued without suspending the repository', { skip: !CHROME && 'Chrome not found' }, async () => {
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange')); window.confirm=()=>true; globalThis.__dispatchHang=false; globalThis.__dispatchRunId=79; globalThis.__dispatchFlaky=true; globalThis.__dispatchFlakyUsed=false; document.querySelector('#new-run').click()`);
    await waitFor(`document.querySelector('#dispatch-dialog').open`);
    await evaluate(`document.querySelector('#dispatch-profile').value=[...document.querySelector('#dispatch-profile').options].find(o=>o.text.startsWith('Personal')).value; document.querySelector('#dispatch-profile').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(`document.querySelector('#dispatch-workflow').options.length >= 3`);
    await evaluate(`document.querySelector('#dispatch-load').click()`);
    await waitFor(`document.querySelector('#dispatch-inputs').textContent.includes('greeting')`);
    await evaluate(`window.confirm=()=>true; document.querySelector('#dispatch-form').requestSubmit()`);
    await waitFor(`document.querySelector('#dispatch-result').textContent.includes('Open run 79')`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Dispatched CI')`, 10000);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('Compile app')`), true);
    await sleep(1200);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('Dispatched CI')`), true);
    assert.equal(await evaluate(`globalThis.__dispatchFlakyUsed`), true);
    assert.equal(await evaluate(`globalThis.__cimRequests.some(x=>x.url.endsWith('/actions/runs/79') && x.method==='GET')`), true);
    await evaluate(`globalThis.__dispatchFlaky=false; globalThis.__dispatchRunId=77; document.querySelector('#dispatch-close').click()`);
});

test('storage repo removal during schema load never restores stale dispatch data', { skip: !CHROME && 'Chrome not found' }, async () => {
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange')); window.confirm=()=>true; globalThis.__dispatchHang=false; globalThis.__dispatchFlaky=false; document.querySelector('#new-run').click()`);
    await waitFor(`document.querySelector('#dispatch-dialog').open`);
    await evaluate(`document.querySelector('#dispatch-profile').value=[...document.querySelector('#dispatch-profile').options].find(o=>o.text.startsWith('Personal')).value; document.querySelector('#dispatch-profile').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(`document.querySelector('#dispatch-workflow').options.length >= 3`);
    const postBase = await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length`);
    await evaluate(`document.querySelector('#dispatch-ref').value='slow-branch'; document.querySelector('#dispatch-load').click()`);
    await evaluate(`(async () => { const id=[...document.querySelector('#dispatch-profile').options].find(o=>o.text.startsWith('Personal')).value; const key='cimProfile:'+id; const stored=(await chrome.storage.local.get(key))[key]; await chrome.storage.local.set({[key]:{...stored,repos:['acme/forbidden']}}); })()`);
    await sleep(1200);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length`), postBase);
    assert.equal(await evaluate(`document.querySelector('#dispatch-inputs').children.length`), 0);
    assert.equal(await evaluate(`document.querySelector('#dispatch-start').disabled`), true);
    assert.equal(await evaluate(`[...document.querySelector('#dispatch-profile').options].some(o=>o.text.startsWith('Work'))`), true);
    await evaluate(`document.querySelector('#dispatch-close').click()`);
});
