const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.CimWorkflowSchema = require('./workflow-schema.js');
globalThis.Option = class Option {
    constructor(label, value) {
        this.label = label;
        this.textContent = label;
        this.value = value ?? '';
        this.dataset = {};
    }
};
if (typeof globalThis.confirm !== 'function') globalThis.confirm = () => true;

class FakeEl {
    constructor(tag, doc) {
        this.tagName = String(tag || 'div').toUpperCase();
        this.ownerDocument = doc;
        this.children = [];
        this.dataset = {};
        this.listeners = {};
        this._text = '';
        this._value = '';
        this.hidden = false;
        this.disabled = false;
        this.checked = false;
        this.type = '';
        this.name = '';
        this.placeholder = '';
        this.className = '';
        this.options = [];
        this.open = false;
    }
    get textContent() {
        if (this.children.length) return this.children.map((child) => child.textContent).join('');
        return this._text;
    }
    set textContent(value) { this._text = String(value ?? ''); }
    get value() {
        if (this.tagName === 'SELECT') {
            if (this.options.some((option) => option.value === this._value)) return this._value;
            return this.options[0]?.value ?? this._value;
        }
        return this._value;
    }
    set value(next) { this._value = String(next ?? ''); }
    get selectedOptions() {
        const found = this.options.find((option) => option.value === this.value);
        return found ? [found] : this.options.slice(0, 1);
    }
    append(...nodes) {
        for (const node of nodes) {
            this.children.push(node);
            if (this.tagName === 'SELECT' && node && 'value' in node) this.options.push(node);
        }
    }
    replaceChildren(...nodes) {
        this.children = [];
        this._text = '';
        if (this.tagName === 'SELECT') this.options = [];
        this.append(...nodes);
    }
    querySelectorAll(selector) {
        if (selector === 'button') return this.children.filter((child) => child.tagName === 'BUTTON');
        if (selector === '[data-input]') return this.children.filter((child) => child.dataset?.input !== undefined);
        if (selector === '[data-error-for]') return this.children.filter((child) => child.dataset?.errorFor !== undefined);
        return [];
    }
    querySelector(selector) {
        if (selector === '[name]') return this.children.find((child) => child.name) || null;
        return null;
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener() {}
    setAttribute() {}
    focus() {}
    remove() { this.removed = true; }
    showModal() { this.open = true; }
    close() {
        this.open = false;
        const fns = [...(this.listeners.close || [])];
        queueMicrotask(() => { for (const fn of fns) fn(); });
    }
    click() { for (const fn of this.listeners.click || []) fn(); }
    fire(type, event) { for (const fn of this.listeners[type] || []) fn(event); }
}

function fakeDocument() {
    const doc = {
        elements: new Map(),
        getElementById(id) {
            if (!doc.elements.has(id)) {
                const tag = /dispatch-(profile|repo|workflow)$/.test(id) ? 'select' : 'div';
                doc.elements.set(id, new FakeEl(tag, doc));
            }
            return doc.elements.get(id);
        },
        createElement(tag) { return new FakeEl(tag, doc); },
    };
    return doc;
}

const flush = async (rounds = 10) => { for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve)); };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup({ profiles, slow = {}, visible = true } = {}) {
    const doc = fakeDocument();
    const calls = { repos: 0, workflows: 0, files: 0, posts: 0, bodies: [] };
    const releases = {};
    const gate = (name) => new Promise((resolve) => { releases[name] = resolve; });
    const yaml = 'on:\n  workflow_dispatch:\n    inputs:\n      greeting:\n        description: hi\n        required: true\n        type: string\n        default: Hello\n';
    const client = {
        getRepo: async (owner, repo, { signal } = {}) => {
            calls.repos++;
            if (slow.repo) await gate('repo');
            if (signal?.aborted) throw Object.assign(new Error('aborted'), { kind: 'cancelled' });
            return { default_branch: 'main' };
        },
        listWorkflows: async (owner, repo, { url, signal } = {}) => {
            calls.workflows++;
            if (slow.workflows) await gate('workflows');
            if (signal?.aborted) throw Object.assign(new Error('aborted'), { kind: 'cancelled' });
            if (slow.cycle) {
                const next = `https://api.github.com/repos/${owner}/${repo}/actions/workflows?per_page=100&page=2`;
                return { workflows: [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }], links: { next } };
            }
            return { workflows: [{ id: 11, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }], links: {} };
        },
        getWorkflowFile: async (owner, repo, path, ref, { signal } = {}) => {
            calls.files++;
            if (slow.file) await gate('file');
            if (signal?.aborted) throw Object.assign(new Error('aborted'), { kind: 'cancelled' });
            return { text: yaml, path, ref };
        },
        dispatchWorkflow: async (owner, repo, id, { ref, inputs, signal } = {}) => {
            calls.posts++;
            calls.bodies.push({ ref, inputs });
            if (slow.post === 'hang') {
                await new Promise((_, reject) => {
                    if (signal?.aborted) reject(Object.assign(new Error('aborted after send'), { kind: 'cancelled', ambiguous: true }));
                    else signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted after send'), { kind: 'cancelled', ambiguous: true })), { once: true });
                });
            }
            if (signal?.aborted) throw Object.assign(new Error('aborted'), { kind: 'cancelled' });
            return { runId: 77, htmlUrl: 'https://github.com/acme/app/actions/runs/77' };
        },
    };
    let current = profiles;
    const entries = new Map((profiles || []).map((profile) => [profile.id, { token: profile.token, client }]));
    const dispatched = [];
    const Dispatch = require('./dispatch.js');
    const controller = Dispatch.createDispatchController({
        document: doc,
        getProfiles: () => current,
        getClientEntry: (id) => entries.get(id) || null,
        onDispatched: async (info) => { dispatched.push(info); },
        isVisible: () => visible,
    });
    const el = (id) => doc.getElementById(id);
    return {
        doc, el, calls, releases, dispatched, controller, client, entries,
        setProfiles(next) { current = next; },
        setVisible(next) { visible = next; },
        setSlow(next) { Object.assign(slow, next); },
        profileId() { return el('dispatch-profile'); },
    };
}

