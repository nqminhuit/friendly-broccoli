import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = [process.env.CHROME, '/opt/google/chrome/chrome', '/usr/bin/google-chrome'].find((item) => item && fs.existsSync(item));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let chrome, ws, profile, pageSession, workerSession, extensionId, nextId = 0;
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
async function evaluateWorker(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, workerSession);
    if (result.result.exceptionDetails) throw new Error(result.result.exceptionDetails.exception.description);
    return result.result.result.value;
}
// Safe platform diagnostics for failures: versions and context counts only, never PATs.
async function platformInfo() {
    try {
        const ua = await evaluate(`navigator.userAgent`);
        const contexts = await evaluate(`chrome.runtime.getContexts({contextTypes:['TAB'], documentUrls:[chrome.runtime.getURL('dashboard.html')]}).then(list=>list.length).catch(error=>String(error && error.message || error))`);
        let product = 'unknown';
        try { product = (await send('Browser.getVersion')).result.product; } catch { /* Keep ua fallback. */ }
        return `node=${process.version} chrome=${product} ua=${ua} dashboardContexts=${contexts} extension=${extensionId}`;
    } catch (error) { return `diagnostic failed: ${error.message}`; }
}
const runtimeErrors = [];
const FILTERS_KEY = 'cim.filters';
const statusMenuScript = (mode, statuses) => `(() => { const menu = document.querySelector('#status-menu'); menu.querySelector('input[name=status-mode][value=${mode}]').checked = true; menu.querySelectorAll('input[type=checkbox]').forEach((i) => { i.checked = ${JSON.stringify(statuses)}.includes(i.value); }); menu.dispatchEvent(new Event('change', {bubbles: true})); })();`;
const setStatusMenu = (mode, statuses) => evaluate(statusMenuScript(mode, statuses));
const statusSummary = () => evaluate(`document.querySelector('#status-menu summary').textContent`);
const runListText = () => evaluate(`document.querySelector('#run-list').textContent`);

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
      globalThis.__cancelMode = 'ok';
      globalThis.__run2Done = false;
      globalThis.__dispatchHang = false;
      globalThis.__dispatchDenyContents = false;
      globalThis.__dispatchFlaky = false;
      globalThis.__dispatchFlakyUsed = false;
      globalThis.__dispatchRunId = 77;
      const allowedAuth = ['Bearer e2e-token','Bearer work-pat','Bearer expired-pat','Bearer e2e-rotated','Bearer work-rotated'];
      const isWorkAuth = (auth) => auth === 'Bearer work-pat' || auth === 'Bearer work-rotated';
      const isE2eAuth = (auth) => auth === 'Bearer e2e-token' || auth === 'Bearer e2e-rotated';
      globalThis.fetch = async function (input, options = {}) {
        if (this !== globalThis) throw new TypeError('Illegal invocation');
        const url = String(input), auth = options.headers?.Authorization;
        globalThis.__cimRequests.push({ url, auth, method: options.method || 'GET', body: options.body || '' });
        if (!url.startsWith('https://api.github.com/')) throw new Error('Blocked unexpected network URL');
        if (!allowedAuth.includes(auth)) throw new Error('Unexpected or missing token');
        if (auth === 'Bearer expired-pat') return new Response('{"message":"Bad credentials"}', {status:401});
        if (url.includes('/repos/acme/slow/')) { globalThis.__slowSignals.push(options.signal); await new Promise(resolve=>setTimeout(resolve,700)); return new Response(JSON.stringify({total_count:1,workflow_runs:[{id:90,name:'Slow',display_title:'Slow private result',status:'completed',conclusion:'success',created_at:'2025-01-01T00:00:00Z'}]}),{status:200,headers:{'content-type':'application/json'}}); }
        if (url.includes('/repos/acme/forbidden/')) return new Response('{"message":"Not Found"}', {status:404});
        if (url.endsWith('/cancel') && options.method === 'POST') {
          if (globalThis.__cancelMode === 'conflict') return new Response('{"message":"Cannot cancel a workflow run that is completed."}', {status:409,headers:{'content-type':'application/json'}});
          return new Response('{}', {status:202,headers:{'content-type':'application/json'}});
        }
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
          const jobs = page === 1 ? [{id:100+globalThis.__rerunAttempt,name:'Compile <script>',status:'completed',conclusion:globalThis.__rerunAttempt === 1 ? 'failure' : 'success',started_at:'2025-02-01T00:00:00Z',completed_at:'2025-02-01T00:00:30Z',runner_name:'ubuntu-latest',html_url:'https://github.com/acme/app/actions/runs/1/job/101',steps:[{name:'Checkout',status:'completed',conclusion:'success',started_at:'2025-02-01T00:00:00Z',completed_at:'2025-02-01T00:00:05Z'},{name:'Build the deliberately long-named artifact',status:'completed',conclusion:'success'},{name:'Lint',status:'completed',conclusion:'skipped'}]}] : [{id:200+globalThis.__rerunAttempt,name:'Package checks',status:'completed',conclusion:'success',steps:[]}];
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
          {id:2,name:'Deploy',display_title:'Deploy to preview',head_branch:'feature/demo',status:globalThis.__run2Done ? 'completed' : 'in_progress',conclusion:globalThis.__run2Done ? 'cancelled' : null,run_number:13,run_attempt:2,event:'workflow_dispatch',actor:{login:'bob'},created_at:'2025-02-02T00:00:00Z',updated_at:'2025-02-02T00:01:00Z',html_url:'https://evil.example/steal'}
        ];
        const headers = new Headers({'content-type':'application/json','etag':globalThis.__run2Done ? '"fixture-done"' : '"fixture"'});
         if (page < 4 && isE2eAuth(auth)) headers.set('Link', '<https://api.github.com/repos/acme/app/actions/runs?per_page=30&page='+(page+1)+'>; rel="next"');
        if (options.headers?.['If-None-Match'] && !globalThis.__run2Done) return new Response(null, {status:304,headers});
        return new Response(JSON.stringify({total_count:3,workflow_runs:runs}), {status:200,headers});
      };
    })()`;
    await send('Page.addScriptToEvaluateOnNewDocument', { source: mock }, pageSession);
    await send('Page.navigate', { url: `chrome-extension://${extensionId}/dashboard.html` }, pageSession);
    try {
        for (let attempt = 0; attempt < 20 && !workerSession; attempt++) {
            const targets = (await send('Target.getTargets')).result.targetInfos || [];
            const worker = targets.find((entry) => entry.type === 'service_worker' && String(entry.url || '').startsWith(`chrome-extension://${extensionId}/`));
            if (worker) {
                workerSession = (await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })).result.sessionId;
                await send('Runtime.enable', {}, workerSession);
            } else await sleep(200);
        }
    } catch { workerSession = null; }
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

