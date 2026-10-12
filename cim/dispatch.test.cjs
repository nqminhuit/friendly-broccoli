const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubClient, ApiError, API_VERSION } = require('./api.js');
const Schema = require('./workflow-schema.js');

function response(status, data, headers = {}) {
    const normalized = new Headers(headers);
    return { status, ok: status >= 200 && status < 300, headers: normalized, json: async () => data, clone() { return this; } };
}
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

// --- schema: trigger forms ---
test('unquoted on stays dispatchable under YAML 1.2 core schema', () => {
    assert.equal(Schema.parseWorkflowYaml('on: workflow_dispatch').dispatchable, true);
    assert.equal(Schema.parseWorkflowYaml('on: [push, workflow_dispatch]').dispatchable, true);
    assert.equal(Schema.parseWorkflowYaml('on:\n  workflow_dispatch: null').dispatchable, true);
    assert.equal(Schema.parseWorkflowYaml('on:\n  workflow_dispatch:\n    inputs:\n      greeting:\n        description: hi').inputs[0].type, 'string');
    assert.equal(Schema.parseWorkflowYaml('on: push').dispatchable, false);
});

test('legacy omitted type defaults to string with description and required', () => {
    const parsed = Schema.parseWorkflowYaml('on:\n  workflow_dispatch:\n    inputs:\n      name:\n        description: Your name\n        required: true\n        default: world');
    assert.equal(parsed.dispatchable, true);
    assert.deepEqual(parsed.inputs[0], { name: 'name', type: 'string', description: 'Your name', required: true, default: 'world', options: undefined });
});

test('choice options validate defaults and reject bad option lists', () => {
    const good = Schema.parseWorkflowYaml('on:\n  workflow_dispatch:\n    inputs:\n      env:\n        type: choice\n        required: true\n        options:\n          - dev\n          - prod\n        default: prod');
    assert.equal(good.dispatchable, true);
    assert.deepEqual(good.inputs[0].options, ['dev', 'prod']);
    assert.equal(Schema.parseWorkflowYaml('on:\n  workflow_dispatch:\n    inputs:\n      env:\n        type: choice\n        options:\n          - dev\n        default: other').dispatchable, false);
    assert.equal(Schema.parseWorkflowYaml('on:\n  workflow_dispatch:\n    inputs:\n      env:\n        type: choice').dispatchable, false);
});

test('required boolean false and required zero are valid', () => {
    const inputs = [{ name: 'flag', type: 'boolean', required: true }, { name: 'count', type: 'number', required: true }];
    assert.equal(Schema.validateDispatchValues(inputs, { flag: false, count: 0 }).ok, true);
    assert.equal(Schema.validateDispatchValues(inputs, { flag: false }).ok, false);
    assert.equal(Schema.validateDispatchValues([{ name: 'n', type: 'number', required: true }], { n: 'oops' }).ok, false);
    assert.equal(Schema.validateDispatchValues([{ name: 'n', type: 'number', required: false }], { n: Infinity }).ok, false);
});

test('string whitespace UTF-8 and multiline are preserved', () => {
    const parsed = Schema.parseWorkflowYaml('on:\n  workflow_dispatch:\n    inputs:\n      msg:\n        type: string\n        default: hello');
    assert.equal(parsed.dispatchable, true);
    const checked = Schema.validateDispatchValues([{ name: 'msg', type: 'string', required: false }], { msg: '  hello \u2603\nsecond line  ' });
    assert.equal(checked.ok, true);
    assert.equal(checked.inputs.msg, '  hello \u2603\nsecond line  ');
    const block = Schema.parseWorkflowYaml('on:\n  workflow_dispatch:\n    inputs:\n      body:\n        type: string\n        description: text\n');
    assert.equal(block.dispatchable, true);
});

test('max 25 inputs and payload limits are enforced', () => {
    let many = 'on:\n  workflow_dispatch:\n    inputs:\n';
    for (let i = 0; i < 26; i++) many += `      f${i}:\n        type: string\n`;
    assert.match(Schema.parseWorkflowYaml(many).reason, /at most 25/);
    assert.equal(Schema.isPayloadTooLarge('main', { big: 'x'.repeat(70000) }), true);
    assert.equal(Schema.isPayloadTooLarge('main', { small: 'hi' }), false);
});

test('unknown fields and unsupported types are refused', () => {
    assert.equal(Schema.parseWorkflowYaml('on:\n  workflow_dispatch:\n    inputs:\n      a:\n        type: object').dispatchable, false);
    assert.equal(Schema.parseWorkflowYaml('on:\n  workflow_dispatch:\n    inputs:\n      a:\n        type: string\n        bogus: 1').dispatchable, false);
    const checked = Schema.validateDispatchValues([{ name: 'a', type: 'string', required: false }], { a: 'x', extra: 'y' });
    assert.equal(checked.ok, false);
    assert.match(checked.errors.extra, /Unknown/);
});