const PERSONAL = { id: 'personal', name: 'Personal', token: 'personal-pat', repos: ['acme/app'] };
const WORK = { id: 'work', name: 'Work', token: 'work-pat', repos: ['acme/work'] };

test('hide during slow repo GET fires no workflow or file requests', async () => {
    const harness = setup({ profiles: [PERSONAL], slow: { repo: true } });
    harness.controller.open();
    await flush();
    assert.equal(harness.calls.repos, 1);
    harness.setVisible(false);
    harness.controller.handleHidden();
    harness.releases.repo();
    await flush();
    assert.equal(harness.calls.workflows, 0);
    assert.equal(harness.calls.files, 0);
    assert.equal(harness.el('dispatch-start').disabled, true);
});

test('close cancels reads and reopen requires a freshly loaded schema', async () => {
    const harness = setup({ profiles: [PERSONAL], slow: { file: true } });
    harness.controller.open();
    await flush();
    harness.el('dispatch-ref').value = 'main';
    harness.doc.getElementById('dispatch-workflow').fire('change');
    harness.controller.close();
    harness.releases.file();
    await flush();
    assert.equal(harness.calls.posts, 0);
    harness.controller.open();
    await flush();
    // Schema read was invalidated; submitting now sends nothing.
    harness.doc.getElementById('dispatch-form').fire('submit', { preventDefault() {} });
    await flush();
    assert.equal(harness.calls.posts, 0);
    assert.match(harness.el('dispatch-status').textContent, /Load inputs/);
});

test('ref keystrokes invalidate without network and stale submit sends nothing', async () => {
    const harness = setup({ profiles: [PERSONAL] });
    harness.controller.open();
    await flush(20);
    assert.equal(harness.el('dispatch-start').disabled, false);
    harness.el('dispatch-ref').fire('input');
    assert.equal(harness.el('dispatch-start').disabled, true);
    assert.equal(harness.calls.files, 1);
    harness.doc.getElementById('dispatch-form').fire('submit', { preventDefault() {} });
    await flush();
    assert.equal(harness.calls.posts, 0);
});

test('uncertain dispatch survives close and gates only its exact target', async () => {
    const harness = setup({ profiles: [PERSONAL, WORK], slow: { post: 'hang' } });
    harness.controller.open();
    await flush(20);
    const form = harness.doc.getElementById('dispatch-form');
    const submit = form.fire.bind(form, 'submit', { preventDefault() {} });
    submit();
    await flush();
    assert.equal(harness.calls.posts, 1);
    harness.setVisible(false);
    harness.controller.handleHidden();
    await flush();
    assert.equal(harness.controller._state.uncertain.size, 1);
    harness.controller.close();
    harness.setVisible(true);
    harness.controller.open();
    await flush(20);
    const result = harness.el('dispatch-result').textContent;
    assert.match(result + harness.el('dispatch-status').textContent, /may have been accepted/);
    const before = harness.calls.posts;
    submit();
    await flush();
    assert.equal(harness.calls.posts, before);
    const ack = harness.el('dispatch-result').querySelectorAll('button').find((node) => node.textContent.includes('I checked GitHub'));
    assert.ok(ack);
    ack.click();
    assert.equal(harness.controller._state.uncertain.size, 0);
});

test('a successful dispatch leaves other targets uncertain', async () => {
    const harness = setup({ profiles: [PERSONAL, WORK] });
    harness.controller.open();
    await flush(20);
    harness.controller._state.uncertain.set('personal|acme/app|11|main|{"greeting":"hi"}', { profileId: 'personal', token: 'personal-pat', repo: 'acme/app', workflowId: '11', ref: 'main', inputs: { greeting: 'hi' }, workflowUrl: 'https://github.com/acme/app/actions/workflows/ci.yml' });
    // Switch UI to the healthy profile and dispatch there.
    harness.el('dispatch-profile').value = 'work';
    harness.doc.getElementById('dispatch-profile').fire('change');
    await flush(20);
    harness.doc.getElementById('dispatch-form').fire('submit', { preventDefault() {} });
    await flush();
    assert.equal(harness.calls.posts, 1);
    assert.equal(harness.controller._state.uncertain.size, 1);
    assert.equal(harness.dispatched.length, 1);
});