test('dashboard favicon loads from the extension without external resources', { skip: !CHROME && 'Chrome not found' }, async () => {
    await waitFor(`document.readyState === 'complete'`);
    const icon = await evaluate(`(async () => {
        const link = document.querySelector('link[rel~="icon"]');
        if (!link) return null;
        const image = new Image(); image.src = link.href; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let foregroundPixels = 0;
        for (let index = 0; index < pixels.length; index += 4) if (pixels[index] === 255 && pixels[index + 1] === 255 && pixels[index + 2] === 255 && pixels[index + 3] === 255) foregroundPixels++;
        return {url:link.href,expectedUrl:chrome.runtime.getURL('favicon.svg'),type:link.type,width:image.naturalWidth,height:image.naturalHeight,foregroundPixels};
    })()`);
    assert.ok(icon, 'dashboard declares a favicon');
    assert.equal(icon.url, icon.expectedUrl);
    assert.equal(icon.type, 'image/svg+xml');
    assert.deepEqual([icon.width, icon.height], [64, 64]);
    assert.ok(icon.foregroundPixels > 100, 'favicon renders a visible white glyph');
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
    await evaluate(`document.querySelector('#profile-filter').value='all'; document.querySelector('#profile-filter').dispatchEvent(new Event('change',{bubbles:true}))`);
    await setStatusMenu('show', ['action_required']);
    assert.equal(await evaluate(`(()=>{const t=document.querySelector('#run-list').textContent; return t.includes('Work-only result') && !t.includes('Compile app') && !t.includes('Deploy to preview')})()`), true);
    assert.equal(await statusSummary(), 'Show: Action required');
    await setStatusMenu('show', ['active', 'action_required']);
    assert.equal(await evaluate(`(()=>{const t=document.querySelector('#run-list').textContent; return t.includes('Work-only result') && t.includes('Deploy to preview') && !t.includes('Compile app')})()`), true);
    assert.equal(await statusSummary(), 'Show: Active, Action required');
    await setStatusMenu('hide', ['active', 'action_required']);
    assert.equal(await evaluate(`(()=>{const t=document.querySelector('#run-list').textContent; return !t.includes('Work-only result') && !t.includes('Deploy to preview') && t.includes('Compile app')})()`), true);
    assert.equal(await statusSummary(), 'Hide: Active, Action required');
    await setStatusMenu('hide', ['active', 'success', 'failure']);
    assert.equal(await statusSummary(), 'Hide 3 statuses');
    await setStatusMenu('show', ['success', 'failure', 'skipped']);
    assert.equal(await statusSummary(), 'Show 3 statuses');
    for (const mode of ['show', 'hide']) {
        await setStatusMenu(mode, []);
        assert.equal(await evaluate(`(()=>{const t=document.querySelector('#run-list').textContent; return t.includes('Work-only result') && t.includes('Deploy to preview') && t.includes('Compile app')})()`), true);
        assert.equal(await statusSummary(), 'All statuses');
    }
    await evaluate(`document.querySelector('#profile-new').click(); document.querySelector('#profile-name').value='Expired'; document.querySelector('#repositories').value='acme/app'; document.querySelector('#token').value='expired-pat'; document.querySelector('#settings-form').requestSubmit()`);
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

test('filters except search are remembered across reloads and never leak into other tests', { skip: !CHROME && 'Chrome not found' }, async () => {
    const setSelect = (id, value) => evaluate(`(() => { const s = document.querySelector('${id}'); s.value = [...s.options].find((o) => o.value === ${JSON.stringify(value)} || o.text === ${JSON.stringify(value)}).value; s.dispatchEvent(new Event('change', {bubbles: true})); })()`);
    const resetFilters = async () => {
        await evaluate(`document.querySelector('#search').value=''; document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}))`);
        for (const id of ['#profile-filter', '#repo-filter', '#workflow-filter', '#branch-filter']) await setSelect(id, 'all');
        await setStatusMenu('show', []);
        await evaluate(`localStorage.removeItem(${JSON.stringify(FILTERS_KEY)})`);
    };
    try {
        await resetFilters();
        await setSelect('#profile-filter', 'Personal');
        await setSelect('#repo-filter', 'acme/app');
        await setSelect('#workflow-filter', 'Deploy');
        await setSelect('#branch-filter', 'feature/demo');
        await setStatusMenu('show', ['active', 'failure']);
        await evaluate(`document.querySelector('#search').value='preview'; document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}))`);
        const stored = JSON.parse(await evaluate(`localStorage.getItem(${JSON.stringify(FILTERS_KEY)})`));
        assert.equal(stored.repo, 'acme/app');
        assert.deepEqual(stored.statuses.sort(), ['active', 'failure']);
        assert.equal(JSON.stringify(stored).includes('preview'), false);
        await send('Page.reload', {}, pageSession);
        await waitFor(`document.querySelector('#run-list').textContent.includes('Deploy to preview')`);
        assert.equal(await evaluate(`(() => { const v = (id) => document.querySelector(id).selectedOptions[0].text; return [v('#profile-filter'), v('#repo-filter'), v('#workflow-filter'), v('#branch-filter'), document.querySelector('#search').value].join('|'); })()`), 'Personal|acme/app|Deploy|feature/demo|');
        assert.equal(await statusSummary(), 'Show: Active, Failure');
        assert.equal(await evaluate(`document.querySelector('#status-menu input[value=show]').checked`), true);
        assert.equal(await evaluate(`document.querySelectorAll('#run-list .run-card').length`), 1);
        assert.equal((await runListText()).includes('Compile app'), false);
    } finally { await resetFilters(); }
    await waitFor(`document.querySelector('#run-list').textContent.includes('Compile app')`);
    assert.equal(await statusSummary(), 'All statuses');
});

test('saved filters whose option never appears are dropped after the first load', { skip: !CHROME && 'Chrome not found' }, async () => {
    try {
        await evaluate(`localStorage.setItem(${JSON.stringify(FILTERS_KEY)}, JSON.stringify({ profile: 'all', repo: 'acme/app', workflow: 'all', branch: 'gone/branch', statusMode: 'show', statuses: [] }))`);
        await send('Page.reload', {}, pageSession);
        await waitFor(`document.querySelector('#run-list').textContent.includes('Compile app')`);
        await waitFor(`JSON.parse(localStorage.getItem(${JSON.stringify(FILTERS_KEY)})).branch === 'all'`);
        assert.equal(await evaluate(`(() => { const v = (id) => document.querySelector(id).selectedOptions[0].text; return [v('#repo-filter'), v('#branch-filter')].join('|'); })()`), 'acme/app|All branches');
        const stored = JSON.parse(await evaluate(`localStorage.getItem(${JSON.stringify(FILTERS_KEY)})`));
        assert.equal(stored.repo, 'acme/app');
        assert.equal(JSON.stringify(stored).includes('gone/branch'), false);
    } finally {
        await evaluate(`localStorage.removeItem(${JSON.stringify(FILTERS_KEY)})`);
        await send('Page.reload', {}, pageSession);
        await waitFor(`document.querySelector('#run-list').textContent.includes('Compile app')`);
    }
});

test('run summaries stay compact, truncate safely, and disclose details accessibly at narrow widths', { skip: !CHROME && 'Chrome not found' }, async () => {
    await evaluate(`if(document.querySelector('#settings-dialog').open) document.querySelector('#settings-close').click(); if(document.querySelector('#dispatch-dialog').open) document.querySelector('#dispatch-close').click()`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, pageSession);
    await evaluate(`document.querySelector('#search').value=''; document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#profile-filter').value='all'; document.querySelector('#profile-filter').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(`document.querySelector('#run-list .run-card')`);
    const desktop = await evaluate(`(() => { const card=[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')); const row=card.getBoundingClientRect(); const fields=[card.querySelector('.profile-badge'),card.querySelector('.run-repo'),card.querySelector('.run-title'),card.querySelector('.run-branch')]; const values=['A profile name deliberately much longer than its column','example-owner/an-extremely-long-repository-name','A deliberately very long workflow title that should be clipped to one line without losing its original value','a/branch/name/that/is/longer/than/the/available/column']; const clipped=fields.map((node,index)=>{node.textContent=values[index];node.title=values[index];return node.scrollWidth>node.clientWidth && getComputedStyle(node).textOverflow==='ellipsis' && node.textContent===values[index] && node.title===values[index]}); const list=document.querySelector('.run-list-scroll'); return {height:row.height, clipped, columns:getComputedStyle(card).gridTemplateColumns, listOverflow:list.scrollWidth>list.clientWidth, actionsFit:[...document.querySelectorAll('#run-list .run-actions')].every(cell=>cell.scrollWidth<=cell.clientWidth), cancelShown:!!document.querySelector('#run-list .run-actions .cancel-run')}; })()`);
    assert.equal(desktop.listOverflow, false, 'a full-width desktop run list must not scroll horizontally');
    assert.ok(desktop.cancelShown && desktop.actionsFit, 'Cancel and Jobs fit together in the actions cell');
    assert.ok(desktop.height >= 38 && desktop.height <= 46, `collapsed run row was ${desktop.height}px tall`);
    assert.deepEqual(desktop.clipped, [true, true, true, true], 'long profile, repository, title and branch values ellipsize without losing text or titles');
    await evaluate(`var compileCard=[...document.querySelectorAll('#run-list .run-card')].find(c=>c.querySelector('.run-title').title.startsWith('A deliberately')); for (const [selector,value] of [['.profile-badge','Personal'],['.run-repo','acme/app'],['.run-title','Compile app'],['.run-branch','main']]) { const node=compileCard.querySelector(selector); node.textContent=value; node.title=value; }`);
    await evaluate(`var compactToggle=[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')).querySelector('.details-toggle'); compactToggle.focus()`);
    const focusedToggle = await evaluate(`document.activeElement?.className`);
    assert.equal(focusedToggle, 'button quiet details-toggle');
    assert.equal(await evaluate(`compactToggle.tagName==='BUTTON' && compactToggle.tabIndex===0`), true, 'native button remains keyboard operable');
    await evaluate(`compactToggle.click()`);
    await waitFor(`document.querySelector('.details-toggle[aria-expanded="true"]')`);
    await waitFor(`document.activeElement?.matches('.details-toggle') && document.activeElement.getAttribute('aria-expanded')==='true'`);
    const expanded = await evaluate(`(() => { const card=[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')); const row=card.querySelector('.details-toggle').getBoundingClientRect(); const panel=card.querySelector('.run-details').getBoundingClientRect(); return {below:panel.top>=row.bottom, label:card.querySelector('.details-toggle').getAttribute('aria-label'), metadata:card.querySelector('.detail-meta')?.textContent || '', expanded:card.querySelector('.details-toggle').getAttribute('aria-expanded')}; })()`);
    assert.equal(expanded.below, true);
    assert.match(expanded.label, /jobs and steps for Compile app/i);
    assert.match(expanded.metadata, /Event: push/);
    assert.equal(expanded.expanded, 'true');
    await evaluate(`document.activeElement.click()`);
    await waitFor(`document.querySelector('.details-toggle[aria-expanded="false"]')`);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, pageSession);
    const narrow = await evaluate(`(() => { const list=document.querySelector('.run-list-scroll'); const card=[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')); return {listOverflow:list.scrollWidth>list.clientWidth,pageOverflow:document.documentElement.scrollWidth>innerWidth+1,rowHeight:card.getBoundingClientRect().height,columns:getComputedStyle(card).gridTemplateColumns}; })()`);
    assert.equal(narrow.listOverflow, true, 'narrow viewport should scroll the run list horizontally');
    assert.equal(narrow.pageOverflow, false, 'run-list overflow must not widen the page');
    assert.ok(narrow.rowHeight >= 38 && narrow.rowHeight <= 46, 'narrow summaries remain on one compact line');
    assert.equal(narrow.columns.split(' ').length, 8, 'summary keeps all eight columns at narrow widths');
    await send('Emulation.clearDeviceMetricsOverride', {}, pageSession);
});

test('run hover and focus highlights preserve layout in both themes and respect reduced motion', { skip: !CHROME && 'Chrome not found' }, async () => {
    const rowExpression = "document.querySelector('#run-list .run-card')";
    const movePointer = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, pageSession);
    const settled = () => waitFor(`${rowExpression}.getAnimations().length === 0`);
    const appearance = () => evaluate(`(() => { const row=${rowExpression}, style=getComputedStyle(row), rect=row.getBoundingClientRect(); return {background:style.backgroundColor,border:style.borderTopColor,width:rect.width,height:rect.height,left:rect.left,top:rect.top,status:getComputedStyle(row.querySelector('.status-icon')).backgroundColor}; })()`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, pageSession);
    try {
        for (const theme of ['light', 'dark']) {
            await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, pageSession);
            await evaluate('document.activeElement?.blur()');
            await movePointer(0, 0);
            await settled();
            const normal = await appearance();
            await movePointer(normal.left + 100, normal.top + normal.height / 2);
            await settled();
            const hovered = await appearance();
            assert.notEqual(hovered.background, normal.background, `${theme} row background highlights on hover`);
            assert.notEqual(hovered.border, normal.border, `${theme} row border highlights on hover`);
            assert.deepEqual([hovered.width, hovered.height, hovered.status], [normal.width, normal.height, normal.status], 'highlight does not shift rows or recolor their status');
            await movePointer(0, 0);
            await evaluate(`${rowExpression}.querySelector('.details-toggle').focus()`);
            await settled();
            const focused = await appearance();
            assert.equal(focused.background, hovered.background, 'keyboard focus receives the same row highlight');
            assert.equal(focused.border, hovered.border);
        }
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, pageSession);
        assert.equal(await evaluate(`getComputedStyle(${rowExpression}).transitionDuration`), '0s', 'reduced motion disables row transitions');
    } finally {
        await evaluate('document.activeElement?.blur()');
        await movePointer(0, 0);
        await send('Emulation.setEmulatedMedia', { features: [] }, pageSession);
        await send('Emulation.clearDeviceMetricsOverride', {}, pageSession);
    }
});

// Browser tests share one dashboard page: later tests reuse the Personal/Work
// profiles and rotated PATs created above. Toolbar discovery stays independent
// of that profile state and never reads tab URLs.
test('toolbar discovers only its own dashboard context and reuses the open page', { skip: !CHROME && 'Chrome not found' }, async () => {
    const contexts = await evaluate(`chrome.runtime.getContexts({contextTypes:['TAB'], documentUrls:[chrome.runtime.getURL('dashboard.html')]}).then(list=>list.filter(entry=>entry.documentUrl===chrome.runtime.getURL('dashboard.html') && Number.isInteger(entry.tabId) && Number.isInteger(entry.windowId)).map(entry=>({tabId:entry.tabId, windowId:entry.windowId, documentUrl:entry.documentUrl})))`);
    assert.ok(contexts.length >= 1, `expected own dashboard context (${await platformInfo()})`);
    assert.ok(contexts.every((entry) => entry.documentUrl === `chrome-extension://${extensionId}/dashboard.html`), await platformInfo());
    if (!workerSession) return;
    const before = await evaluateWorker(`chrome.runtime.getContexts({contextTypes:['TAB'], documentUrls:[chrome.runtime.getURL('dashboard.html')]}).then(list=>list.filter(entry=>Number.isInteger(entry.tabId)).length)`);
    const first = await evaluateWorker(`openDashboard().then(tab=>tab.id)`);
    const second = await evaluateWorker(`openDashboard().then(tab=>tab.id)`);
    assert.equal(second, first, await platformInfo());
    const after = await evaluateWorker(`chrome.runtime.getContexts({contextTypes:['TAB'], documentUrls:[chrome.runtime.getURL('dashboard.html')]}).then(list=>list.filter(entry=>Number.isInteger(entry.tabId)).length)`);
    assert.equal(after, before, await platformInfo());
    assert.ok(contexts.some((entry) => entry.tabId === first), await platformInfo());
});

test('expanded details stay text-safe and a failed-only rerun waits for a fresh attempt', { skip: !CHROME && 'Chrome not found' }, async () => {
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange')); document.querySelector('#search').value=''; document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true})); ${statusMenuScript('show', [])} document.querySelector('#profile-filter').value='all'; document.querySelector('#profile-filter').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Compile app')`);
    await evaluate(`[...document.querySelectorAll('#run-list .run-card')].find(card=>card.textContent.includes('Compile app')).querySelector('.details-toggle').click()`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Compile <script>')`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('2 of 2 jobs loaded') && document.querySelector('#run-list').textContent.includes('Package checks')`);
    assert.equal(await evaluate(`document.querySelector('#run-list script') === null`), true);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('Runner: ubuntu-latest') && document.querySelector('#run-list').textContent.includes('Checkout')`), true);
    const steps = await evaluate(`(() => { const rows=[...document.querySelectorAll('#run-list .step-list li')]; return {cells:rows.map(row=>row.children.length), lefts:[...new Set(rows.map(row=>Math.round(row.querySelector('.step-status').getBoundingClientRect().left)))], tones:rows.map(row=>row.querySelector('.step-status').className)}; })()`);
    assert.ok(steps.cells.length >= 3 && steps.cells.every((count) => count === 3), 'every step row has name, status and duration cells');
    assert.equal(steps.lefts.length, 1, 'step statuses line up in one column');
    assert.ok(steps.tones.includes('step-status step-success') && steps.tones.includes('step-status step-skipped'), 'step statuses carry a tone class');
    await evaluate(`window.confirm=()=>false; [...document.querySelectorAll('#run-list .run-card')].find(card=>card.textContent.includes('Compile app')).querySelector('.rerun-controls button:nth-child(2)').click()`);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST').length`), 0);
    await evaluate(`window.confirm=()=>true`);
    await evaluate(`[...document.querySelectorAll('#run-list .run-card')].find(card=>card.textContent.includes('Compile app')).querySelector('.rerun-controls button:nth-child(2)').click(); [...document.querySelectorAll('#run-list .run-card')].find(card=>card.textContent.includes('Compile app')).querySelector('.rerun-controls button:nth-child(2)').click()`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Rerun requested')`);
    await sleep(700);
    await evaluate(`[...document.querySelectorAll('#run-list .run-card')].find(card=>card.textContent.includes('Compile app')).querySelector('.run-details .detail-heading button').click()`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Attempt: 2') && document.querySelector('#run-list').textContent.includes('Compile <script>')`);
    assert.equal(await evaluate(`[...document.querySelectorAll('#run-list .run-card')].find(card=>card.textContent.includes('Compile app')).textContent.includes('failure')`), false);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.endsWith('/rerun-failed-jobs')).length`), 1);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('Rerun requested')`), false);
});

