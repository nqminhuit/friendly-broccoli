(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.CimApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const API_ORIGIN = 'https://api.github.com';
    const API_VERSION = '2026-03-10';
    const ACCEPT = 'application/vnd.github+json';

    class ApiError extends Error {
        constructor(message, { status = 0, kind = 'network', retryAt = 0, ambiguous = false } = {}) {
            super(message);
            this.name = 'ApiError';
            this.status = status;
            this.kind = kind;
            this.retryAt = retryAt;
            this.ambiguous = ambiguous;
        }
    }

    function paginationLinks(header, expectedPath) {
        const result = {};
        if (!header) return result;
        for (const part of header.split(/,(?=\s*<)/)) {
            const match = part.match(/\s*<([^>]+)>\s*;\s*rel="?([^";]+)"?/);
            if (!match) continue;
            let url;
            try { url = new URL(match[1], API_ORIGIN); } catch { continue; }
            if (url.origin !== API_ORIGIN || url.username || url.password || url.pathname !== expectedPath) continue;
            result[match[2]] = url.href;
        }
        return result;
    }

    function safeSegment(value) {
        const text = String(value ?? '');
        if (!text || text.length > 200 || text === '.' || text === '..' || /[?#]/.test(text) || /[\0-\x1f\x7f]/.test(text) || text.includes('://')) throw new ApiError('Rejected an unsafe GitHub request.', { kind: 'security' });
        return encodeURIComponent(text);
    }

    function validateRef(ref) {
        const text = String(ref ?? '');
        if (!text || text.length > 255 || text.includes('..') || /[?#\s]/.test(text) || text.includes('://') || /[\0-\x1f\x7f\\]/.test(text)) throw new ApiError('Enter a valid branch or tag ref (no query, URL, or traversal).', { kind: 'security' });
        return text;
    }

    const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[^/]+\.ya?ml$/;
    const MAX_WORKFLOW_FILE_BYTES = 1048576;

    function validateWorkflowPath(workflowPath) {
        const text = String(workflowPath ?? '');
        if (!WORKFLOW_PATH_PATTERN.test(text) || text.includes('..') || text.includes('?') || text.includes('#') || text.includes('://') || text.includes('\\')) throw new ApiError('Rejected an unsafe workflow file path.', { kind: 'security' });
        return text;
    }

    function encodeWorkflowPath(workflowPath) {
        return validateWorkflowPath(workflowPath).split('/').map((segment) => encodeURIComponent(segment)).join('/');
    }

    function validateWorkflowId(workflowId) {
        const text = String(workflowId ?? '');
        if (!text || text.length > 200 || text.includes('/') || text.includes('..') || /[?#\s]/.test(text) || text.includes('://')) throw new ApiError('Rejected an unsafe workflow identifier.', { kind: 'security' });
        if (/^\d+$/.test(text) && Number(text) <= 0) throw new ApiError('Rejected an unsafe workflow identifier.', { kind: 'security' });
        return text;
    }

    function decodeBase64Utf8(content) {
        const compact = String(content ?? '').replace(/\s/g, '');
        if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new ApiError('GitHub returned a malformed workflow file.', { kind: 'http' });
        let bytes;
        try {
            if (typeof globalThis.Buffer !== 'undefined') bytes = Uint8Array.from(globalThis.Buffer.from(compact, 'base64'));
            else {
                const binary = globalThis.atob(compact);
                bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
            }
        } catch { throw new ApiError('GitHub returned a malformed workflow file.', { kind: 'http' }); }
        // GitHub base64 can pad; reject empty or oversized payloads before UTF-8 decode.
        if (!bytes.length || bytes.length > MAX_WORKFLOW_FILE_BYTES) throw new ApiError('GitHub returned a malformed workflow file.', { kind: 'http' });
        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new ApiError('GitHub returned a malformed workflow file.', { kind: 'http' }); }
    }

    function safeGitHubHtmlUrl(value) {
        try {
            const url = new URL(String(value ?? ''));
            if (url.protocol === 'https:' && url.origin === 'https://github.com' && !url.username && !url.password) return url.href;
        } catch { /* Invalid URLs are rejected below. */ }
        return '';
    }

    class GitHubClient {
        constructor({ fetchImpl = globalThis.fetch, now = () => Date.now(), setTimer = (...args) => globalThis.setTimeout(...args), clearTimer = (id) => globalThis.clearTimeout(id), timeoutMs = 15000, maxConcurrent = 1 } = {}) {
            this.fetch = fetchImpl.bind(globalThis);
            this.now = now;
            this.setTimer = setTimer;
            this.clearTimer = clearTimer;
            this.timeoutMs = timeoutMs;
            this.maxConcurrent = maxConcurrent;
            this.token = '';
            this.cache = new Map();
            this.active = 0;
            this.waiters = [];
            this.retryAt = 0;
            this.authInvalid = false;
            this.generation = 0;
            this.controllers = new Set();
            this.secondaryCount = 0;
            this.lastMutationAt = 0;
        }
        reset(token) {
            this.generation++;
            for (const controller of this.controllers) controller.abort();
            this.controllers.clear();
            this.token = token || '';
            this.cache.clear();
            this.retryAt = 0;
            this.authInvalid = false;
            this.secondaryCount = 0;
            this.lastMutationAt = 0;
        }
        async waitForMutation(signal) {
            const delay = Math.max(0, this.lastMutationAt + 1000 - this.now());
            if (!delay) return;
            await new Promise((resolve, reject) => {
                const timer = this.setTimer(() => { signal?.removeEventListener('abort', abort); resolve(); }, delay);
                const abort = () => { this.clearTimer(timer); signal?.removeEventListener('abort', abort); reject(new ApiError('GitHub request was cancelled.', { kind: 'cancelled' })); };
                if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
            });
        }
        async acquire(signal) {
            if (signal?.aborted) throw new ApiError('GitHub request was cancelled.', { kind: 'cancelled' });
            if (this.active < this.maxConcurrent) { this.active++; return; }
            await new Promise((resolve, reject) => {
                const waiter = { resolve: () => { signal?.removeEventListener('abort', abort); this.active++; resolve(); } };
                const abort = () => { this.waiters = this.waiters.filter((item) => item !== waiter); signal?.removeEventListener('abort', abort); reject(new ApiError('GitHub request was cancelled.', { kind: 'cancelled' })); };
                if (signal?.aborted) return abort();
                signal?.addEventListener('abort', abort, { once: true });
                this.waiters.push(waiter);
            });
        }
        release() { this.active = Math.max(0, this.active - 1); this.waiters.shift()?.resolve(); }
        async request(url, { signal, expectedPath, method = 'GET', body } = {}) {
            if (!['GET', 'POST'].includes(method) || (method === 'GET' && body !== undefined)) throw new ApiError('Unsupported GitHub request method.', { kind: 'security' });
            if (signal?.aborted) throw new ApiError('GitHub request was cancelled.', { kind: 'cancelled' });
            if (!this.token) throw new ApiError('Configure a GitHub token first.', { kind: 'auth' });
            if (this.authInvalid) throw new ApiError('GitHub token is invalid or expired. Update it to resume.', { status: 401, kind: 'auth' });
            if (this.now() < this.retryAt) throw new ApiError('GitHub rate limit reached; refresh will resume later.', { status: 429, kind: 'rate-limit', retryAt: this.retryAt });
            const parsed = new URL(url, API_ORIGIN);
            if (parsed.origin !== API_ORIGIN || parsed.username || parsed.password || (expectedPath && parsed.pathname !== expectedPath)) throw new ApiError('Rejected an unsafe GitHub pagination URL.', { kind: 'security' });
            const requestedGeneration = this.generation;
            await this.acquire(signal);
            let released = false;
            const release = () => { if (!released) { released = true; this.release(); } };
            if (requestedGeneration !== this.generation || !this.token || this.authInvalid || this.now() < this.retryAt) {
                release();
                if (signal?.aborted || requestedGeneration !== this.generation) throw new ApiError('GitHub request was cancelled.', { kind: 'cancelled' });
                if (!this.token) throw new ApiError('Configure a GitHub token first.', { kind: 'auth' });
                if (this.authInvalid) throw new ApiError('GitHub token is invalid or expired. Update it to resume.', { status: 401, kind: 'auth' });
                throw new ApiError('GitHub rate limit reached; refresh will resume later.', { status: 429, kind: 'rate-limit', retryAt: this.retryAt });
            }
            const generation = requestedGeneration;
            if (method === 'POST') {
                try { await this.waitForMutation(signal); }
                catch (error) { release(); throw error; }
            }
            if (signal?.aborted || generation !== this.generation || !this.token || this.authInvalid || this.now() < this.retryAt) {
                release();
                throw new ApiError('GitHub request was cancelled.', { kind: 'cancelled' });
            }
            const controller = new AbortController();
            this.controllers.add(controller);
            const abort = () => controller.abort(signal.reason || new DOMException('Aborted', 'AbortError'));
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            const timer = this.setTimer(() => controller.abort(new Error('Request timed out')), this.timeoutMs);
            const prior = method === 'GET' ? this.cache.get(parsed.href) : null;
            let sent = false;
            try {
                if (controller.signal.aborted || generation !== this.generation) throw new ApiError('GitHub request was cancelled.', { kind: 'cancelled' });
                const headers = { Authorization: `Bearer ${this.token}`, Accept: ACCEPT, 'X-GitHub-Api-Version': API_VERSION };
                if (method === 'GET' && prior?.etag) headers['If-None-Match'] = prior.etag;
                if (method === 'POST') headers['Content-Type'] = 'application/json';
                const requestBody = body === undefined ? undefined : JSON.stringify(body);
                sent = true;
                if (method === 'POST') this.lastMutationAt = this.now();
                const response = await this.fetch(parsed.href, { method, headers, ...(requestBody === undefined ? {} : { body: requestBody }), signal: controller.signal, redirect: 'error' });
                if (generation !== this.generation || controller.signal.aborted) throw new ApiError('GitHub request was cancelled.', { kind: 'cancelled', ambiguous: method === 'POST' && sent });
                if (method === 'GET' && response.status === 304 && prior) return { ...prior, status: 304 };
                if (response.status === 401) {
                    if (generation === this.generation) this.authInvalid = true;
                    throw new ApiError('GitHub token is invalid or expired. Update it to resume.', { status: 401, kind: 'auth' });
                }
                if (response.status === 403 || response.status === 429) {
                    const resetValue = Number(response.headers.get('X-RateLimit-Reset'));
                    const reset = Number.isFinite(resetValue) && resetValue > 0 ? resetValue * 1000 : 0;
                    const retryHeader = response.headers.get('Retry-After');
                    const retryValue = retryHeader ? (/^\d+(\.\d+)?$/.test(retryHeader) ? this.now() + Number(retryHeader) * 1000 : Date.parse(retryHeader)) : 0;
                    const retryAfter = Number.isFinite(retryValue) ? retryValue : 0;
                    let responseMessage = '';
                    try { responseMessage = (await response.clone().json()).message || ''; } catch { /* Error bodies are optional. */ }
                    if (generation !== this.generation || controller.signal.aborted) throw new ApiError('GitHub request was cancelled.', { kind: 'cancelled', ambiguous: method === 'POST' && sent });
                    const remaining = response.headers.get('X-RateLimit-Remaining');
                    const primary = remaining === '0';
                    const secondaryLimit = response.status === 429 || /secondary rate limit/i.test(responseMessage);
                    const secondary = secondaryLimit && !retryHeader ? this.now() + Math.min(15 * 60_000, 60_000 * 2 ** Math.min(this.secondaryCount++, 4)) : 0;
                    const isRate = response.status === 429 || primary || !!retryHeader || secondary > 0;
                    if (isRate) {
                        const delay = retryAfter > this.now() ? retryAfter : 0;
                        const resetDelay = primary && reset > this.now() ? reset : 0;
                        this.retryAt = Math.max(delay, resetDelay, secondary, (!delay && !resetDelay && !secondary ? this.now() + 60000 : 0));
                        throw new ApiError('GitHub rate limit reached; refresh will resume later.', { status: response.status, kind: 'rate-limit', retryAt: this.retryAt });
                    }
                    throw new ApiError(method === 'POST' ? 'GitHub denied this action; this profile needs Actions: write permission.' : 'GitHub denied access to this resource.', { status: 403, kind: 'permission' });
                }
                if (response.status === 404) throw new ApiError('Repository is absent or inaccessible to this token.', { status: 404, kind: 'not-found' });
                if (!response.ok) {
                    // A 5xx after a sent POST may have executed; callers must not safely repeat it.
                    const uncertain = method === 'POST' && sent && response.status >= 500;
                    throw new ApiError(`GitHub returned an unexpected error (${response.status}).`, { status: response.status, kind: 'http', ambiguous: uncertain });
                }
                let data = null;
                const hasJsonBody = response.headers.get('Content-Length') !== '0' && response.headers.get('Content-Type')?.includes('json');
                if ((response.status !== 204 && response.status !== 201) || hasJsonBody) {
                    try { data = await response.json(); }
                    catch (error) { if (response.status !== 201 && response.status !== 204) throw error; }
                }
                if (generation !== this.generation || controller.signal.aborted) throw new ApiError('GitHub request was cancelled.', { kind: 'cancelled', ambiguous: method === 'POST' && sent });
                const value = { data, links: paginationLinks(response.headers.get('Link'), expectedPath || parsed.pathname), etag: response.headers.get('ETag'), status: response.status };
                if (method === 'GET' && generation === this.generation) this.cache.set(parsed.href, value);
                if (method === 'POST' && generation === this.generation) this.clearRunCaches(parsed.pathname);
                return value;
            } catch (error) {
                if (error instanceof ApiError) throw error;
                if (controller.signal.aborted) throw new ApiError(controller.signal.reason?.message === 'Request timed out' ? 'GitHub request timed out.' : 'GitHub request was cancelled.', { kind: controller.signal.reason?.message === 'Request timed out' ? 'network' : 'cancelled', ambiguous: method === 'POST' && sent });
                throw new ApiError('Could not reach GitHub. Check your connection and try again.', { kind: 'network', ambiguous: method === 'POST' && sent });
            } finally {
                this.clearTimer(timer);
                this.controllers.delete(controller);
                signal?.removeEventListener('abort', abort);
                release();
            }
        }
        async listRuns(owner, repo, { url, signal } = {}) {
            const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs`;
            const target = url || `${API_ORIGIN}${path}?per_page=30`;
            const result = await this.request(target, { signal, expectedPath: path });
            return { runs: Array.isArray(result.data.workflow_runs) ? result.data.workflow_runs : [], total: Number(result.data.total_count) || 0, links: result.links };
        }
        clearRunCaches(pathname) {
            // Dispatch POSTs live under /actions/workflows/...; run feeds under /actions/runs.
            const repoPrefix = String(pathname || '').split('/actions/')[0];
            if (!repoPrefix || !repoPrefix.startsWith('/repos/')) return;
            const runPrefix = `${repoPrefix}/actions/runs`;
            for (const url of this.cache.keys()) {
                let current;
                try { current = new URL(url).pathname; } catch { continue; }
                if (current.startsWith(runPrefix)) this.cache.delete(url);
            }
        }
        async getRun(owner, repo, id, { signal } = {}) {
            const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(id)}`;
            const value = await this.request(`${API_ORIGIN}${path}`, { signal, expectedPath: path });
            return value.data;
        }
        async listAttemptJobs(owner, repo, id, attempt, { url, signal } = {}) {
            const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(id)}/attempts/${encodeURIComponent(attempt)}/jobs`;
            const target = url || `${API_ORIGIN}${path}?per_page=100`;
            const result = await this.request(target, { signal, expectedPath: path });
            return { jobs: Array.isArray(result.data?.jobs) ? result.data.jobs : [], total: Number(result.data?.total_count) || 0, links: result.links };
        }
        async listLatestJobs(owner, repo, id, { url, signal } = {}) {
            const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(id)}/jobs`;
            const target = url || `${API_ORIGIN}${path}?filter=latest&per_page=100`;
            const result = await this.request(target, { signal, expectedPath: path });
            return { jobs: Array.isArray(result.data?.jobs) ? result.data.jobs : [], total: Number(result.data?.total_count) || 0, links: result.links };
        }
        async rerun(owner, repo, id, failedOnly, { signal } = {}) {
            const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(id)}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`;
            return this.request(`${API_ORIGIN}${path}`, { signal, expectedPath: path, method: 'POST' });
        }
        async getRepo(owner, repo, { signal } = {}) {
            const path = `/repos/${safeSegment(owner)}/${safeSegment(repo)}`;
            const value = await this.request(`${API_ORIGIN}${path}`, { signal, expectedPath: path });
            return value.data;
        }
        async listWorkflows(owner, repo, { url, signal } = {}) {
            const path = `/repos/${safeSegment(owner)}/${safeSegment(repo)}/actions/workflows`;
            const target = url || `${API_ORIGIN}${path}?per_page=100`;
            const result = await this.request(target, { signal, expectedPath: path });
            return { workflows: Array.isArray(result.data?.workflows) ? result.data.workflows : [], total: Number(result.data?.total_count) || 0, links: result.links };
        }
        async getWorkflowFile(owner, repo, workflowPath, ref, { signal } = {}) {
            const encodedPath = encodeWorkflowPath(workflowPath);
            const validRef = validateRef(ref);
            const path = `/repos/${safeSegment(owner)}/${safeSegment(repo)}/contents/${encodedPath}`;
            const target = `${API_ORIGIN}${path}?ref=${encodeURIComponent(validRef)}`;
            const result = await this.request(target, { signal, expectedPath: path });
            const data = result.data;
            if (!data || typeof data !== 'object' || data.type !== 'file' || typeof data.content !== 'string' || data.encoding !== 'base64') throw new ApiError('GitHub returned a malformed workflow file.', { kind: 'http' });
            if (typeof data.size === 'number' && data.size > MAX_WORKFLOW_FILE_BYTES) throw new ApiError('GitHub returned a malformed workflow file.', { kind: 'http' });
            // Never follow download_url; only the fixed Contents route above carries the PAT.
            const text = decodeBase64Utf8(data.content);
            if (text.length > MAX_WORKFLOW_FILE_BYTES) throw new ApiError('GitHub returned a malformed workflow file.', { kind: 'http' });
            return { path: typeof data.path === 'string' ? data.path : String(workflowPath), ref: validRef, text, size: typeof data.size === 'number' ? data.size : text.length };
        }
        async dispatchWorkflow(owner, repo, workflowId, { ref, inputs, signal } = {}) {
            const validId = validateWorkflowId(workflowId);
            const validRef = validateRef(ref);
            const bodyInputs = Object.create(null);
            if (inputs !== undefined && inputs !== null) {
                if (typeof inputs !== 'object' || Array.isArray(inputs)) throw new ApiError('Workflow inputs must be an object.', { kind: 'security' });
                const names = Object.keys(inputs);
                if (names.length > 25) throw new ApiError('GitHub accepts at most 25 workflow inputs.', { kind: 'security' });
                for (const name of names) {
                    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new ApiError(`Unknown workflow input: ${name}.`, { kind: 'security' });
                    const value = inputs[name];
                    if (typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number') throw new ApiError(`Unsupported value for input ${name}.`, { kind: 'security' });
                    if (typeof value === 'number' && !Number.isFinite(value)) throw new ApiError(`Unsupported value for input ${name}.`, { kind: 'security' });
                    bodyInputs[name] = value;
                }
            }
            const body = { ref: validRef, inputs: bodyInputs };
            if (JSON.stringify(body).length > 65535) throw new ApiError('Workflow inputs exceed the 65535 character payload limit.', { kind: 'security' });
            const path = `/repos/${safeSegment(owner)}/${safeSegment(repo)}/actions/workflows/${encodeURIComponent(validId)}/dispatches`;
            const result = await this.request(`${API_ORIGIN}${path}`, { signal, expectedPath: path, method: 'POST', body });
            const data = result.data;
            // Official dispatch returns 200 JSON {workflow_run_id, run_url, html_url}; missing ID is uncertain.
            const runId = Number(data?.workflow_run_id);
            const htmlUrl = safeGitHubHtmlUrl(data?.html_url);
            if (!Number.isInteger(runId) || runId <= 0 || !htmlUrl) throw new ApiError('GitHub accepted the dispatch but did not return a usable run. Check GitHub before retrying.', { status: result.status, kind: 'http', ambiguous: true });
            return { runId, htmlUrl, runUrl: typeof data?.run_url === 'string' ? data.run_url : '', status: result.status };
        }
        async testRepo(owner, repo, signal) { await this.listRuns(owner, repo, { signal }); return true; }
    }

    return { API_ORIGIN, API_VERSION, ApiError, GitHubClient, paginationLinks, MAX_WORKFLOW_FILE_BYTES };
});
