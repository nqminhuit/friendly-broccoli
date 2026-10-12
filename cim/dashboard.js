(() => {
    const store = new CimSettings.SettingsStore(chrome.storage);
    const client = new CimApi.GitHubClient();
    const $ = (id) => document.getElementById(id);
    const state = { settings: null, runs: new Map(), links: new Map(), errors: new Map(), loading: false, initialLoading: false };
    const monitor = new CimMonitor.ForegroundMonitor({
        cycle: refreshLatest,
        onCycle: (error, result) => {
            state.initialLoading = false;
            if (error) setFeedback(`${error.message} Previous successful results are kept.`, 'error');
            else {
                setFeedback('', '');
                for (const [key, item] of result.results) {
                    if (item.error) state.errors.set(key, item.error.message);
                    else state.errors.delete(key);
                }
                render();
            }
            updateMonitorLabel();
        },
        isVisible: () => document.visibilityState === 'visible'
    });

    function setFeedback(message, kind) {
        const target = $('feedback');
        target.textContent = message;
        target.className = `feedback ${kind || ''}`;
        target.hidden = !message;
    }
    function setSettingsMessage(message, kind = '') {
        const target = $('settings-message');
        target.textContent = message;
        target.className = `settings-message ${kind}`;
    }
    function currentRepos() { return state.settings?.repos || []; }
    function repoKey(repo) { return repo.toLocaleLowerCase('en-US'); }
    function runKey(repo, run) { return `${repoKey(repo)}#${run.id}`; }
    function statusOf(run) {
        if (run.status === 'completed') {
            const conclusion = (run.conclusion || 'unknown').replaceAll('_', ' ');
            return { label: `Completed · ${conclusion}`, kind: run.conclusion === 'success' ? 'completed' : 'failed' };
        }
        const labels = { in_progress: 'Running', queued: 'Queued', waiting: 'Waiting', pending: 'Pending', requested: 'Requested' };
        return { label: labels[run.status] || 'Status unavailable', kind: run.status === 'in_progress' ? 'active' : 'neutral' };
    }
    function dateLabel(value) {
        if (!value) return 'Time unavailable';
        const date = new Date(value);
        return Number.isNaN(date.valueOf()) ? 'Time unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    }
    function durationLabel(run) {
        if (!run.run_started_at || !run.updated_at) return '';
        const start = Date.parse(run.run_started_at), end = run.status === 'completed' ? Date.parse(run.updated_at) : Date.now();
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
        const minutes = Math.floor((end - start) / 60000);
        return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    }
    function appendText(parent, tag, text, className) {
        const node = document.createElement(tag);
        node.textContent = text ?? '';
        if (className) node.className = className;
        parent.append(node);
        return node;
    }
    function render() {
        const configured = currentRepos().length > 0 && !!state.settings?.token;
        $('setup-empty').hidden = configured;
        $('dashboard-content').hidden = !configured;
        if (!configured) { $('summary').replaceChildren(); return; }
        const allRuns = [...state.runs.values()].sort((a, b) => Date.parse(b.run.created_at || '') - Date.parse(a.run.created_at || '') || String(a.run.id).localeCompare(String(b.run.id)));
        const active = allRuns.filter(({ run }) => run.status !== 'completed').length;
        $('summary').replaceChildren();
        for (const [number, label] of [[allRuns.length, 'loaded runs'], [active, 'active']]) {
            const item = document.createElement('span');
            const strong = appendText(item, 'strong', String(number));
            strong.setAttribute('aria-label', `${number} ${label}`);
            item.append(document.createTextNode(label));
            $('summary').append(item);
        }
        const loaded = new Map();
        for (const repo of currentRepos()) loaded.set(repoKey(repo), [...state.runs.values()].filter((item) => repoKey(item.repo) === repoKey(repo)).length);
        $('history-note').textContent = `${currentRepos().map((repo) => `${repo}: ${loaded.get(repoKey(repo)) || 0} loaded`).join(' · ')}. Only the latest 30 runs per repository are initially loaded; use Load older runs to browse further.`;
        const errors = $('repo-errors');
        errors.replaceChildren();
        for (const [key, message] of state.errors) {
            const repo = currentRepos().find((item) => repoKey(item) === key) || key;
            const hasStale = [...state.runs.values()].some((item) => repoKey(item.repo) === key);
            appendText(errors, 'div', `${repo}: ${message}${hasStale ? ' Stale results are shown.' : ''}`, 'repo-error');
        }
        const query = $('search').value.trim().toLocaleLowerCase();
        const statusFilter = $('status-filter').value;
        const list = $('run-list');
        list.replaceChildren();
        if (!allRuns.length && state.initialLoading) appendText(list, 'div', 'Loading workflow runs…', 'history-note');
        let visibleCount = 0;
        for (const item of allRuns) {
            const { run, repo } = item;
            const status = statusOf(run);
            const haystack = [repo, run.name, run.display_title, run.head_branch, run.event, run.actor?.login].join(' ').toLocaleLowerCase();
            if (query && !haystack.includes(query)) continue;
            if (statusFilter !== 'all' && (statusFilter === 'Completed' ? run.status !== 'completed' : status.label !== statusFilter)) continue;
            const card = document.createElement('article');
            card.className = 'run-card';
            const main = document.createElement('div'); main.className = 'run-main';
            appendText(main, 'div', repo, 'run-repo');
            appendText(main, 'div', run.display_title || run.name || 'Workflow run', 'run-title');
            const meta = document.createElement('div'); meta.className = 'run-meta';
            const info = [`${run.head_branch || 'Branch unavailable'}`, `${run.event || 'Event unavailable'}`, `#${run.run_number ?? '—'} · attempt ${run.run_attempt ?? '—'}`, `by ${run.actor?.login || 'unknown actor'}`, dateLabel(run.created_at)];
            const duration = durationLabel(run); if (duration) info.push(duration);
            for (const part of info) appendText(meta, 'span', part);
            main.append(meta);
            const statusNode = document.createElement('div'); statusNode.className = `run-status status-${status.kind}`;
            const icon = document.createElement('span'); icon.className = 'status-icon'; icon.setAttribute('aria-hidden', 'true'); statusNode.append(icon);
            appendText(statusNode, 'span', status.label);
            const side = document.createElement('div'); side.className = 'run-side';
            appendText(side, 'span', dateLabel(run.updated_at));
            let githubUrl;
            try { githubUrl = new URL(run.html_url); } catch { githubUrl = null; }
            if (githubUrl?.origin === 'https://github.com' && githubUrl.protocol === 'https:') {
                const link = document.createElement('a'); link.href = githubUrl.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open on GitHub ↗'; side.append(link);
            }
            card.append(main, statusNode, side); list.append(card); visibleCount++;
        }
        $('no-runs').hidden = allRuns.length > 0 || state.initialLoading || state.errors.size > 0;
        $('filtered-empty').hidden = visibleCount > 0 || allRuns.length === 0;
        $('older').disabled = ![...state.links.values()].some(Boolean) || state.loading;
        $('older').textContent = state.loading ? 'Loading…' : 'Load older runs';
    }
    async function refreshLatest(signal) {
        const results = new Map();
        const entries = await Promise.all(currentRepos().map(async (repo) => {
            const key = repoKey(repo), parts = repo.split('/');
            try {
                const value = await client.listRuns(parts[0], parts[1], { signal });
                if (signal.aborted) return [key, { error: new CimApi.ApiError('Cancelled') }];
                for (const run of value.runs) state.runs.set(runKey(repo, run), { repo, run });
                state.links.set(key, value.links.next || null);
                return [key, { runs: value.runs }];
            } catch (error) { return [key, { error }]; }
        }));
        for (const [key, result] of entries) results.set(key, result);
        const errors = entries.map(([, result]) => result.error).filter(Boolean);
        const authError = errors.find((error) => error.kind === 'auth');
        const rateError = errors.find((error) => error.kind === 'rate-limit');
        if (authError) client.authInvalid = true;
        if (rateError) client.retryAt = Math.max(client.retryAt, rateError.retryAt);
        return { results, runs: [...state.runs.values()].map(({ run }) => run), retryAt: client.retryAt };
    }
    function updateMonitorLabel() {
        $('monitor-label').textContent = document.visibilityState === 'visible' && currentRepos().length && state.settings?.token ? 'Monitoring while open' : 'Monitoring paused';
    }
    async function applySettings(settings) {
        monitor.stop();
        state.settings = settings;
        state.runs.clear(); state.links.clear(); state.errors.clear();
        state.initialLoading = settings.repos.length > 0 && !!settings.token && document.visibilityState === 'visible';
        client.reset(settings.token);
        render(); updateMonitorLabel();
        if (settings.repos.length && settings.token) await monitor.start();
    }
    async function loadSettings() {
        await applySettings(await store.load());
    }
    function openSettings() {
        $('repositories').value = currentRepos().join('\n');
        $('remember').checked = state.settings?.rememberToken === true;
        $('token').value = '';
        setSettingsMessage('Leave the token blank to keep the saved token.', '');
        $('settings-dialog').showModal();
    }
    async function validateForm() {
        const parsed = CimSettings.parseRepositories($('repositories').value);
        if (parsed.errors.length) throw new Error(parsed.errors.join('\n'));
        if (!parsed.repos.length) throw new Error('Add at least one repository.');
        const token = $('token').value.trim() || state.settings?.token || '';
        if (!token) throw new Error('Enter a personal access token.');
        return { repos: parsed.repos, token };
    }
    async function onTestAccess() {
        const button = $('test-access'); button.disabled = true;
        try {
            const proposed = await validateForm();
            const temporary = new CimApi.GitHubClient(); temporary.reset(proposed.token);
            const messages = [];
            for (const repo of proposed.repos) {
                const [owner, name] = repo.split('/');
                try { await temporary.testRepo(owner, name); messages.push(`${repo}: access confirmed`); }
                catch (error) { messages.push(`${repo}: ${error.message}`); }
            }
            const failed = messages.some((message) => !message.endsWith('access confirmed'));
            setSettingsMessage(messages.join('\n'), failed ? 'error' : 'success');
        } catch (error) { setSettingsMessage(error.message, 'error'); }
        finally { button.disabled = false; }
    }
    async function onSave(event) {
        event.preventDefault();
        try {
            const proposed = await validateForm();
            const saved = await store.save({ repos: proposed.repos, rememberToken: $('remember').checked, tokenInput: $('token').value });
            $('token').value = '';
            await applySettings(saved);
            $('settings-dialog').close();
            setFeedback('Settings saved. GitHub Actions requests are read-only.', '');
        } catch (error) { setSettingsMessage(error.message, 'error'); }
    }
    async function loadOlder() {
        if (state.loading) return;
        state.loading = true; render();
        const entries = [...state.links.entries()].filter(([, url]) => url);
        const errors = [];
        for (const [key, url] of entries) {
            const repo = currentRepos().find((item) => repoKey(item) === key);
            if (!repo) continue;
            const [owner, name] = repo.split('/');
            try {
                const value = await client.listRuns(owner, name, { url });
                for (const run of value.runs) state.runs.set(runKey(repo, run), { repo, run });
                state.links.set(key, value.links.next || null);
            } catch (error) { errors.push(`${repo}: ${error.message}`); }
        }
        state.loading = false;
        if (errors.length) setFeedback(errors.join('\n'), 'error');
        render();
    }

    $('settings-open').addEventListener('click', openSettings);
    $('setup-open').addEventListener('click', openSettings);
    $('settings-close').addEventListener('click', () => $('settings-dialog').close());
    $('settings-form').addEventListener('submit', onSave);
    $('test-access').addEventListener('click', onTestAccess);
    $('forget-token').addEventListener('click', async () => {
        await store.forgetToken(); $('token').value = ''; $('remember').checked = false;
        await loadSettings(); setSettingsMessage('Token removed from session and device storage.', 'success');
    });
    $('refresh').addEventListener('click', () => { void monitor.refresh(); });
    $('older').addEventListener('click', () => { void loadOlder(); });
    $('search').addEventListener('input', render);
    $('status-filter').addEventListener('change', render);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') monitor.pause();
        else void monitor.resume();
        updateMonitorLabel();
    });
    window.addEventListener('pagehide', () => monitor.stop());
    chrome.storage.onChanged.addListener((changes, area) => {
        if ((area === 'local' && ['repositories', 'rememberToken', 'token'].some((key) => key in changes)) || (area === 'session' && 'token' in changes)) void loadSettings();
    });
    void loadSettings();
})();
