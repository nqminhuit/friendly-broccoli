const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { parseRepositories, createSnapshotLoader, SettingsStore } = require('./settings.js');
const { API_VERSION, GitHubClient, ApiError, paginationLinks } = require('./api.js');
const { attemptNumber, isAttemptAdvance, mergeRunMetadata, shouldInvalidateJobs } = require('./run-state.js');
const { ForegroundMonitor, nextPollAt } = require('./monitor.js');

test('repository input trims, deduplicates case-insensitively, and rejects unsafe syntax', () => {
    assert.deepEqual(parseRepositories(' octo/one\nOCTO/ONE\n team/repo-name \nhttps://github.com/a/b\n../bad\nowner/repo?x'), {
        repos: ['octo/one', 'team/repo-name'],
        errors: ['Line 4: enter owner/repository only (no URL, query, or path).', 'Line 5: enter owner/repository only (no URL, query, or path).', 'Line 6: enter owner/repository only (no URL, query, or path).']
    });
});

test('older storage snapshots cannot apply after a newer profile load', async () => {
    const pending = [];
    const applied = [];
    const loadLatest = createSnapshotLoader(() => new Promise((resolve) => pending.push(resolve)), (value) => applied.push(value));
    const stale = loadLatest();
    const fresh = loadLatest();
    pending[1]([{ id: 'fresh' }]);
    assert.equal(await fresh, true);
    pending[0]([{ id: 'deleted-profile' }]);
    assert.equal(await stale, false);
    assert.deepEqual(applied, [[{ id: 'fresh' }]]);
});

function storageArea(initial = {}) {
    const values = { ...initial };
    return { values, async get(keys) { if (keys === null) return { ...values }; return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]).filter(([, value]) => value !== undefined)); }, async set(next) { Object.assign(values, next); }, async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; } };
}
test('profile storage isolates tokens and settings, keeps session-only default, and forget retains repositories', async () => {
    let nextId = 0;
    const local = storageArea(), session = storageArea();
    const store = new SettingsStore({ local, session }, { createId: () => `profile-${++nextId}` });
    const personal = await store.saveProfile({ name: ' Personal ', repos: ['acme/app'], tokenInput: 'personal-pat', rememberToken: false });
    const work = await store.saveProfile({ name: 'Work', repos: ['acme/app', 'acme/infra'], tokenInput: 'work-pat', rememberToken: true });
    assert.equal(personal.name, 'Personal');
    assert.equal(local.values['cimProfile:profile-1'].token, undefined);
    assert.equal(local.values['cimProfile:profile-2'].token, 'work-pat');
    assert.deepEqual((await store.load()).map(({ id, token }) => [id, token]), [['profile-1', 'personal-pat'], ['profile-2', 'work-pat']]);
    await store.saveProfile({ id: work.id, name: ' Work ', repos: ['acme/infra'], rememberToken: false, tokenInput: '' });
    assert.equal(local.values['cimProfile:profile-1'].repos[0], 'acme/app');
    assert.equal(local.values['cimProfile:profile-2'].token, undefined);
    assert.equal((await store.load()).find(({ id }) => id === work.id).token, 'work-pat');
    await store.forgetToken(work.id);
    assert.equal((await store.load()).find(({ id }) => id === work.id).token, '');
    assert.deepEqual(local.values['cimProfile:profile-2'].repos, ['acme/infra']);
    await store.deleteProfile(personal.id);
    assert.equal(session.values['cimToken:profile-1'], undefined);
    assert.equal(local.values['cimProfile:profile-1'], undefined);
});

test('legacy single profile migrates once and removes old PAT keys', async () => {
    const local = storageArea({ repositories: ['a/b'], rememberToken: true, token: 'legacy' });
    const session = storageArea();
    const store = new SettingsStore({ local, session });
    const [profile] = await store.load();
    assert.equal(profile.id, 'default');
    assert.equal(profile.token, 'legacy');
    assert.equal(session.values['cimToken:default'], 'legacy');
    assert.equal(local.values.token, undefined);
    assert.equal(local.values.repositories, undefined);
    assert.equal(local.values['cimProfile:default'].token, 'legacy');
    await store.load();
    assert.equal(Object.keys(local.values).filter((key) => key.startsWith('cimProfile:')).length, 1);
});