test('credential change during file read never restores the old form', async () => {
    const harness = setup({ profiles: [PERSONAL], slow: { file: true } });
    harness.controller.open();
    await flush();
    harness.el('dispatch-ref').value = 'main';
    harness.doc.getElementById('dispatch-workflow').fire('change');
    await flush(3);
    harness.setProfiles([]);
    harness.entries.delete('personal');
    harness.controller.handleProfileChange('personal');
    harness.releases.file();
    await flush();
    assert.equal(harness.el('dispatch-start').disabled, true);
    assert.equal(harness.controller._state.schemaReady, false);
});

test('cyclic workflow links fail visibly without repeated requests', async () => {
    const harness = setup({ profiles: [PERSONAL], slow: { cycle: true } });
    harness.controller.open();
    await flush(20);
    assert.equal(harness.calls.workflows, 2);
    assert.equal(harness.controller._state.workflowsTruncated, true);
    assert.match(harness.el('dispatch-schema-note').textContent, /truncated/);
});

test('a stale submit finally never enables or clobbers a newer submission', async () => {
    const harness = setup({ profiles: [PERSONAL, WORK], slow: { post: 'hang' } });
    harness.controller.open();
    await flush(20);
    const form = harness.doc.getElementById('dispatch-form');
    form.fire('submit', { preventDefault() {} });
    await flush();
    assert.equal(harness.calls.posts, 1);
    // Credential rotation aborts the stale POST and starts a fresh operation epoch.
    harness.setSlow({ post: false });
    harness.controller.handleProfileChange('personal');
    harness.el('dispatch-profile').value = 'work';
    harness.doc.getElementById('dispatch-profile').fire('change');
    await flush(20);
    form.fire('submit', { preventDefault() {} });
    await flush();
    assert.equal(harness.calls.posts, 2);
    assert.match(harness.el('dispatch-result').textContent, /Open run 77/);
    await flush();
    // The stale ambiguous settlement must not wipe the newer result.
    assert.match(harness.el('dispatch-result').textContent, /Open run 77/);
    assert.equal(harness.controller._state.submitBusy, false);
});

test('reopening re-enables controls an aborted submission disabled', async () => {
    const harness = setup({ profiles: [PERSONAL], slow: { post: 'hang' } });
    harness.controller.open();
    await flush(20);
    harness.doc.getElementById('dispatch-form').fire('submit', { preventDefault() {} });
    await flush();
    assert.equal(harness.el('dispatch-profile').disabled, true);
    harness.controller.close();
    await flush();
    harness.controller.open();
    await flush(20);
    assert.equal(harness.el('dispatch-profile').disabled, false);
    assert.equal(harness.el('dispatch-repo').disabled, false);
    assert.equal(harness.el('dispatch-load').disabled, false);
});

test('unrelated profile changes keep the current form and operation', async () => {
    const harness = setup({ profiles: [PERSONAL, WORK], slow: { post: 'hang' } });
    harness.controller.open();
    await flush(20);
    harness.doc.getElementById('dispatch-form').fire('submit', { preventDefault() {} });
    await flush();
    assert.equal(harness.calls.posts, 1);
    harness.controller.handleProfileChange('work');
    assert.equal(harness.controller._state.schemaReady, true);
    assert.ok(harness.controller._state.target);
    assert.equal(harness.controller._state.submitBusy, true);
    assert.equal(harness.calls.posts, 1);
});

test('queued close event never invalidates a reopened dialog', async () => {
    const harness = setup({ profiles: [PERSONAL] });
    harness.controller.open();
    await flush(20);
    assert.equal(harness.el('dispatch-start').disabled, false);
    harness.controller.close();
    harness.controller.open();
    await flush(20);
    assert.match(harness.el('dispatch-inputs').textContent, /greeting/);
    assert.equal(harness.el('dispatch-start').disabled, false);
});

test('close and reopen while POST aborts preserves uncertainty', async () => {
    const harness = setup({ profiles: [PERSONAL], slow: { post: 'hang' } });
    harness.controller.open();
    await flush(20);
    harness.doc.getElementById('dispatch-form').fire('submit', { preventDefault() {} });
    await flush();
    assert.equal(harness.calls.posts, 1);
    harness.controller.close();
    harness.controller.open();
    await flush(20);
    assert.equal(harness.controller._state.uncertain.size, 1);
    assert.match(harness.el('dispatch-status').textContent, /may have been accepted/);
    assert.equal(harness.el('dispatch-start').disabled, true);
});