test('cancel is offered only on active runs, confirms first, and clears once the run finishes', { skip: !CHROME && 'Chrome not found' }, async () => {
    const card = (title) => `[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('${title}'))`;
    const posts = `globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.endsWith('/cancel'))`;
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange')); document.querySelector('#search').value=''; document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true})); ${statusMenuScript('show', [])} document.querySelector('#profile-filter').value='all'; document.querySelector('#profile-filter').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Deploy to preview')`);
    assert.equal(await evaluate(`${card('Deploy to preview')}.querySelector('.cancel-run').disabled`), false);
    assert.equal(await evaluate(`${card('Compile app')}.querySelector('.cancel-run') === null`), true);
    await evaluate(`window.confirm=()=>false; ${card('Deploy to preview')}.querySelector('.cancel-run').click()`);
    assert.equal(await evaluate(`${posts}.length`), 0);
    await evaluate(`globalThis.__cancelMode='conflict'; window.confirm=()=>true; ${card('Deploy to preview')}.querySelector('.cancel-run').click()`);
    await waitFor(`document.querySelector('#feedback')?.textContent.includes('may have already finished') || document.body.textContent.includes('may have already finished')`);
    assert.equal(await evaluate(`${card('Deploy to preview')}.querySelector('.cancel-run').disabled`), false);
    await evaluate(`globalThis.__cancelMode='ok'; ${card('Deploy to preview')}.querySelector('.cancel-run').click()`);
    await waitFor(`${card('Deploy to preview')}.textContent.includes('Cancel requested')`);
    assert.equal(await evaluate(`${posts}.length`), 2);
    assert.equal(await evaluate(`${posts}.every(x=>x.url.endsWith('/actions/runs/2/cancel'))`), true);
    assert.equal(await evaluate(`${card('Deploy to preview')}.querySelector('.cancel-run').disabled`), true);
    await evaluate(`${card('Deploy to preview')}.querySelector('.cancel-run').click()`);
    assert.equal(await evaluate(`${posts}.length`), 2);
    await evaluate(`globalThis.__run2Done=true; document.querySelector('#refresh').click()`);
    await waitFor(`!${card('Deploy to preview')}.textContent.includes('Cancel requested') && ${card('Deploy to preview')}.querySelector('.cancel-run') === null`);
    await evaluate(`globalThis.__run2Done=false`);
});

