(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.CimApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const API_ORIGIN = 'https://api.github.com';
    const API_VERSION = '2026-03-10';
    const ACCEPT = 'application/vnd.github+json';

    class ApiError extends Error {
        constructor(message, { status = 0, kind = 'network', retryAt = 0 } = {}) {
            super(message);
            this.name = 'ApiError';
            this.status = status;
            this.kind = kind;
            this.retryAt = retryAt;
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
            if (url.origin !== API_ORIGIN || url.pathname !== expectedPath) continue;
            result[match[2]] = url.href;
        }
        return result;
    }

    class GitHubClient {
        constructor({ fetchImpl = globalThis.fetch, now = () => Date.now(), setTimer = (...args) => globalThis.setTimeout(...args), clearTimer = (id) => globalThis.clearTimeout(id), timeoutMs = 15000, maxConcurrent = 3 } = {}) {
            this.fetch = fetchImpl;
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
        }
        reset(token) {
            this.generation++;
            for (const controller of this.controllers) controller.abort();
            this.controllers.clear();
            this.token = token || '';
            this.cache.clear();
            this.retryAt = 0;
            this.authInvalid = false;
        }
        async acquire(signal) {
            if (this.active < this.maxConcurrent) { this.active++; return; }
            await new Promise((resolve, reject) => {
                const waiter = { resolve: () => { signal?.removeEventListener('abort', abort); this.active++; resolve(); }, reject };
                const abort = () => { this.waiters = this.waiters.filter((item) => item !== waiter); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
                if (signal?.aborted) return abort();
                signal?.addEventListener('abort', abort, { once: true });
                this.waiters.push(waiter);
            });
        }
        release() { this.active--; this.waiters.shift()?.resolve(); }
        async request(url, { signal, expectedPath } = {}) {
            if (!this.token) throw new ApiError('Configure a GitHub token first.', { kind: 'auth' });
            if (this.authInvalid) throw new ApiError('GitHub token is invalid or expired. Update it to resume.', { status: 401, kind: 'auth' });
            if (this.now() < this.retryAt) throw new ApiError('GitHub rate limit reached; refresh will resume later.', { status: 429, kind: 'rate-limit', retryAt: this.retryAt });
            const parsed = new URL(url, API_ORIGIN);
            if (parsed.origin !== API_ORIGIN || (expectedPath && parsed.pathname !== expectedPath)) throw new ApiError('Rejected an unsafe GitHub pagination URL.', { kind: 'security' });
            const requestedGeneration = this.generation;
            await this.acquire(signal);
            if (requestedGeneration !== this.generation || !this.token || this.authInvalid || this.now() < this.retryAt) {
                this.release();
                if (requestedGeneration !== this.generation) throw new ApiError('GitHub request was cancelled.', { kind: 'network' });
                if (!this.token) throw new ApiError('Configure a GitHub token first.', { kind: 'auth' });
                if (this.authInvalid) throw new ApiError('GitHub token is invalid or expired. Update it to resume.', { status: 401, kind: 'auth' });
                throw new ApiError('GitHub rate limit reached; refresh will resume later.', { status: 429, kind: 'rate-limit', retryAt: this.retryAt });
            }
            const generation = requestedGeneration;
            const controller = new AbortController();
            this.controllers.add(controller);
            const abort = () => controller.abort(signal.reason);
            signal?.addEventListener('abort', abort, { once: true });
            const timer = this.setTimer(() => controller.abort(new Error('Request timed out')), this.timeoutMs);
            const prior = this.cache.get(parsed.href);
            try {
                const headers = { Authorization: `Bearer ${this.token}`, Accept: ACCEPT, 'X-GitHub-Api-Version': API_VERSION };
                if (prior?.etag) headers['If-None-Match'] = prior.etag;
                const response = await this.fetch(parsed.href, { method: 'GET', headers, signal: controller.signal, redirect: 'error' });
                if (generation !== this.generation) throw new ApiError('GitHub request was cancelled.', { kind: 'network' });
                if (response.status === 304 && prior) return { ...prior, status: 304 };
                if (response.status === 401) {
                    this.authInvalid = true;
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
                    if (generation !== this.generation) throw new ApiError('GitHub request was cancelled.', { kind: 'network' });
                    const secondary = response.status === 403 && /secondary rate limit/i.test(responseMessage) ? this.now() + 60000 : 0;
                    const isRate = response.status === 429 || response.headers.get('X-RateLimit-Remaining') === '0' || !!retryHeader || secondary > 0;
                    if (isRate) {
                        this.retryAt = Math.max(retryAfter || 0, reset || 0, secondary, (!retryAfter && !reset ? this.now() + 60000 : 0));
                        throw new ApiError('GitHub rate limit reached; refresh will resume later.', { status: response.status, kind: 'rate-limit', retryAt: this.retryAt });
                    }
                    throw new ApiError('GitHub denied access to this resource.', { status: 403, kind: 'permission' });
                }
                if (response.status === 404) throw new ApiError('Repository is absent or inaccessible to this token.', { status: 404, kind: 'not-found' });
                if (!response.ok) throw new ApiError(`GitHub returned an unexpected error (${response.status}).`, { status: response.status, kind: 'http' });
                const data = await response.json();
                const value = { data, links: paginationLinks(response.headers.get('Link'), expectedPath || parsed.pathname), etag: response.headers.get('ETag'), status: response.status };
                if (generation === this.generation) this.cache.set(parsed.href, value);
                return value;
            } catch (error) {
                if (error instanceof ApiError) throw error;
                if (controller.signal.aborted) throw new ApiError(controller.signal.reason?.message === 'Request timed out' ? 'GitHub request timed out.' : 'GitHub request was cancelled.', { kind: 'network' });
                throw new ApiError('Could not reach GitHub. Check your connection and try again.', { kind: 'network' });
            } finally {
                this.clearTimer(timer);
                this.controllers.delete(controller);
                signal?.removeEventListener('abort', abort);
                this.release();
            }
        }
        async listRuns(owner, repo, { url, signal } = {}) {
            const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs`;
            const target = url || `${API_ORIGIN}${path}?per_page=30`;
            const result = await this.request(target, { signal, expectedPath: path });
            return { runs: Array.isArray(result.data.workflow_runs) ? result.data.workflow_runs : [], total: Number(result.data.total_count) || 0, links: result.links };
        }
        async testRepo(owner, repo, signal) { await this.listRuns(owner, repo, { signal }); return true; }
    }

    return { API_ORIGIN, API_VERSION, ApiError, GitHubClient, paginationLinks };
});