test('legacy session PAT wins and both stores discard obsolete credentials', async () => {
    const local = storageArea({ repositories: ['a/b'], rememberToken: false, token: 'remembered-fallback' });
    const session = storageArea({ token: 'session-only' });
    const store = new SettingsStore({ local, session });
    const [profile] = await store.load();
    assert.equal(profile.token, 'session-only');
    assert.equal(session.values['cimToken:default'], 'session-only');
    assert.equal(session.values.token, undefined);
    assert.equal(local.values.token, undefined);
    assert.equal(local.values['cimProfile:default'].token, undefined);
    const rememberedLocal = storageArea({ repositories: ['a/b'], rememberToken: true, token: 'remembered' });
    const cleanSession = storageArea();
    const [remembered] = await new SettingsStore({ local: rememberedLocal, session: cleanSession }).load();
    assert.equal(remembered.token, 'remembered');
    assert.equal(cleanSession.values['cimToken:default'], 'remembered');
    assert.equal(rememberedLocal.values.token, undefined);
    const existingLocal = storageArea({ 'cimProfile:one': { id: 'one', name: 'One', repos: [], rememberToken: false }, token: 'orphan' });
    const existingSession = storageArea({ token: 'orphan-session' });
    await new SettingsStore({ local: existingLocal, session: existingSession }).load();
    assert.equal(existingLocal.values['cimProfile:one'].token, undefined);
    assert.equal(existingSession.values.token, undefined);
});

function response(status, data, headers = {}) {
    const normalized = new Headers(headers);
    return { status, ok: status >= 200 && status < 300, headers: normalized, json: async () => data, clone() { return this; } };
}
const runResponse = (items = []) => response(200, { total_count: items.length, workflow_runs: items }, { ETag: 'etag-1' });

test('fetch uses the global receiver required by native browser functions', async () => {
    const client = new GitHubClient({ fetchImpl: async function () {
        assert.equal(this, globalThis);
        return runResponse();
    } });
    client.reset('test-token');
    assert.equal(await client.testRepo('owner', 'repo'), true);
});

test('safe API URL, encoded path, fixed auth headers, and validated pagination', async () => {
    let captured;
    const client = new GitHubClient({ fetchImpl: async (url, options) => { captured = { url, options }; return runResponse(); } });
    client.reset('secret-token');
    await client.listRuns('space owner', 'repo/name');
    assert.equal(captured.url, 'https://api.github.com/repos/space%20owner/repo%2Fname/actions/runs?per_page=30');
    assert.equal(captured.options.headers.Authorization, 'Bearer secret-token');
    assert.equal(captured.options.headers.Accept, 'application/vnd.github+json');
    assert.equal(captured.options.headers['X-GitHub-Api-Version'], API_VERSION);
    await assert.rejects(client.request('https://evil.example/private'), /unsafe GitHub pagination URL/);
    const links = paginationLinks('<https://api.github.com.evil.test/repos/a/b/actions/runs?page=2>; rel="next", <https://user:pass@api.github.com/repos/a/b/actions/runs?page=3>; rel="prev", <https://api.github.com/repos/a/b/actions/runs?page=2>; rel="next"', '/repos/a/b/actions/runs');
    assert.equal(links.next, 'https://api.github.com/repos/a/b/actions/runs?page=2');
    assert.equal(links.prev, undefined);
});

test('ETag request reuses 304 data and reset isolates credential cache', async () => {
    let calls = 0, header;
    const client = new GitHubClient({ fetchImpl: async (_url, options) => {
        calls++; header = options.headers['If-None-Match'];
        return header ? response(304, null) : runResponse([{ id: 7 }]);
    } });
    client.reset('one');
    assert.equal((await client.listRuns('a', 'b')).runs[0].id, 7);
    assert.equal((await client.listRuns('a', 'b')).runs[0].id, 7);
    assert.equal(header, 'etag-1');
    client.reset('two');
    assert.equal((await client.listRuns('a', 'b')).runs[0].id, 7);
    assert.equal(calls, 3);
});