test('aborted sent POST stays uncertain with a single request until acknowledged', { skip: !CHROME && 'Chrome not found' }, async () => {
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange')); document.querySelector('#search').value=''; document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#profile-filter').value='all'; document.querySelector('#profile-filter').dispatchEvent(new Event('change',{bubbles:true})); window.confirm=()=>true; globalThis.__rerunHang=false; globalThis.__rerunDeny=false;`);
    await waitFor(`document.querySelector('#run-list').textContent.includes('Compile app')`);
    await evaluate(`var cardA=[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')); var tA=cardA?.querySelector('.details-toggle'); if(tA?.getAttribute('aria-expanded')==='false') tA.click();`);
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
    await evaluate(`var cardB=[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')); var tB=cardB?.querySelector('.details-toggle'); if(tB?.getAttribute('aria-expanded')==='false') tB.click();`);
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
    await evaluate(`for (var textD of ['Compile app','Work-only result']) { var cardD=[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes(textD)); var tD=cardD?.querySelector('.details-toggle'); if(tD?.getAttribute('aria-expanded')==='false') tD.click(); }`);
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
    await evaluate(`var cardE=[...document.querySelectorAll('#run-list .run-card')].find(c=>c.textContent.includes('Compile app')); var tE=cardE?.querySelector('.details-toggle'); if(tE?.getAttribute('aria-expanded')==='false') tE.click();`);
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
    // The close button stays inside the dialog's visible rect after scrolling.
    assert.equal(await evaluate(`(()=>{const d=document.querySelector('#dispatch-dialog'); const pad=document.createElement('div'); pad.style.height='2000px'; pad.id='e2e-pad'; d.querySelector('form').append(pad); d.scrollTop=1500; const c=document.querySelector('#dispatch-close').getBoundingClientRect(), r=d.getBoundingClientRect(); const ok=d.scrollTop>0 && c.top>=r.top && c.bottom<=r.bottom; pad.remove(); d.scrollTop=0; return ok})()`), true);
    assert.equal(await evaluate(`document.querySelector('.dialog-notes').open`), false);
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
    await evaluate(`document.querySelector('#dispatch-inputs [name=greeting]').value='hi'+String.fromCharCode(10)+'there'; document.querySelector('#dispatch-inputs input[name=count]').value='2'; window.confirm=()=>{throw new Error('should not confirm')}; document.querySelector('#dispatch-form').requestSubmit(); document.querySelector('#dispatch-form').requestSubmit()`);
    await waitFor(`document.querySelector('#dispatch-result').textContent.includes('Open run 77')`);
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).length`), postBase + 1);
    assert.equal(await evaluate(`JSON.parse(globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).at(-1).body).inputs.greeting`), 'hi\nthere');
    assert.equal(await evaluate(`globalThis.__cimRequests.filter(x=>x.method==='POST' && x.url.includes('/dispatches')).every(x=>x.auth==='Bearer e2e-rotated')`), true);
    assert.equal(await evaluate(`document.querySelector('#dispatch-result a').href`), 'https://github.com/acme/app/actions/runs/77');
    await waitFor(`document.querySelector('#run-list').textContent.includes('Dispatched CI')`);
    assert.equal(await evaluate(`document.querySelector('#run-list').textContent.includes('Dispatched CI')`), true);
    const fire = (type, x, y) => `document.querySelector('#dispatch-dialog').dispatchEvent(new PointerEvent('${type}',{bubbles:true,clientX:${x},clientY:${y}}))`;
    const click = (x, y) => `document.querySelector('#dispatch-dialog').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:${x},clientY:${y}}))`;
    const inPadding = `(()=>{const r=document.querySelector('#dispatch-dialog').getBoundingClientRect(); return [r.left+5, r.top+5]})()`;
    const [px, py] = await evaluate(inPadding);
    // Press and release in the padding: target is the dialog but inside its box.
    await evaluate(`${fire('pointerdown', px, py)}; ${click(px, py)}`);
    assert.equal(await evaluate(`document.querySelector('#dispatch-dialog').open`), true);
    // Press inside the box, release outside (drag-select): stays open.
    await evaluate(`document.querySelector('#dispatch-inputs [name=greeting]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:${px},clientY:${py}})); ${click(2, 2)}`);
    assert.equal(await evaluate(`document.querySelector('#dispatch-dialog').open`), true);
    // Press and release on the backdrop closes it.
    await evaluate(`${fire('pointerdown', 2, 2)}; ${click(2, 2)}`);
    assert.equal(await evaluate(`document.querySelector('#dispatch-dialog').open`), false);
});

