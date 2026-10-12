const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { parseRepositories, SettingsStore } = require('./settings.js');
const { API_VERSION, GitHubClient, ApiError, paginationLinks } = require('./api.js');
const { ForegroundMonitor } = require('./monitor.js');

test('repository input trims, deduplicates case-insensitively, and rejects unsafe syntax', () => {
    assert.deepEqual(parseRepositories(' octo/one\nOCTO/ONE\n team/repo-name \nhttps://github.com/a/b\n../bad\nowner/repo?x'), {
        repos: ['octo/one', 'team/repo-name'],
        errors: ['Line 4: enter owner/repository only (no URL, query, or path).', 'Line 5: enter owner/repository only (no URL, query, or path).', 'Line 6: enter owner/repository only (no URL, query, or path).']
    });
});

function storageArea(initial = {}) {
    const values = { ...initial };
    return { values, async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]])); }, async set(next) { Object.assign(values, next); }, async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; } };
}
test('token migration, session-only default, remembered save, and forget clear both stores', async () => {
    const local = storageArea({ repositories: ['a/b'], rememberToken: true, token: 'legacy' });
    const session = storageArea();
    const store = new SettingsStore({ local, session });
    assert.equal((await store.load()).token, 'legacy');
    assert.equal(session.values.token, 'legacy');
    const saved = await store.save({ repos: ['c/d'], rememberToken: false, tokenInput: '' });
    assert.equal(saved.token, 'legacy');
    assert.equal(local.values.token, undefined);
    assert.equal(session.values.token, 'legacy');
    await store.save({ repos: ['c/d'], rememberToken: true, tokenInput: 'new-token' });
    assert.equal(local.values.token, 'new-token');
    await store.forgetToken();
    assert.equal(local.values.token, undefined);
    assert.equal(session.values.token, undefined);
    assert.equal(local.values.rememberToken, false);
});

function response(status, data, headers = {}) {
    const normalized = new Headers(headers);
    return { status, ok: status >= 200 && status < 300, headers: normalized, json: async () => data, clone() { return this; } };
}
const runResponse = (items = []) => response(200, { total_count: items.length, workflow_runs: items }, { ETag: 'etag-1' });

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
    const links = paginationLinks('<https://api.github.com.evil.test/repos/a/b/actions/runs?page=2>; rel="next", <https://api.github.com/repos/a/b/actions/runs?page=2>; rel="next"', '/repos/a/b/actions/runs');
    assert.equal(links.next, 'https://api.github.com/repos/a/b/actions/runs?page=2');
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
    await assert.rejects(request, (error) => error.kind === 'network');
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

test('rate limit honors retry-after and secondary rate limit has a minimum pause', async () => {
    let now = 100000, status = 429;
    const client = new GitHubClient({ now: () => now, fetchImpl: async () => response(status, { message: 'secondary rate limit' }, { 'Retry-After': '12', 'X-RateLimit-Remaining': '3' }) });
    client.reset('token');
    await assert.rejects(client.listRuns('a', 'b'), (error) => error.kind === 'rate-limit' && error.retryAt === now + 12000);
    status = 403; client.reset('token');
    await assert.rejects(client.listRuns('a', 'b'), (error) => error.kind === 'rate-limit' && error.retryAt >= now + 60000);
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

test('toolbar reuses only the dashboard tab, restores focus, and coalesces clicks', async () => {
    const calls = []; let resolveQuery, tabUrl = 'https://example.com';
    const session = { async get() { return { dashboardTabId: 8 }; }, async set(value) { calls.push(['store', value]); } };
    const chrome = {
        runtime: { getURL: (path) => `chrome-extension://id/${path}` },
        storage: { session }, action: { onClicked: { addListener(fn) { chrome.handler = fn; } } },
        tabs: { async get(id) { calls.push(['get', id]); return { id, url: tabUrl, windowId: 2 }; }, query() { return new Promise((resolve) => { resolveQuery = resolve; }); }, async create(value) { calls.push(['create', value]); return { id: 11, windowId: 2, url: value.url }; }, async update(...args) { calls.push(['tab-update', ...args]); } },
        windows: { async update(...args) { calls.push(['window-update', ...args]); } }
    };
    const context = { chrome, module: { exports: {} } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8'), context);
    const first = context.module.exports.openDashboard(), second = context.module.exports.openDashboard();
    await new Promise((resolve) => setImmediate(resolve)); resolveQuery([]);
    await Promise.all([first, second]);
    assert.equal(calls.filter(([name]) => name === 'create').length, 1);
    assert.ok(calls.some(([name]) => name === 'window-update'));
    tabUrl = 'chrome-extension://id/dashboard.html';
    await context.module.exports.openDashboard();
    assert.equal(calls.filter(([name]) => name === 'create').length, 1);
});