test('reset aborts old credential requests and stale responses never refill the cache', async () => {
    let resolveFetch;
    const client = new GitHubClient({ fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }) });
    client.reset('old-token');
    const request = client.listRuns('a', 'b');
    await new Promise((resolve) => setImmediate(resolve));
    client.reset('new-token');
    resolveFetch(runResponse([{ id: 9 }]));
    await assert.rejects(request, (error) => error.kind === 'cancelled');
    assert.equal(client.cache.size, 0);
});

test('GitHub requests are bounded to the configured concurrency', async () => {
    let active = 0, peak = 0;
    const client = new GitHubClient({ maxConcurrent: 2, fetchImpl: async () => {
        active++; peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--; return runResponse();
    } });
    client.reset('token');
    await Promise.all(Array.from({ length: 6 }, (_, index) => client.listRuns('owner', `repo${index}`)));
    assert.equal(peak, 2);
});

test('401 stops requests; 403 permissions and 404 are readable per-repository errors', async () => {
    let status = 401;
    const client = new GitHubClient({ fetchImpl: async () => response(status, {}) });
    client.reset('secret');
    await assert.rejects(client.listRuns('a', 'b'), (error) => error.kind === 'auth' && !error.message.includes('secret'));
    status = 200;
    await assert.rejects(client.listRuns('a', 'c'), (error) => error.kind === 'auth');
    client.reset('secret'); status = 403;
    await assert.rejects(client.listRuns('a', 'b'), (error) => error.kind === 'permission');
    client.reset('secret'); status = 404;
    await assert.rejects(client.listRuns('a', 'b'), (error) => error.kind === 'not-found');
});

test('secondary Retry-After is not overridden by a primary reset; fallback backs off', async () => {
    let now = 100000, status = 429;
    const client = new GitHubClient({ now: () => now, fetchImpl: async () => response(status, { message: 'secondary rate limit' }, { 'Retry-After': '12', 'X-RateLimit-Remaining': '3', 'X-RateLimit-Reset': '3700' }) });
    client.reset('token');
    await assert.rejects(client.listRuns('a', 'b'), (error) => error.kind === 'rate-limit' && error.retryAt === now + 12000);
    status = 403; client.reset('token');
    const secondary = new GitHubClient({ now: () => now, fetchImpl: async () => response(403, { message: 'secondary rate limit' }, { 'X-RateLimit-Remaining': '3' }) });
    secondary.reset('token');
    await assert.rejects(secondary.listRuns('a', 'b'), (error) => error.kind === 'rate-limit' && error.retryAt >= now + 60000);
});

test('primary rate limit uses reset; Retry-After HTTP date and malformed values never spin', async () => {
    const now = 100000; let headers = { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '3700' };
    const client = new GitHubClient({ now: () => now, fetchImpl: async () => response(403, { message: 'API rate limit exceeded' }, headers) }); client.reset('token');
    await assert.rejects(client.listRuns('a', 'primary'), (error) => error.kind === 'rate-limit' && error.retryAt === 3700000);
    const date = new Date(now + 15000).toUTCString(); headers = { 'Retry-After': date, 'X-RateLimit-Remaining': '3' }; client.reset('token');
    await assert.rejects(client.listRuns('a', 'date'), (error) => error.kind === 'rate-limit' && error.retryAt === Date.parse(date));
    headers = { 'Retry-After': 'invalid', 'X-RateLimit-Remaining': '3' }; client.reset('token');
    await assert.rejects(client.listRuns('a', 'malformed'), (error) => error.kind === 'rate-limit' && error.retryAt >= now + 60000);
});

test('already-aborted request never fetches and queued cancellation releases serialized request slot', async () => {
    let active = 0, peak = 0, calls = 0, release;
    const client = new GitHubClient({ fetchImpl: async (_url, options) => { calls++; active++; peak = Math.max(peak, active); await new Promise((resolve) => { release = resolve; options.signal.addEventListener('abort', resolve, { once: true }); }); active--; return runResponse(); } });
    client.reset('token'); const pre = new AbortController(); pre.abort();
    await assert.rejects(client.listRuns('a', 'x', { signal: pre.signal }), (error) => error.kind === 'cancelled');
    assert.equal(calls, 0);
    const first = client.listRuns('a', 'b'); await new Promise((resolve) => setImmediate(resolve));
    const queuedController = new AbortController(); const queued = client.listRuns('a', 'c', { signal: queuedController.signal }); queuedController.abort();
    await assert.rejects(queued, (error) => error.kind === 'cancelled');
    release(); await first; assert.equal(calls, 1); assert.equal(peak, 1);
});