test('new run dialog grows long prompt fields while dashboard and Settings stay compact', { skip: !CHROME && 'Chrome not found' }, async () => {
    const longText = Array.from({ length: 24 }, (_, index) => `paragraph ${index} ` + 'wrapping words '.repeat(9).trim()).join('\n\n');
    const wrappedText = 'A single long paragraph without explicit line breaks that must wrap into more lines as the viewport narrows. '.repeat(3);
    const metrics = (width, height, mobile) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }, pageSession);
    const greetingLines = `((field) => { const style=getComputedStyle(field); return (field.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight); })(document.querySelector('#dispatch-inputs [name=greeting]'))`;
    let startupBodyFont = null;
    try {
        await metrics(1440, 900, false);
        // Earlier mobile-emulated tests can leave Chrome's text autosizing active,
        // so Settings is compared against the dashboard's own current base size.
        startupBodyFont = await evaluate(`parseFloat(getComputedStyle(document.body).fontSize)`);
        const rowHeight = await evaluate(`document.querySelector('#run-list .run-card').getBoundingClientRect().height`);
        assert.ok(rowHeight >= 38 && rowHeight <= 46, `dashboard run rows stay compact (${rowHeight}px)`);
        await evaluate(`document.querySelector('#new-run').click()`);
        await waitFor(`document.querySelector('#dispatch-dialog').open`);
        await evaluate(`document.querySelector('#dispatch-profile').value=[...document.querySelector('#dispatch-profile').options].find(o=>o.text.startsWith('Personal')).value; document.querySelector('#dispatch-profile').dispatchEvent(new Event('change',{bubbles:true}))`);
        await waitFor(`document.querySelector('#dispatch-inputs').textContent.includes('greeting')`);
        const desktop = await evaluate(`(() => {
            const dialog = document.querySelector('#dispatch-dialog');
            const field = dialog.querySelector('[name=greeting]');
            const style = getComputedStyle(field);
            return {
                width: dialog.getBoundingClientRect().width,
                dialogFont: parseFloat(getComputedStyle(dialog).fontSize),
                inputFont: parseFloat(style.fontSize),
                labelFont: parseFloat(getComputedStyle(dialog.querySelector('.field-label')).fontSize),
                helpFont: parseFloat(getComputedStyle(dialog.querySelector('.dispatch-help')).fontSize),
                shortLines: (field.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight),
                pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
                dialogOverflow: dialog.scrollWidth > dialog.clientWidth + 1
            };
        })()`);
        assert.ok(desktop.width >= 940 && desktop.width <= 970, `desktop dialog is about 960px wide (${desktop.width})`);
        assert.equal(desktop.dialogFont, 16, 'dialog text is 16px');
        assert.equal(desktop.inputFont, 16, 'form controls are 16px');
        assert.equal(desktop.labelFont, 14, 'field labels are 14px');
        assert.equal(desktop.helpFont, 14, 'descriptions are 14px');
        assert.ok(desktop.shortLines >= 1.8 && desktop.shortLines <= 2.6, `short values stay compact (${desktop.shortLines} lines)`);
        assert.equal(desktop.pageOverflow, false, 'a wide dialog never widens the page');
        assert.equal(desktop.dialogOverflow, false, 'desktop dialog has no internal horizontal overflow');
        assert.equal(await evaluate(`(() => { const dialog=document.querySelector('#dispatch-dialog'); const pad=document.createElement('div'); pad.style.height='2000px'; dialog.querySelector('form').append(pad); dialog.scrollTop=1500; const close=document.querySelector('#dispatch-close').getBoundingClientRect(); const rect=dialog.getBoundingClientRect(); const ok=dialog.scrollTop>0 && close.top>=rect.top-1 && close.bottom<=rect.bottom+1; pad.remove(); dialog.scrollTop=0; return ok; })()`), true, 'the close button stays visible after scrolling');
        const surfaces = {};
        for (const theme of ['light', 'dark']) {
            await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, pageSession);
            const appearance = await evaluate(`(() => { const dialog=document.querySelector('#dispatch-dialog'); return {surface:getComputedStyle(dialog).backgroundColor, inputFont:parseFloat(getComputedStyle(dialog.querySelector('[name=greeting]')).fontSize), helpFont:parseFloat(getComputedStyle(dialog.querySelector('.dispatch-help')).fontSize)}; })()`);
            assert.equal(appearance.inputFont, 16, `${theme} theme keeps 16px inputs`);
            assert.equal(appearance.helpFont, 14, `${theme} theme keeps 14px descriptions`);
            surfaces[theme] = appearance.surface;
        }
        await send('Emulation.setEmulatedMedia', { features: [] }, pageSession);
        assert.notEqual(surfaces.light, surfaces.dark, 'dialog surface follows the color scheme');
        // A long multiline default must be sized when the form renders, before any typing.
        const defaulted = await evaluate(`(async () => {
            const NL = String.fromCharCode(10);
            const text = Array.from({length: 15}, (_, index) => 'default paragraph ' + index + ' ' + 'wrapping words '.repeat(9).trim()).join(NL);
            const original = CimWorkflowSchema.parseWorkflowYaml;
            CimWorkflowSchema.parseWorkflowYaml = (yaml) => {
                const parsed = original(yaml);
                if (Array.isArray(parsed.inputs)) parsed.inputs = parsed.inputs.map((input) => (input.name === 'greeting' ? Object.assign({}, input, {default: text}) : input));
                return parsed;
            };
            document.querySelector('#dispatch-load').click();
            const until = Date.now() + 5000;
            let field = null;
            while (Date.now() < until) {
                field = document.querySelector('#dispatch-inputs [name=greeting]');
                if (field && field.value === text) break;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (!field) { CimWorkflowSchema.parseWorkflowYaml = original; return {preserved:false, lines:0}; }
            const style = getComputedStyle(field);
            const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
            const result = {preserved:Boolean(field) && field.value === text, lines:(field.clientHeight - padding)/parseFloat(style.lineHeight)};
            CimWorkflowSchema.parseWorkflowYaml = original;
            return result;
        })()`);
        assert.equal(defaulted.preserved, true, 'a long multiline default loads intact');
        assert.ok(defaulted.lines >= 9.5 && defaulted.lines <= 10.05, `a long default grows on load (${defaulted.lines} lines)`);
        const grown = await evaluate(`(() => {
            const field = document.querySelector('#dispatch-inputs [name=greeting]');
            field.value = ${JSON.stringify(longText)};
            field.dispatchEvent(new Event('input',{bubbles:true}));
            const style = getComputedStyle(field);
            const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
            return {preserved:field.value === ${JSON.stringify(longText)}, lines:(field.clientHeight - padding)/parseFloat(style.lineHeight), scrollable:field.scrollHeight > field.clientHeight + 1, maxHeight:style.maxHeight};
        })()`);
        assert.equal(grown.preserved, true, 'the long value is preserved exactly');
        assert.ok(grown.lines >= 9.5 && grown.lines <= 10.05, `long content grows to about ten lines (${grown.lines})`);
        assert.equal(grown.scrollable, true, 'a capped field scrolls internally instead of losing text');
        assert.equal(grown.maxHeight, 'none', 'no CSS maximum blocks a manual resize');
        const manual = await evaluate(`(() => {
            const field = document.querySelector('#dispatch-inputs [name=greeting]');
            field.style.height = '640px';
            const before = field.getBoundingClientRect().height;
            field.dispatchEvent(new Event('input',{bubbles:true}));
            return {before, after: field.getBoundingClientRect().height};
        })()`);
        assert.ok(manual.before > 500 && Math.abs(manual.after - manual.before) < 1, 'an unchanged value and width keep a manual resize');
        await evaluate(`(() => {
            const field = document.querySelector('#dispatch-inputs [name=greeting]');
            field.value += String.fromCharCode(10) + 'an edited line';
            field.dispatchEvent(new Event('input',{bubbles:true}));
        })()`);
        assert.ok(await evaluate(`${greetingLines} >= 9.5 && ${greetingLines} <= 10.05`), 'editing re-fits the field instead of keeping a manual height');
        const beforeReflow = await evaluate(`(() => { const field=document.querySelector('#dispatch-inputs [name=greeting]'); field.value=${JSON.stringify(wrappedText)}; field.dispatchEvent(new Event('input',{bubbles:true})); return ${greetingLines}; })()`);
        assert.ok(beforeReflow >= 1.8 && beforeReflow <= 10.05, `wrapped paragraph starts within the range (${beforeReflow})`);
        await metrics(390, 844, false);
        await waitFor(`${greetingLines} > ${beforeReflow + 0.5}`);
        const narrow = await evaluate(`(() => {
            const dialog = document.querySelector('#dispatch-dialog');
            const rect = dialog.getBoundingClientRect();
            const children = [...dialog.querySelectorAll('.dispatch-ref-row input, .dispatch-ref-row button, .dispatch-field > *')];
            return {
                width: rect.width,
                left: rect.left,
                right: rect.right,
                viewport: innerWidth,
                pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
                dialogOverflow: dialog.scrollWidth > dialog.clientWidth + 1,
                inside: children.every((node) => { const box = node.getBoundingClientRect(); return box.width === 0 || (box.left >= rect.left - 1 && box.right <= rect.right + 1); }),
                offenders: children.filter((node) => { const box = node.getBoundingClientRect(); return box.width > 0 && (box.left < rect.left - 1 || box.right > rect.right + 1); }).map((node) => node.tagName + '#' + (node.id || node.name) + ' ' + Math.round(node.getBoundingClientRect().left) + '..' + Math.round(node.getBoundingClientRect().right) + ' vs ' + Math.round(rect.left) + '..' + Math.round(rect.right))
            };
        })()`);
        assert.ok(narrow.width >= 300 && narrow.width <= narrow.viewport - 20, `narrow dialog fits the viewport (${narrow.width} of ${narrow.viewport})`);
        assert.ok(narrow.left >= 4 && narrow.right <= narrow.viewport - 4, `narrow dialog keeps a margin (${narrow.left}..${narrow.right})`);
        assert.equal(narrow.pageOverflow, false, 'the dialog never widens a narrow page');
        assert.equal(narrow.dialogOverflow, false, 'narrow dialog controls wrap instead of scrolling sideways');
        assert.equal(narrow.inside, true, `narrow ref row and controls stay inside the dialog (${JSON.stringify(narrow.offenders)})`);
        assert.ok(await evaluate(`${greetingLines} >= ${beforeReflow + 0.5} && ${greetingLines} <= 10.05`), 'narrow reflow keeps the grown height within the ten-line bound');
    } finally {
        await evaluate(`if(document.querySelector('#dispatch-dialog').open) document.querySelector('#dispatch-close').click(); if(document.querySelector('#settings-dialog').open) document.querySelector('#settings-close').click()`);
        await send('Emulation.setEmulatedMedia', { features: [] }, pageSession);
        await send('Emulation.clearDeviceMetricsOverride', {}, pageSession);
    }
    await metrics(1440, 900, false);
    try {
        await evaluate(`document.querySelector('#settings-open').click()`);
        await waitFor(`document.querySelector('#settings-dialog').open`);
        const settings = await evaluate(`(() => { const dialog=document.querySelector('#settings-dialog'); return {width:dialog.getBoundingClientRect().width, label:parseFloat(getComputedStyle(dialog.querySelector('.field-label')).fontSize), textarea:parseFloat(getComputedStyle(dialog.querySelector('#repositories')).fontSize), body:parseFloat(getComputedStyle(document.body).fontSize)}; })()`);
        assert.ok(settings.width >= 670 && settings.width <= 690, `Settings keeps its 680px dialog (${settings.width})`);
        assert.equal(settings.label, 12, `Settings labels keep their size (${JSON.stringify(settings)})`);
        assert.equal(settings.textarea, startupBodyFont, `Settings text inherits the dashboard default size (${JSON.stringify({ settings, startupBodyFont })})`);
    } finally {
        await evaluate(`if(document.querySelector('#settings-dialog').open) document.querySelector('#settings-close').click()`);
        await send('Emulation.clearDeviceMetricsOverride', {}, pageSession);
    }
    const finalRow = await evaluate(`document.querySelector('#run-list .run-card').getBoundingClientRect().height`);
    assert.ok(finalRow >= 38 && finalRow <= 46, `dashboard rows stay compact after the dialog (${finalRow}px)`);
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
