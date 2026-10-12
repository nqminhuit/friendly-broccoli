(function (root, factory) {
    const settings = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = settings;
    root.CimSettings = settings;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
    const RESERVED = /(^|\/)(?:\.|\.\.|.*[?#])/;

    function parseRepositories(value) {
        const repos = [];
        const seen = new Set();
        const errors = [];
        for (const [index, line] of String(value || '').split(/\r?\n/).entries()) {
            const repo = line.trim();
            if (!repo) continue;
            if (!REPO_PATTERN.test(repo) || RESERVED.test(repo) || repo.includes('..')) {
                errors.push(`Line ${index + 1}: enter owner/repository only (no URL, query, or path).`);
                continue;
            }
            const key = repo.toLocaleLowerCase('en-US');
            if (!seen.has(key)) { seen.add(key); repos.push(repo); }
        }
        return { repos, errors };
    }

    class SettingsStore {
        constructor(storage) { this.storage = storage; }
        async load() {
            const [local, session] = await Promise.all([this.storage.local.get(['repositories', 'rememberToken', 'token']), this.storage.session.get('token')]);
            const token = session.token || (local.rememberToken ? local.token : '') || '';
            if (!session.token && token) await this.storage.session.set({ token });
            return { repos: Array.isArray(local.repositories) ? local.repositories : [], rememberToken: local.rememberToken === true, token };
        }
        async save({ repos, rememberToken, tokenInput }) {
            const [local, session] = await Promise.all([this.storage.local.get(['token']), this.storage.session.get('token')]);
            const token = tokenInput ? tokenInput.trim() : session.token || (local.rememberToken ? local.token : '') || '';
            await this.storage.local.set({ repositories: repos, rememberToken: !!rememberToken });
            if (token) await this.storage.session.set({ token });
            if (rememberToken && token) await this.storage.local.set({ token });
            else await this.storage.local.remove('token');
            return { repos, rememberToken: !!rememberToken, token };
        }
        async forgetToken() {
            await Promise.all([this.storage.local.remove('token'), this.storage.local.set({ rememberToken: false }), this.storage.session.remove('token')]);
            return this.load();
        }
    }
    return { parseRepositories, SettingsStore };
});