test('bad YAML duplicate keys executable tags depth and aliases are refused safely', () => {
    assert.equal(Schema.parseWorkflowYaml('a: [unclosed').dispatchable, false);
    assert.equal(Schema.parseWorkflowYaml('a: 1\na: 2').dispatchable, false);
    assert.equal(Schema.parseWorkflowYaml('on: workflow_dispatch\nx: !!js/function foo').dispatchable, false);
    let deep = 'x: ';
    for (let i = 0; i < 60; i++) deep += '{k: ';
    deep += '1';
    for (let i = 0; i < 60; i++) deep += '}';
    assert.equal(Schema.parseWorkflowYaml(deep).dispatchable, false);
    assert.equal(Schema.parseWorkflowYaml('on:\n  workflow_dispatch:\n    inputs:\n      __proto__:\n        type: string').dispatchable, false);
    assert.equal({}.polluted, undefined);
    assert.equal(Schema.parseWorkflowYaml('a'.repeat(1100000)).dispatchable, false);
});

test('environment behaves as labelled text and choice default must match options', () => {
    const parsed = Schema.parseWorkflowYaml('on:\n  workflow_dispatch:\n    inputs:\n      target:\n        type: environment\n        description: Deploy target\n        required: true');
    assert.equal(parsed.dispatchable, true);
    assert.equal(parsed.inputs[0].type, 'environment');
    assert.equal(Schema.validateDispatchValues(parsed.inputs, { target: 'production' }).ok, true);
    assert.equal(Schema.validateDispatchValues(parsed.inputs, {}).ok, false);
});