test('GET-only ETags, safe POST JSON, empty accepted responses, and mutation cache invalidation', async () => {
    const calls = [];
    const client = new GitHubClient({ fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith('/empty')) return response(204, null);
        if (options.method === 'POST') return options.body ? response(200, { workflow_run_id: 55 }) : response(201, null, { 'Content-Length': '0' });
        return runResponse([{ id: 12 }]);
    } });
    client.reset('token');
    await client.listRuns('a', 'b');
    assert.equal(client.cache.size, 1);
    const accepted = await client.rerun('a', 'b', 12, false);
    assert.equal(accepted.status, 201);
    assert.equal(accepted.data, null);
    assert.equal(calls[1].options.method, 'POST');
    assert.equal(calls[1].options.body, undefined);
    assert.equal(calls[1].options.headers['If-None-Match'], undefined);
    assert.equal(client.cache.size, 0);
    const dispatchShape = await client.request('https://api.github.com/repos/a/b/actions/runs', { method: 'POST', body: { choice: 'safe' }, expectedPath: '/repos/a/b/actions/runs' });
    assert.deepEqual(dispatchShape.data, { workflow_run_id: 55 });
    assert.equal(calls[2].options.body, JSON.stringify({ choice: 'safe' }));
    assert.equal(calls[2].options.headers['Content-Type'], 'application/json');
    assert.equal(calls[2].options.redirect, 'error');
    const empty = await client.request('https://api.github.com/empty', { expectedPath: '/empty' });
    assert.equal(empty.status, 204);
    assert.equal(empty.data, null);
});

