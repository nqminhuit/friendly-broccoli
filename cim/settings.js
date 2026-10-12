(function (root, factory) {
    const settings = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = settings;
    root.CimSettings = settings;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
    const RESERVED = /(^|\/)(?:\.|\.\.|.*[?#])/;
    const PROFILE_PREFIX = 'cimProfile:';
    const TOKEN_PREFIX = 'cimToken:';
    const LEGACY_KEYS = ['repositories', 'rememberToken', 'token'];

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

    function createSnapshotLoader(load, apply) {
        let version = 0;
        return async function loadLatest() {
            const current = ++version;
            const snapshot = await load();
            if (current !== version) return false;
            await apply(snapshot);
            return true;
        };
    }

    class SettingsStore {
        constructor(storage, { createId = () => globalThis.crypto.randomUUID() } = {}) {
            this.storage = storage;
            this.createId = createId;
            this.migration = null;
        }
        async migrateLegacy() {
            if (this.migration) return this.migration;
            this.migration = (async () => {
                const local = await this.storage.local.get(null);
                const session = await this.storage.session.get(null);
                const profiles = Object.keys(local || {}).filter((key) => key.startsWith(PROFILE_PREFIX));
                if (profiles.length) {
                    if (LEGACY_KEYS.some((key) => key in local)) await this.storage.local.remove(LEGACY_KEYS);
                    if ('token' in (session || {})) await this.storage.session.remove('token');
                    return;
                }
                if (!LEGACY_KEYS.some((key) => key in (local || {})) && !('token' in (session || {}))) return;
                const id = 'default';
                const record = { id, name: 'Personal', repos: Array.isArray(local.repositories) ? local.repositories : [], rememberToken: local.rememberToken === true };
                const token = session.token || (record.rememberToken ? local.token : '') || '';
                if (record.rememberToken && token) record.token = token;
                if (token) await this.storage.session.set({ [TOKEN_PREFIX + id]: token });
                await this.storage.local.set({ [PROFILE_PREFIX + id]: record });
                await this.storage.local.remove(LEGACY_KEYS);
                if ('token' in (session || {})) await this.storage.session.remove('token');
            })();
            try { await this.migration; } catch (error) { this.migration = null; throw error; }
        }
        async load() {
            await this.migrateLegacy();
            const local = await this.storage.local.get(null);
            const records = Object.keys(local || {}).filter((key) => key.startsWith(PROFILE_PREFIX)).map((key) => local[key]).filter((record) => record && typeof record.id === 'string');
            const tokens = await this.storage.session.get(records.map(({ id }) => TOKEN_PREFIX + id));
            return records.map((record) => ({ ...record, repos: Array.isArray(record.repos) ? record.repos : [], token: tokens[TOKEN_PREFIX + record.id] || (record.rememberToken ? record.token : '') || '' }));
        }
        async saveProfile({ id, name, repos, rememberToken, tokenInput }) {
            await this.migrateLegacy();
            const profileId = id || this.createId();
            if (!/^[A-Za-z0-9_-]{1,80}$/.test(profileId)) throw new Error('Invalid profile identifier.');
            const trimmedName = String(name || '').trim();
            if (!trimmedName) throw new Error('Enter a profile name.');
            const parsed = parseRepositories((repos || []).join('\n'));
            if (parsed.errors.length) throw new Error(parsed.errors.join('\n'));
            const localKey = PROFILE_PREFIX + profileId;
            const sessionKey = TOKEN_PREFIX + profileId;
            const [existing, session] = await Promise.all([this.storage.local.get(localKey), this.storage.session.get(sessionKey)]);
            const current = existing[localKey];
            const supplied = String(tokenInput || '').trim();
            const token = supplied || session[sessionKey] || (current?.rememberToken ? current.token : '') || '';
            if (!token) throw new Error('A new profile requires a personal access token.');
            if (!parsed.repos.length) throw new Error('Add at least one repository.');
            const record = { id: profileId, name: trimmedName, repos: parsed.repos, rememberToken: rememberToken === true };
            if (record.rememberToken) record.token = token;
            await this.storage.session.set({ [sessionKey]: token });
            await this.storage.local.set({ [localKey]: record });
            return { ...record, token };
        }
        async forgetToken(id) {
            const key = PROFILE_PREFIX + id;
            const existing = await this.storage.local.get(key);
            const record = existing[key];
            if (!record) return null;
            const updated = { ...record, rememberToken: false };
            delete updated.token;
            await this.storage.local.set({ [key]: updated });
            await Promise.all([this.storage.session.remove(TOKEN_PREFIX + id)]);
            return { ...updated, token: '' };
        }
        async deleteProfile(id) {
            await Promise.all([this.storage.local.remove(PROFILE_PREFIX + id), this.storage.session.remove(TOKEN_PREFIX + id)]);
        }
    }
    return { parseRepositories, createSnapshotLoader, SettingsStore, PROFILE_PREFIX, TOKEN_PREFIX, LEGACY_KEYS };
});