// --- api: dispatch routes ---
test('workflow routes encode segments and decode UTF-8 base64 without following URLs', async () => {
    const seen = [];
    const yaml = 'on:\n  workflow_dispatch:\n    inputs:\n      msg:\n        type: string\n';
    const content = Buffer.from('hello \u2603', 'utf8').toString('base64');
    const client = new GitHubClient({ fetchImpl: async (url, options) => {
        seen.push({ url, method: options.method, auth: options.headers.Authorization });
        if (url.includes('/actions/workflows?') || url.includes('/actions/workflows?per_page')) return response(200, { total_count: 1, workflows: [{ id: 7, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] }, { 'content-type': 'application/json' });
        if (url.includes('/contents/')) {
            assert.ok(!url.includes('download_url'));
            return response(200, { type: 'file', encoding: 'base64', content, size: 9, path: '.github/workflows/ci.yml' }, { 'content-type': 'application/json' });
        }
        if (url.endsWith('/dispatches')) {
            assert.equal(options.headers['Content-Type'], 'application/json');
            const body = JSON.parse(options.body);
            assert.equal(body.ref, 'main');
            return response(200, { workflow_run_id: 99, run_url: 'https://api.github.com/repos/o/r/actions/runs/99', html_url: 'https://github.com/o/r/actions/runs/99' }, { 'content-type': 'application/json' });
        }
        if (url === 'https://api.github.com/repos/o/r') return response(200, { default_branch: 'main' }, { 'content-type': 'application/json' });
        throw new Error(`unexpected ${url}`);
    } });
    client.reset('pat');
    const repo = await client.getRepo('o', 'r');
    assert.equal(repo.default_branch, 'main');
    const listed = await client.listWorkflows('space owner', 'repo/name');
    assert.ok(seen[1].url.includes('space%20owner/repo%2Fname/actions/workflows'));
    assert.equal(listed.workflows[0].id, 7);
    const file = await client.getWorkflowFile('o', 'r', '.github/workflows/ci.yml', 'main');
    assert.equal(file.text, 'hello \u2603');
    const out = await client.dispatchWorkflow('o', 'r', 7, { ref: 'main', inputs: { msg: 'hi' } });
    assert.equal(out.runId, 99);
    assert.equal(out.htmlUrl, 'https://github.com/o/r/actions/runs/99');
    assert.equal(seen.filter((item) => item.method === 'POST').length, 1);
});

test('unsafe workflow path ref id and html urls are rejected', async () => {
    const client = new GitHubClient({ fetchImpl: async () => { throw new Error('must not fetch'); } });
    client.reset('pat');
    await assert.rejects(client.getWorkflowFile('o', 'r', '.github/other/evil.yml', 'main'), /unsafe workflow file path/);
    await assert.rejects(client.getWorkflowFile('o', 'r', '.github/workflows/ci.yml', '../main'), /valid branch or tag/);
    await assert.rejects(client.getWorkflowFile('o', 'r', '.github/workflows/ci.yml', 'main?x=1'), /valid branch or tag/);
    await assert.rejects(client.dispatchWorkflow('o', 'r', '../evil', { ref: 'main', inputs: {} }), /unsafe workflow identifier/);
    await assert.rejects(client.dispatchWorkflow('o', 'r', 1, { ref: '', inputs: {} }), /valid branch or tag/);
    await assert.rejects(client.dispatchWorkflow('o', 'r', 1, { ref: 'main', inputs: JSON.parse('{"__proto__":"x"}') }), /Unknown workflow input/);
    const badHtml = new GitHubClient({ fetchImpl: async () => response(200, { workflow_run_id: 5, html_url: 'https://evil.example/run' }, { 'content-type': 'application/json' }) });
    badHtml.reset('pat');
    await assert.rejects(badHtml.dispatchWorkflow('o', 'r', 1, { ref: 'main', inputs: {} }), /did not return a usable run/);
    const missing = new GitHubClient({ fetchImpl: async () => response(200, {}, { 'content-type': 'application/json' }) });
    missing.reset('pat');
    await assert.rejects(missing.dispatchWorkflow('o', 'r', 1, { ref: 'main', inputs: {} }), (error) => error.ambiguous === true);
});

test('malformed base64 non-file and oversized workflow files are rejected', async () => {
    for (const payload of [{ type: 'dir', encoding: 'base64', content: b64('x') }, { type: 'file', encoding: 'utf-8', content: b64('x') }, { type: 'file', encoding: 'base64', content: '!!!' }]) {
        const client = new GitHubClient({ fetchImpl: async () => response(200, payload, { 'content-type': 'application/json' }) });
        client.reset('pat');
        await assert.rejects(client.getWorkflowFile('o', 'r', '.github/workflows/ci.yml', 'main'), /malformed workflow file/);
    }
});

test('missing Contents permission surfaces without suspending run reads', async () => {
    const client = new GitHubClient({ fetchImpl: async (url) => {
        if (url.includes('/contents/')) return response(403, { message: 'Resource not accessible' }, { 'content-type': 'application/json' });
        return response(200, { total_count: 0, workflow_runs: [] }, { 'content-type': 'application/json' });
    } });
    client.reset('pat');
    await assert.rejects(client.getWorkflowFile('o', 'r', '.github/workflows/ci.yml', 'main'), (error) => error.kind === 'permission' && error.status === 403);
    assert.equal(client.authInvalid, false);
    const runs = await client.listRuns('o', 'r');
    assert.equal(runs.runs.length, 0);
});

test('dispatch POST is paced serialized single-shot with JSON body and uncertain failures', async () => {
    let calls = 0;
    let now = 1000;
    let scheduled = null;
    const client = new GitHubClient({ now: () => now, setTimer: (fn, delay) => { scheduled = { fn, delay }; return 1; }, clearTimer: () => {}, fetchImpl: async (url, options) => {
        calls++;
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['Content-Type'], 'application/json');
        assert.ok(options.body.includes('"ref":"main"'));
        return response(200, { workflow_run_id: 11, html_url: 'https://github.com/o/r/actions/runs/11' }, { 'content-type': 'application/json' });
    } });
    client.reset('pat');
    await client.dispatchWorkflow('o', 'r', 3, { ref: 'main', inputs: {} });
    const second = client.dispatchWorkflow('o', 'r', 3, { ref: 'main', inputs: {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scheduled.delay, 1000);
    assert.equal(calls, 1);
    now += 1000; scheduled.fn(); await second;
    assert.equal(calls, 2);
    const failing = new GitHubClient({ fetchImpl: async () => response(500, { message: 'boom' }) });
    failing.reset('pat');
    await assert.rejects(failing.dispatchWorkflow('o', 'r', 3, { ref: 'main', inputs: {} }), (error) => error.ambiguous === true);
    const denied = new GitHubClient({ fetchImpl: async () => response(403, { message: 'nope' }) });
    denied.reset('pat');
    await assert.rejects(denied.dispatchWorkflow('o', 'r', 3, { ref: 'main', inputs: {} }), (error) => error.kind === 'permission' && /Actions: write/.test(error.message) && denied.authInvalid === false);
});

test('dispatch clears run-feed caches for its repository only', async () => {
    const client = new GitHubClient({ fetchImpl: async (url, options) => {
        if (options.method === 'GET') return response(200, { total_count: 0, workflow_runs: [] }, { ETag: 'e1', 'content-type': 'application/json' });
        return response(200, { workflow_run_id: 21, html_url: 'https://github.com/a/b/actions/runs/21' }, { 'content-type': 'application/json' });
    } });
    client.reset('pat');
    await client.listRuns('a', 'b');
    await client.listRuns('a', 'other');
    assert.equal(client.cache.size, 2);
    await client.dispatchWorkflow('a', 'b', 9, { ref: 'main', inputs: {} });
    const remaining = [...client.cache.keys()];
    assert.equal(remaining.length, 1);
    assert.ok(remaining[0].includes('/repos/a/other/'));
});