test('mutations pace per client and distinguish queued cancellation from ambiguous sent failures', async () => {
    let now = 5000, scheduled = null, calls = 0;
    const client = new GitHubClient({ now: () => now, setTimer: (fn, delay) => { scheduled = { fn, delay }; return 1; }, clearTimer: () => {}, fetchImpl: async () => { calls++; return response(201, null, { 'Content-Length': '0' }); } });
    client.reset('token');
    await client.rerun('a', 'b', 1, false);
    const second = client.rerun('a', 'b', 2, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scheduled.delay, 1000);
    assert.equal(calls, 1);
    now += scheduled.delay; scheduled.fn(); await second;
    assert.equal(calls, 2);

    const queuedClient = new GitHubClient({ fetchImpl: async () => { throw new Error('must not send'); } });
    queuedClient.reset('token'); queuedClient.lastMutationAt = Date.now();
    const pre = new AbortController(); const waiting = queuedClient.rerun('a', 'b', 3, false, { signal: pre.signal }); pre.abort();
    await assert.rejects(waiting, (error) => error.kind === 'cancelled' && !error.ambiguous);

    let sent = 0;
    const uncertain = new GitHubClient({ fetchImpl: async () => { sent++; throw new Error('connection lost'); } }); uncertain.reset('token');
    await assert.rejects(uncertain.rerun('a', 'b', 4, true), (error) => error.kind === 'network' && error.ambiguous);
    assert.equal(sent, 1);

    const afterSend = new AbortController(); let sentSignal;
    const aborting = new GitHubClient({ fetchImpl: (_url, options) => { sentSignal = options.signal; return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted after send')), { once: true })); } }); aborting.reset('token');
    const uncertainAbort = aborting.rerun('a', 'b', 5, false, { signal: afterSend.signal }); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sentSignal.aborted, false); afterSend.abort();
    await assert.rejects(uncertainAbort, (error) => error.kind === 'cancelled' && error.ambiguous);
});

test('run and attempt-job routes are pinned to safe repository paths; POST 403 does not invalidate token', async () => {
    const seen = [];
    const client = new GitHubClient({ fetchImpl: async (url, options) => { seen.push([url, options.method]); return options.method === 'POST' ? response(403, { message: 'Resource not accessible by integration' }) : response(200, { run_attempt: 2, jobs: [], total_count: 0 }); } });
    client.reset('token');
    await client.getRun('owner', 'repo', 8);
    await client.listAttemptJobs('owner', 'repo', 8, 2);
    await client.listLatestJobs('owner', 'repo', 8);
    await assert.rejects(client.rerun('owner', 'repo', 8, true), (error) => error.status === 403 && error.kind === 'permission');
    assert.equal(client.authInvalid, false);
    await client.listRuns('owner', 'repo');
    assert.deepEqual(seen.map(([url, method]) => [new URL(url).pathname + new URL(url).search, method]), [
        ['/repos/owner/repo/actions/runs/8', 'GET'],
        ['/repos/owner/repo/actions/runs/8/attempts/2/jobs?per_page=100', 'GET'],
        ['/repos/owner/repo/actions/runs/8/jobs?filter=latest&per_page=100', 'GET'],
        ['/repos/owner/repo/actions/runs/8/rerun-failed-jobs', 'POST'],
        ['/repos/owner/repo/actions/runs?per_page=30', 'GET']
    ]);
});

test('credential reset during delayed JSON rejects old data and does not cache it', async () => {
    let parse;
    const client = new GitHubClient({ fetchImpl: async () => ({ status: 200, ok: true, headers: new Headers(), json: () => new Promise((resolve) => { parse = resolve; }) }) });
    client.reset('old'); const request = client.listRuns('a', 'b'); await new Promise((resolve) => setImmediate(resolve));
    client.reset('new'); parse({ total_count: 1, workflow_runs: [{ id: 1 }] });
    await assert.rejects(request, (error) => error.kind === 'cancelled'); assert.equal(client.cache.size, 0);
});

function fakeTimers() {
    let now = 0, id = 0; const timers = new Map();
    return { timers, now: () => now, setTimer(fn, delay) { const key = ++id; timers.set(key, { fn, at: now + delay }); return key; }, clearTimer(key) { timers.delete(key); }, async advance(ms) { now += ms; const ready = [...timers].filter(([, timer]) => timer.at <= now); for (const [key, timer] of ready) { timers.delete(key); timer.fn(); } await Promise.resolve(); await Promise.resolve(); } };
}
test('foreground monitor coalesces manual refresh and schedules active runs only after settlement', async () => {
    const timers = fakeTimers(); let calls = 0, release;
    const monitor = new ForegroundMonitor({ cycle: () => { calls++; return new Promise((resolve) => { release = resolve; }); }, setTimer: timers.setTimer, clearTimer: timers.clearTimer, now: timers.now });
    const first = monitor.start();
    const manual = monitor.refresh();
    assert.equal(first, manual); assert.equal(calls, 0);
    await Promise.resolve(); assert.equal(calls, 1);
    release({ runs: [{ status: 'in_progress' }] }); await first;
    assert.equal(timers.timers.size, 1);
    await timers.advance(9999); assert.equal(calls, 1);
    await timers.advance(1); await Promise.resolve(); assert.equal(calls, 2);
    monitor.stop();
});

test('hidden monitor pauses and aborts; resume starts immediately; reset invalidates stale cycle', async () => {
    const timers = fakeTimers(); let visible = true, calls = 0, signals = [];
    const monitor = new ForegroundMonitor({ cycle: (signal) => { calls++; signals.push(signal); return new Promise(() => {}); }, isVisible: () => visible, setTimer: timers.setTimer, clearTimer: timers.clearTimer, now: timers.now });
    monitor.start(); await Promise.resolve();
    visible = false; monitor.pause(); assert.equal(signals[0].aborted, true);
    visible = true; monitor.resume(); await Promise.resolve(); assert.equal(calls, 2);
    monitor.reset(); await Promise.resolve(); assert.equal(signals[1].aborted, true); assert.equal(calls, 3);
    monitor.stop(); assert.equal(signals[2].aborted, true);
});

test('monitor accepts scheduler cooldowns and stops timers when every profile needs intervention', async () => {
    const timers = fakeTimers(); let calls = 0;
    const monitor = new ForegroundMonitor({ cycle: () => { calls++; return { runs: [{ status: 'unknown_future_status' }], nextAt: timers.now() + 90000, continueMonitoring: true }; }, setTimer: timers.setTimer, clearTimer: timers.clearTimer, now: timers.now });
    await monitor.start();
    assert.equal([...timers.timers.values()][0].at, 90000);
    monitor.stop();
    const idle = new ForegroundMonitor({ cycle: () => ({ runs: [], continueMonitoring: false }), setTimer: timers.setTimer, clearTimer: timers.clearTimer, now: timers.now });
    await idle.start(); assert.equal(timers.timers.size, 0); assert.equal(calls, 1); idle.stop();
});

test('explicit cooldown wakes before idle cadence and is not stretched to base cadence', async () => {
    const timers = fakeTimers();
    const monitor = new ForegroundMonitor({ cycle: () => ({ runs: [], nextAt: 12000, continueMonitoring: true }), setTimer: timers.setTimer, clearTimer: timers.clearTimer, now: timers.now });
    await monitor.start();
    assert.equal([...timers.timers.values()][0].at, 12000);
    monitor.stop();
});

test('poll cadence budgets eligible reads only and respects the earliest account cooldown', () => {
    const now = 1000;
    assert.equal(nextPollAt(now, 1, false, []), now + 30000);
    assert.equal(nextPollAt(now, 1, false, [now + 12000]), now + 12000);
    assert.equal(nextPollAt(now, 0, false, [now + 12000]), now + 12000);
    assert.equal(nextPollAt(now, 0, false, []), 0);
});

function toolbarChrome({ contexts, stored, created = { id: 11, windowId: 2 }, failFocusOnce = false }) {
    const calls = [];
    let focusFailed = false;
    const session = { async get() { return { dashboardTabId: stored }; }, async set(value) { calls.push(['store', value]); } };
    const chrome = {
        runtime: {
            getURL: (name) => `chrome-extension://id/${name}`,
            async getContexts(filter) { calls.push(['getContexts', filter]); return typeof contexts === 'function' ? contexts() : contexts; }
        },
        storage: { session },
        action: { onClicked: { addListener(fn) { chrome.handler = fn; } } },
        tabs: {
            async create(value) { calls.push(['create', value]); return { ...created, url: value.url }; },
            async update(...args) {
                calls.push(['tab-update', ...args]);
                if (failFocusOnce && !focusFailed) { focusFailed = true; throw new Error('tab closed'); }
            },
            async get() { throw new Error('tabs.get must not be used for dashboard discovery'); },
            async query() { throw new Error('tabs.query must not be used for dashboard discovery'); }
        },
        windows: {
            async update(...args) {
                calls.push(['window-update', ...args]);
                if (failFocusOnce && !focusFailed) { focusFailed = true; throw new Error('tab closed'); }
            }
        }
    };
    const context = { chrome, module: { exports: {} } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8'), context);
    return { calls, openDashboard: context.module.exports.openDashboard };
}

test('toolbar reuses its own dashboard context without reading tab URLs', async () => {
    const dashboardUrl = 'chrome-extension://id/dashboard.html';
    const { calls, openDashboard } = toolbarChrome({
        stored: 8,
        contexts: [{ documentUrl: dashboardUrl, tabId: 8, windowId: 2, frameId: 0 }]
    });
    const tab = await openDashboard();
    assert.equal(tab.id, 8);
    const filter = calls.find(([name]) => name === 'getContexts')[1];
    assert.equal(filter.contextTypes[0], 'TAB');
    assert.equal(filter.documentUrls[0], dashboardUrl);
    assert.ok(calls.some(([name, value]) => name === 'store' && value.dashboardTabId === 8));
    assert.ok(calls.some(([name]) => name === 'window-update'));
    assert.ok(calls.some(([name]) => name === 'tab-update'));
    assert.equal(calls.filter(([name]) => name === 'create').length, 0);
});

test('toolbar ignores stale stored tabs and foreign contexts, then creates when none remain', async () => {
    const dashboardUrl = 'chrome-extension://id/dashboard.html';
    const foreign = toolbarChrome({
        stored: 8,
        contexts: [
            { documentUrl: 'chrome-extension://other/dashboard.html', tabId: 8, windowId: 2, frameId: 0 },
            { documentUrl: dashboardUrl, tabId: 9, windowId: 2, frameId: 7 },
            { documentUrl: dashboardUrl, tabId: undefined, windowId: 2, frameId: 0 },
            { documentUrl: dashboardUrl, tabId: 9, windowId: 2, frameId: 0 }
        ],
        created: { id: 11, windowId: 2 }
    });
    const reused = await foreign.openDashboard();
    assert.equal(reused.id, 9);
    assert.ok(foreign.calls.some(([name, value]) => name === 'store' && value.dashboardTabId === 9));
    assert.equal(foreign.calls.filter(([name]) => name === 'create').length, 0);

    const empty = toolbarChrome({ stored: 8, contexts: [], created: { id: 12, windowId: 3 } });
    const created = await empty.openDashboard();
    assert.equal(created.id, 12);
    assert.ok(empty.calls.some(([name, value]) => name === 'store' && value.dashboardTabId === 12));
    assert.ok(empty.calls.some(([name, value]) => name === 'create' && value.url === dashboardUrl));
});

test('toolbar prefers the stored dashboard among live contexts and coalesces rapid clicks', async () => {
    const dashboardUrl = 'chrome-extension://id/dashboard.html';
    const { calls, openDashboard } = toolbarChrome({
        stored: 9,
        contexts: [
            { documentUrl: dashboardUrl, tabId: 7, windowId: 2, frameId: 0 },
            { documentUrl: dashboardUrl, tabId: 9, windowId: 2, frameId: 0 }
        ],
        created: { id: 11, windowId: 2 }
    });
    assert.equal((await openDashboard()).id, 9);

    let release;
    const gated = toolbarChrome({ stored: undefined, contexts: new Promise((resolve) => { release = resolve; }), created: { id: 14, windowId: 2 } });
    const first = gated.openDashboard(), second = gated.openDashboard();
    release([]);
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.id, 14);
    assert.equal(two.id, 14);
    assert.equal(gated.calls.filter(([name]) => name === 'create').length, 1);
    assert.equal(calls.filter(([name]) => name === 'create').length, 0);
});

test('toolbar recovers when the discovered dashboard closes before focus', async () => {
    const dashboardUrl = 'chrome-extension://id/dashboard.html';
    let listed = 0;
    const { calls, openDashboard } = toolbarChrome({
        stored: 8,
        contexts: () => (++listed === 1
            ? [{ documentUrl: dashboardUrl, tabId: 8, windowId: 2, frameId: 0 }]
            : []),
        created: { id: 15, windowId: 4 },
        failFocusOnce: true
    });
    const tab = await openDashboard();
    assert.equal(tab.id, 15);
    assert.ok(calls.some(([name, value]) => name === 'store' && value.dashboardTabId === 15));
    assert.equal(calls.filter(([name]) => name === 'create').length, 1);
});

test('sent POST 5xx is uncertain while explicit denials stay definite', async () => {
    const forStatus = (status) => new GitHubClient({ fetchImpl: async () => response(status, { message: 'boom' }) });
    for (const status of [500, 502, 503]) {
        const client = forStatus(status); client.reset('token');
        await assert.rejects(client.rerun('a', 'b', 1, false), (error) => error.kind === 'http' && error.status === status && error.ambiguous === true);
    }
    const denied = new GitHubClient({ fetchImpl: async () => response(422, { message: 'Validation failed' }) }); denied.reset('token');
    await assert.rejects(denied.rerun('a', 'b', 1, false), (error) => error.kind === 'http' && error.ambiguous === false);
    const forbidden = new GitHubClient({ fetchImpl: async () => response(403, { message: 'Denied' }) }); forbidden.reset('token');
    await assert.rejects(forbidden.rerun('a', 'b', 1, false), (error) => error.kind === 'permission' && !error.ambiguous);
    assert.equal(forbidden.authInvalid, false);
    await assert.rejects(forbidden.listRuns('a', 'b'), (error) => error.kind === 'permission');
});

test('unrelated profile credential reset never strands the other profile request', async () => {
    let personalResolve;
    const personal = new GitHubClient({ fetchImpl: () => new Promise((resolve) => { personalResolve = resolve; }) });
    let workCalls = 0;
    const work = new GitHubClient({ fetchImpl: async () => { workCalls++; return runResponse([{ id: 2 }]); } });
    personal.reset('personal-pat'); work.reset('work-pat');
    const personalGet = personal.listRuns('acme', 'app');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(personalResolve);
    // Unrelated Work token rotation aborts only Work-owned work, never Personal.
    const workRequest = work.listRuns('acme', 'other');
    work.reset('work-rotated');
    await assert.rejects(workRequest, (error) => error.kind === 'cancelled');
    personalResolve(runResponse([{ id: 7, run_attempt: 1 }]));
    assert.equal((await personalGet).runs[0].id, 7);
    // Personal POST still sends once with its own PAT after the unrelated change.
    let postAuth = '';
    const poster = new GitHubClient({ fetchImpl: async (url, options) => { postAuth = options.headers.Authorization; return response(201, null, { 'Content-Length': '0' }); } });
    poster.reset('personal-pat');
    await poster.rerun('acme', 'app', 7, false);
    assert.equal(postAuth, 'Bearer personal-pat');
});

test('run metadata merges monotonically and only real advances invalidate jobs', () => {
    assert.equal(isAttemptAdvance(1, 2), true);
    assert.equal(isAttemptAdvance(2, 1), false);
    assert.equal(isAttemptAdvance(2, 2), false);
    assert.equal(attemptNumber('bad'), null);
    // Expansion while latest poll replaces the same run object keeps attempt identity.
    const expanded = { id: 1, run_attempt: 1, status: 'completed' };
    const replaced = { id: 1, run_attempt: 1, status: 'completed', conclusion: 'failure' };
    assert.deepEqual(mergeRunMetadata(expanded, replaced).run.conclusion, 'failure');
    // Lagging list/304 returning attempt1 never downgrades known attempt2.
    const known = { id: 1, run_attempt: 2, status: 'completed' };
    const lagging = { id: 1, run_attempt: 1, status: 'completed' };
    const kept = mergeRunMetadata(known, lagging);
    assert.equal(kept.downgraded, true);
    assert.equal(kept.run.run_attempt, 2);
    assert.equal(shouldInvalidateJobs(1, 2), true);
    assert.equal(shouldInvalidateJobs(2, 1), false);
    assert.equal(shouldInvalidateJobs(2, 2), false);
    // Pending exact-ID advance clears only when metadata proves a higher attempt.
    assert.equal(isAttemptAdvance(1, 2), true);
    assert.equal(isAttemptAdvance(1, 1), false);
    assert.equal(isAttemptAdvance(null, 1), true);
});

test('unknown attempts never wipe a known run attempt', () => {
    assert.equal(attemptNumber(null), null);
    assert.equal(attemptNumber(undefined), null);
    assert.equal(attemptNumber(''), null);
    assert.equal(attemptNumber('   '), null);
    assert.equal(attemptNumber(0), null);
    assert.equal(attemptNumber(-1), null);
    assert.equal(attemptNumber(1.5), null);
    assert.equal(attemptNumber('2'), 2);
    assert.equal(isAttemptAdvance(1, null), false);
    assert.equal(isAttemptAdvance(null, null), false);
    assert.equal(isAttemptAdvance(undefined, 1), true);
    const known = { id: 1, run_attempt: 2, status: 'completed', conclusion: 'failure' };
    for (const unknown of [undefined, null, '', '   ', 0]) {
        const incoming = { id: 1, status: 'completed', conclusion: 'success', run_attempt: unknown };
        const merged = mergeRunMetadata(known, incoming);
        assert.equal(merged.downgraded, false);
        assert.equal(merged.advanced, false);
        assert.equal(merged.run.run_attempt, 2);
        assert.equal(merged.run.conclusion, 'success');
    }
    // Missing attempt key also preserves the known number while merging other fields.
    const missing = mergeRunMetadata(known, { id: 1, status: 'completed' });
    assert.equal(missing.run.run_attempt, 2);
    assert.equal(mergeRunMetadata({ id: 1, run_attempt: 1 }, { id: 1, run_attempt: 2 }).advanced, true);
});
