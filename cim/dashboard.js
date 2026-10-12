(() => {
    const store = new CimSettings.SettingsStore(chrome.storage);
    const $ = (id) => document.getElementById(id);
    const ALL = 'all';
    const KEY_SEPARATOR = '\u0000';
    const COMPLETED = 'completed';
    const CANCELLED = 'cancelled';
    const state = { profiles: [], selected: '', editingId: null, profileFilter: ALL, runs: new Map(), latestLinks: new Map(), historyLinks: new Map(), historyStarted: new Set(), errors: new Map(), clients: new Map(), operations: new Set(), details: new Map(), detailOperations: new Map(), loading: false, initialLoading: false, epoch: 0, settingsBusy: false, writeBusy: false };
    const profileKey = (id, repo) => `${id}${KEY_SEPARATOR}${repo.toLocaleLowerCase('en-US')}`;
    const runKey = (id, repo, run) => `${profileKey(id, repo)}${KEY_SEPARATOR}${run.id}`;
    const repoKey = (repo) => repo.toLocaleLowerCase('en-US');
    const activeStates = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
    const monitor = new CimMonitor.ForegroundMonitor({ cycle: refreshLatest, onCycle: (error, result) => {
        state.initialLoading = false;
        if (error) setFeedback(`${error.message} Previous successful results are kept.`, 'error');
        else {
            setFeedback('', '');
            for (const [key, item] of result.results) {
                if (item.error && item.error.kind !== CANCELLED) state.errors.set(key, item.error.message);
                else if (!item.error) state.errors.delete(key);
            }
            render();
        }
        updateMonitorLabel();
    }, isVisible: () => document.visibilityState === 'visible' });

    function setFeedback(message, kind = '') { const target = $('feedback'); target.textContent = message; target.className = `feedback ${kind}`; target.hidden = !message; }
    function setSettingsMessage(message, kind = '') { const target = $('settings-message'); target.textContent = message; target.className = `settings-message ${kind}`; }
    function reportStorageError(message) { setFeedback(message, 'error'); $('monitor-label').textContent = 'Settings storage error'; }
    function currentProfiles() { return state.profiles.filter((profile) => profile.token && profile.repos.length); }
    function statusOf(run) {
        if (run.status === COMPLETED) {
            const conclusion = run.conclusion || 'unknown';
            const labels = { success: 'Success', failure: 'Failure', cancelled: 'Cancelled', timed_out: 'Timed out', skipped: 'Skipped', neutral: 'Neutral', action_required: 'Action required' };
            return { label: labels[conclusion] || `Completed · ${conclusion.replaceAll('_', ' ')}`, kind: conclusion === 'success' ? 'success' : conclusion === 'failure' || conclusion === 'timed_out' ? 'failure' : 'neutral', conclusion };
        }
        const labels = { in_progress: 'Running', queued: 'Queued', waiting: 'Waiting', pending: 'Pending', requested: 'Requested' };
        return { label: labels[run.status] || 'Status unavailable', kind: activeStates.has(run.status) ? 'active' : 'neutral', conclusion: '' };
    }
    function dateLabel(value) { if (!value) return 'Time unavailable'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? 'Time unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date); }
    function durationLabel(run) {
        if (!run.run_started_at || !run.updated_at) return '';
        const start = Date.parse(run.run_started_at), end = run.status === COMPLETED ? Date.parse(run.updated_at) : Date.now();
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
        const minutes = Math.floor((end - start) / 60000);
        return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    }
    function text(parent, tag, value, className = '') { const node = document.createElement(tag); node.textContent = value ?? ''; if (className) node.className = className; parent.append(node); return node; }
    function render() {
        const list = $('run-list');
        const focusKey = document.activeElement?.dataset?.focusKey;
        const profiles = currentProfiles();
        $('setup-empty').hidden = profiles.length > 0;
        $('dashboard-content').hidden = profiles.length === 0;
        $('profile-filter').replaceChildren(new Option('All profiles', ALL), ...state.profiles.map((profile) => new Option(profile.name, profile.id)));
        if (![...$('profile-filter').options].some((option) => option.value === state.profileFilter)) state.profileFilter = ALL;
        $('profile-filter').value = state.profileFilter;
        $('profile-filter').disabled = state.profiles.length === 0;
        const chosen = $('profile-filter').value;
        const entries = [...state.runs.entries()].filter(([, item]) => chosen === ALL || item.profileId === chosen).sort((a, b) => Date.parse(b[1].run.created_at || '') - Date.parse(a[1].run.created_at || '') || String(a[1].run.id).localeCompare(String(b[1].run.id)));
        const active = entries.filter(([, item]) => activeStates.has(item.run.status)).length;
        $('summary').replaceChildren();
        for (const [number, label] of [[entries.length, 'loaded runs'], [active, 'active']]) { const item = document.createElement('span'); const strong = text(item, 'strong', String(number)); strong.setAttribute('aria-label', `${number} ${label}`); item.append(document.createTextNode(label)); $('summary').append(item); }
        const repoLoads = new Map();
        for (const profile of profiles) for (const repo of profile.repos) { const key = profileKey(profile.id, repo); repoLoads.set(key, [...state.runs.values()].filter((item) => profileKey(item.profileId, item.repo) === key).length); }
        $('history-note').textContent = profiles.flatMap((profile) => profile.repos.map((repo) => `${profile.name} · ${repo}: ${repoLoads.get(profileKey(profile.id, repo)) || 0} loaded`)).join(' · ') + '. Latest 30 per repository load first; use Load older runs to browse further.';
        const errors = $('repo-errors'); errors.replaceChildren();
        for (const [key, message] of state.errors) { const [id, repo] = key.split(KEY_SEPARATOR); const profile = state.profiles.find((item) => item.id === id); if (profile) text(errors, 'div', `${profile.name} · ${repo}: ${message}`, 'repo-error'); }
        updateFilterOptions();
        const search = $('search').value.trim().toLocaleLowerCase(); const profileFilter = $('profile-filter').value; const repoFilter = $('repo-filter').value; const workflowFilter = $('workflow-filter').value; const branchFilter = $('branch-filter').value; const statusFilter = $('status-filter').value;
        list.replaceChildren();
        if (!entries.length && state.initialLoading) text(list, 'div', 'Loading workflow runs…', 'history-note');
        let visibleCount = 0;
        for (const [, item] of entries) {
            const { run, repo, profileId, profileName } = item; const status = statusOf(run);
            const haystack = [repo, profileName, run.name, run.display_title, run.head_branch, run.event, run.actor?.login].join(' ').toLocaleLowerCase();
            if (search && !haystack.includes(search)) continue;
            if (repoFilter !== ALL && repo !== repoFilter) continue;
            if (workflowFilter !== ALL && (run.name || run.display_title || 'Workflow run') !== workflowFilter) continue;
            if (branchFilter !== ALL && (run.head_branch || 'Unknown') !== branchFilter) continue;
            if (statusFilter !== ALL && (statusFilter === 'active' ? !activeStates.has(run.status) : statusFilter === COMPLETED ? run.status !== COMPLETED : status.conclusion !== statusFilter)) continue;
            const card = document.createElement('article'); card.className = 'run-card';
            const main = document.createElement('div'); main.className = 'run-main';
            const identity = document.createElement('div'); identity.className = 'run-identity'; text(identity, 'span', profileName, 'profile-badge'); text(identity, 'span', repo, 'run-repo'); main.append(identity);
            text(main, 'div', run.display_title || run.name || 'Workflow run', 'run-title');
            const meta = document.createElement('div'); meta.className = 'run-meta';
            const info = [run.head_branch || 'Branch unavailable', run.event || 'Event unavailable', `#${run.run_number ?? '—'} · attempt ${run.run_attempt ?? '—'}`, `by ${run.actor?.login || 'unknown actor'}`, dateLabel(run.created_at)]; const duration = durationLabel(run); if (duration) info.push(duration);
            for (const part of info) text(meta, 'span', part); main.append(meta);
            const statusNode = document.createElement('div'); statusNode.className = `run-status status-${status.kind}`; const icon = document.createElement('span'); icon.className = 'status-icon'; icon.setAttribute('aria-hidden', 'true'); statusNode.append(icon); text(statusNode, 'span', status.label);
            const side = document.createElement('div'); side.className = 'run-side'; text(side, 'span', dateLabel(run.updated_at));
            let githubUrl; try { githubUrl = new URL(run.html_url); } catch { githubUrl = null; }
            if (githubUrl?.origin === 'https://github.com' && githubUrl.protocol === 'https:' && !githubUrl.username && !githubUrl.password) { const link = document.createElement('a'); link.href = githubUrl.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open on GitHub ↗'; link.dataset.focusKey = `${runKey(profileId, repo, run)}:github`; side.append(link); }
            const key = runKey(profileId, repo, run); const detail = state.details.get(key);
            const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'button quiet details-toggle'; toggle.dataset.focusKey = `${key}:toggle`; toggle.setAttribute('aria-expanded', String(detail?.expanded === true)); toggle.textContent = detail?.expanded ? 'Hide jobs' : 'Show jobs and steps'; toggle.addEventListener('click', () => toggleDetails(key));
            const panel = document.createElement('section'); panel.className = 'run-details'; panel.hidden = detail?.expanded !== true;
            if (detail?.expanded) renderDetails(panel, item, detail);
            card.append(main, statusNode, side, toggle, panel); list.append(card); visibleCount++;
        }
        if (focusKey) {
            const focused = [...list.querySelectorAll('[data-focus-key]')].find((node) => node.dataset.focusKey === focusKey);
            if (focused && !focused.disabled) focused.focus({ preventScroll: true });
            else focused?.closest('.run-card')?.querySelector('.details-toggle')?.focus({ preventScroll: true });
        }
        reconcileDetails(entries.filter(([, item]) => {
            const haystack = [item.repo, item.profileName, item.run.name, item.run.display_title, item.run.head_branch, item.run.event, item.run.actor?.login].join(' ').toLocaleLowerCase();
            return (!search || haystack.includes(search)) && (repoFilter === ALL || item.repo === repoFilter) && (workflowFilter === ALL || (item.run.name || item.run.display_title || 'Workflow run') === workflowFilter) && (branchFilter === ALL || (item.run.head_branch || 'Unknown') === branchFilter) && (statusFilter === ALL || (statusFilter === 'active' ? activeStates.has(item.run.status) : statusFilter === COMPLETED ? item.run.status === COMPLETED : statusOf(item.run).conclusion === statusFilter));
        }).map(([key]) => key));
        $('no-runs').hidden = entries.length > 0 || state.initialLoading || state.errors.size > 0;
        $('filtered-empty').hidden = visibleCount > 0 || entries.length === 0;
        const selectedEntries = [...state.historyLinks.entries()].filter(([key, url]) => url && (profileFilter === ALL || key.startsWith(`${profileFilter}${KEY_SEPARATOR}`)));
        $('older').disabled = !selectedEntries.length || state.loading;
        $('older').textContent = state.loading ? 'Loading…' : 'Load older runs';
    }
    function safeGitHubLink(value) {
        try { const url = new URL(value); return url.protocol === 'https:' && url.origin === 'https://github.com' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
    }
    function jobState(job) { return job.conclusion || job.status || 'unknown'; }
    function durationFor(started, completed) {
        const start = Date.parse(started || ''), end = Date.parse(completed || '');
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
        const seconds = Math.floor((end - start) / 1000);
        return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    }
    function renderDetails(panel, item, detail) {
        const head = document.createElement('div'); head.className = 'detail-heading';
        const jobs = detail.jobs || [];
        text(head, 'strong', detail.loading ? 'Loading jobs…' : `${jobs.length} of ${detail.total || jobs.length} jobs loaded`);
        const refreshButton = document.createElement('button'); refreshButton.type = 'button'; refreshButton.className = 'button quiet'; refreshButton.textContent = 'Refresh details'; refreshButton.dataset.focusKey = `${runKey(item.profileId, item.repo, item.run)}:refresh`; refreshButton.disabled = detail.loading; refreshButton.addEventListener('click', () => { detail.permissionDenied = false; void loadDetails(runKey(item.profileId, item.repo, item.run), true); }); head.append(refreshButton); panel.append(head);
        if (detail.error) text(panel, 'p', `${detail.stale ? 'Showing stale details. ' : ''}${detail.error}`, 'detail-error');
        else if (detail.loading && detail.stale) text(panel, 'p', 'Refreshing; previous details may be stale.', 'detail-stale');
        if (detail.pending) text(panel, 'p', detail.pending, 'rerun-pending');
        if (!detail.loading && !detail.error && jobs.length === 0) text(panel, 'p', 'No jobs were returned for this run attempt.', 'detail-empty');
        for (const job of jobs) {
            const box = document.createElement('article'); box.className = 'job-card';
            const title = document.createElement('div'); title.className = 'job-title';
            const href = safeGitHubLink(job.html_url);
            if (href) { const link = document.createElement('a'); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = job.name || 'Unnamed job'; link.dataset.focusKey = `${runKey(item.profileId, item.repo, item.run)}:job:${job.id}`; title.append(link); }
            else text(title, 'strong', job.name || 'Unnamed job');
            text(title, 'span', jobState(job), 'job-status');
            const duration = durationFor(job.started_at, job.completed_at); if (duration) text(title, 'span', duration, 'job-duration');
            if (job.runner_name) text(title, 'span', `Runner: ${job.runner_name}`, 'job-runner');
            box.append(title);
            const steps = Array.isArray(job.steps) ? job.steps : [];
            if (steps.length) {
                const list = document.createElement('ol'); list.className = 'step-list';
                for (const step of steps) {
                    const line = document.createElement('li'); const stepStatus = step.conclusion || step.status || 'unknown';
                    text(line, 'span', step.name || 'Unnamed step'); text(line, 'span', stepStatus, step.status === 'in_progress' ? 'step-current' : '');
                    const stepDuration = durationFor(step.started_at, step.completed_at); if (stepDuration) text(line, 'span', stepDuration);
                    list.append(line);
                }
                box.append(list);
            }
            panel.append(box);
        }
        const failedJobs = jobs.some((job) => ['failure', 'timed_out'].includes(job.conclusion));
        const created = Date.parse(item.run.created_at || ''), tooOld = Number.isFinite(created) && Date.now() - created > 30 * 86400000;
        const exhausted = Number(item.run.run_attempt) >= 51;
        const active = activeStates.has(item.run.status);
        const controls = document.createElement('div'); controls.className = 'rerun-controls';
        for (const [failedOnly, label] of [[false, 'Re-run all jobs'], [true, 'Re-run failed jobs']]) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'button quiet'; button.textContent = label; button.dataset.focusKey = `${runKey(item.profileId, item.repo, item.run)}:${failedOnly ? 'failed' : 'all'}`;
            const reason = tooOld ? 'Runs older than 30 days cannot be rerun.' : active ? 'This run is still active.' : exhausted ? 'GitHub allows at most 50 reruns.' : item.run.status !== COMPLETED ? 'Only completed runs can be rerun.' : failedOnly && item.run.conclusion !== 'failure' && item.run.conclusion !== 'timed_out' && !failedJobs ? 'No failed or timed-out jobs are available.' : '';
            button.disabled = Boolean(reason || detail.rerunBusy || detail.pending); if (reason || detail.pending) button.title = reason || 'Waiting for GitHub to confirm a new attempt.';
            button.addEventListener('click', () => rerun(item, failedOnly)); controls.append(button); if (reason) text(controls, 'span', reason, 'rerun-reason');
        }
        if (detail.pending && detail.ambiguous) {
            const acknowledge = document.createElement('button'); acknowledge.type = 'button'; acknowledge.className = 'button quiet'; acknowledge.dataset.focusKey = `${runKey(item.profileId, item.repo, item.run)}:acknowledge`; acknowledge.textContent = 'I checked GitHub; allow another request'; acknowledge.addEventListener('click', () => { detail.pending = ''; detail.ambiguous = false; detail.rerunBusy = false; render(); }); controls.append(acknowledge);
        }
        panel.append(controls);
    }
    function reconcileDetails(visibleKeys) {
        const visible = new Set(visibleKeys);
        state.visibleKeys = visible;
        for (const [key, op] of state.detailOperations) if (!visible.has(key) && op.controller) { op.controller.abort(); state.detailOperations.delete(key); }
    }
    function toggleDetails(key) {
        const detail = state.details.get(key) || { expanded: false, jobs: [], total: 0, attempt: null, pending: '', loading: false, error: '' };
        detail.expanded = !detail.expanded; state.details.set(key, detail);
        if (detail.expanded) void loadDetails(key, true);
        else { state.detailOperations.get(key)?.controller.abort(); state.detailOperations.delete(key); }
        render();
    }
    async function loadDetails(key, force = false) {
        const item = state.runs.get(key), detail = state.details.get(key);
        if (!item || !detail?.expanded || (detail.permissionDenied && !detail.pending && !activeStates.has(item.run.status)) || document.visibilityState !== 'visible' || state.detailOperations.has(key)) return;
        if (!force && detail.loaded && !detail.pending && !activeStates.has(item.run.status)) return;
        const profile = state.profiles.find((candidate) => candidate.id === item.profileId), entry = profile && clientFor(profile);
        if (!profile || !entry || entry.client.authInvalid || entry.suspendedRepos.has(repoKey(item.repo))) return;
        const controller = new AbortController(), op = { controller, epoch: state.epoch, profileId: item.profileId };
        state.detailOperations.set(key, op); detail.loading = true; detail.error = ''; detail.stale = Boolean(detail.loaded); render();
        const [owner, repo] = item.repo.split('/');
        const current = () => !controller.signal.aborted && op.epoch === state.epoch && state.detailOperations.get(key) === op && state.clients.get(item.profileId) === entry && state.runs.get(key) === item;
        try {
            const metadata = await entry.client.getRun(owner, repo, item.run.id, { signal: controller.signal });
            if (!current()) return;
            const attempt = metadata.run_attempt ?? null;
            if (attempt !== detail.attempt) { detail.jobs = []; detail.total = 0; detail.loaded = false; detail.attempt = attempt; }
            item.run = { ...item.run, ...metadata };
            if (detail.pending && attempt !== null && Number(attempt) > Number(detail.pendingAttempt || 0) && detail.permissionDenied) { detail.pending = ''; detail.pendingAttempt = null; detail.error = 'A new attempt started, but GitHub denied access to its job details.'; detail.ambiguous = false; return; }
            if (detail.pending && (attempt === null || Number(attempt) <= Number(detail.pendingAttempt || 0))) { detail.jobs = []; detail.total = 0; detail.loaded = false; detail.stale = false; return; }
            if (detail.permissionDenied) return;
            const pages = new Set(), jobs = new Map(); let url = null, total = 0;
            do {
                const pageUrl = url || (attempt ? `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(item.run.id)}/attempts/${encodeURIComponent(attempt)}/jobs?per_page=100` : `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(item.run.id)}/jobs?filter=latest&per_page=100`);
                if (pages.has(pageUrl)) throw new Error('GitHub returned a repeated jobs page; details are incomplete.');
                pages.add(pageUrl);
                const result = attempt ? await entry.client.listAttemptJobs(owner, repo, item.run.id, attempt, { url: pageUrl, signal: controller.signal }) : await entry.client.listLatestJobs(owner, repo, item.run.id, { url: pageUrl, signal: controller.signal });
                if (!current()) return;
                total = Math.max(total, result.total); for (const job of result.jobs) if (job?.id !== undefined) jobs.set(job.id, job);
                url = result.links.next || null;
            } while (url);
            if (!current()) return;
            detail.jobs = [...jobs.values()]; detail.total = Math.max(total, detail.jobs.length); detail.loaded = true; detail.stale = false; detail.error = ''; detail.refreshAfterAttempt = false;
            if (detail.pending && attempt !== null && Number(attempt) > Number(detail.pendingAttempt || 0)) { detail.pending = ''; detail.pendingAttempt = null; detail.ambiguous = false; }
        } catch (error) {
            if (current() && error.kind !== CANCELLED) { detail.error = error.message || 'Could not load run details.'; if (error.kind === 'permission' || error.kind === 'not-found') detail.permissionDenied = true; }
        } finally {
            if (state.detailOperations.get(key) === op) state.detailOperations.delete(key);
            if (op.epoch === state.epoch) { detail.loading = false; if (state.details.get(key) === detail) render(); }
        }
    }
    async function rerun(item, failedOnly) {
        const key = runKey(item.profileId, item.repo, item.run), detail = state.details.get(key), profile = state.profiles.find((candidate) => candidate.id === item.profileId);
        if (!detail || detail.rerunBusy || !profile || document.visibilityState !== 'visible') return;
        const target = { profileId: profile.id, token: profile.token, repo: item.repo, runId: item.run.id, attempt: item.run.run_attempt, run: { ...item.run } };
        const warning = `Request ${failedOnly ? 'failed jobs' : 'all jobs'} to rerun?\n\n${profile.name} · ${target.repo}\n${target.run.name || target.run.display_title || 'Workflow run'} · ${target.run.head_branch || 'ref unavailable'} · ${target.run.head_sha || 'commit unavailable'}\n\nGitHub reruns use the original actor's workflow privileges and may incur Actions usage charges.`;
        if (!confirm(warning)) return;
        const entry = clientFor(profile), controller = new AbortController(), op = { profileId: target.profileId, controller, epoch: state.epoch };
        detail.rerunBusy = true; detail.pendingAttempt = target.attempt; state.operations.add(op); render();
        try {
            if (entry.token !== target.token || state.clients.get(target.profileId) !== entry) throw new Error('The selected profile changed. Reopen the run before retrying.');
            await entry.client.rerun(target.repo.split('/')[0], target.repo.split('/')[1], target.runId, failedOnly, { signal: controller.signal });
            if (op.epoch !== state.epoch || state.clients.get(target.profileId) !== entry || controller.signal.aborted) return;
            detail.pending = 'Rerun requested—waiting for new attempt.'; detail.pendingAttempt = target.attempt; detail.rerunBusy = false;
            detail.jobs = []; detail.total = 0; detail.loaded = false; detail.stale = false;
            void loadDetails(key, true);
        } catch (error) {
            if (op.epoch !== state.epoch || state.clients.get(target.profileId) !== entry) return;
            detail.rerunBusy = false;
            if (error.ambiguous) { detail.pending = 'Request may have been accepted; check GitHub before retrying.'; detail.pendingAttempt = target.attempt; detail.ambiguous = true; detail.jobs = []; detail.total = 0; detail.loaded = false; detail.stale = false; }
            else if (error.kind !== CANCELLED) detail.error = error.message;
        } finally { done(op); if (op.epoch === state.epoch) render(); }
    }
    function updateFilterOptions() {
        const filter = (id, values, label) => { const select = $(id), prior = select.value; select.replaceChildren(new Option(`All ${label}`, ALL), ...[...new Set(values)].sort().map((value) => new Option(value, value))); if ([...select.options].some((option) => option.value === prior)) select.value = prior; };
        const visible = [...state.runs.values()].filter((item) => $('profile-filter').value === ALL || item.profileId === $('profile-filter').value);
        filter('repo-filter', visible.map(({ repo }) => repo), 'repositories');
        filter('workflow-filter', visible.map(({ run }) => run.name || run.display_title || 'Workflow run'), 'workflows');
        filter('branch-filter', visible.map(({ run }) => run.head_branch || 'Unknown'), 'branches');
    }
    function operation(profileId) { const controller = new AbortController(); const op = { profileId, controller, epoch: state.epoch }; state.operations.add(op); return op; }
    function done(op) { state.operations.delete(op); }
    function clientFor(profile) {
        let entry = state.clients.get(profile.id);
        if (!entry) { const client = new CimApi.GitHubClient(); client.reset(profile.token); entry = { client, token: profile.token, repos: new Set(profile.repos.map(repoKey)), suspendedRepos: new Set() }; state.clients.set(profile.id, entry); }
        return entry;
    }
    function clearRepoCache(entry, repo) {
        const prefix = `/repos/${repo}/actions/runs`.toLocaleLowerCase('en-US');
        for (const url of entry.client.cache.keys()) if (new URL(url).pathname.toLocaleLowerCase('en-US').startsWith(prefix)) entry.client.cache.delete(url);
    }
    function reposFor(profile) { return profile.repos; }
    async function refreshLatest(signal) {
        const results = new Map(); const profiles = currentProfiles(); const cycleEpoch = state.epoch; let expectedRequests = 0;
        const latestRuns = [];
        for (const profile of profiles) {
            if (signal.aborted || cycleEpoch !== state.epoch) break;
            const entry = clientFor(profile);
            for (const repo of reposFor(profile)) {
                if (signal.aborted || cycleEpoch !== state.epoch) break;
                const key = profileKey(profile.id, repo);
                if (entry.client.authInvalid || entry.client.retryAt > Date.now() || entry.suspendedRepos.has(repoKey(repo))) continue;
                const [owner, name] = repo.split('/');
                expectedRequests++;
                try {
                    const value = await entry.client.listRuns(owner, name, { signal });
                    if (signal.aborted || cycleEpoch !== state.epoch || state.clients.get(profile.id) !== entry) continue;
                    for (const run of value.runs) { const key = runKey(profile.id, repo, run), previous = state.runs.get(key), details = state.details.get(key); if (details && previous && previous.run.run_attempt !== run.run_attempt) { details.jobs = []; details.total = 0; details.loaded = false; details.attempt = run.run_attempt ?? null; details.stale = false; details.refreshAfterAttempt = details.expanded; } state.runs.set(key, { profileId: profile.id, profileName: profile.name, repo, run }); latestRuns.push(run); }
                    state.latestLinks.set(key, value.links.next || null);
                    if (!state.historyStarted.has(key)) state.historyLinks.set(key, value.links.next || null);
                    results.set(key, { runs: value.runs });
                } catch (error) {
                    if (error.kind === CANCELLED || signal.aborted || cycleEpoch !== state.epoch) continue;
                    if (error.kind === 'permission' || error.kind === 'not-found') entry.suspendedRepos.add(repoKey(repo));
                    results.set(key, { error });
                }
            }
        }
        const visibleDetailKeys = [...state.details.entries()].filter(([key, detail]) => detail.expanded && detailVisible(key) && (state.forceDetailsRefresh || detail.pending || detail.refreshAfterAttempt || activeStates.has(state.runs.get(key)?.run.status))).map(([key]) => key);
        let forceRefreshPending = false;
        for (const key of visibleDetailKeys) {
            if (signal.aborted || cycleEpoch !== state.epoch) break;
            const detail = state.details.get(key), item = state.runs.get(key);
            if (!detail || !item) continue;
            const entry = state.clients.get(item.profileId);
            if (!entry || entry.client.authInvalid || entry.client.retryAt > Date.now() || entry.suspendedRepos.has(repoKey(item.repo))) { forceRefreshPending ||= state.forceDetailsRefresh; continue; }
            if (state.forceDetailsRefresh) detail.permissionDenied = false;
            await loadDetails(key, true);
            expectedRequests += 2 + Math.ceil((detail.total || 0) / 100);
        }
        if (!signal.aborted) state.forceDetailsRefresh = forceRefreshPending;
        if (signal.aborted || cycleEpoch !== state.epoch) return { results, runs: [], continueMonitoring: false };
        const now = Date.now();
        const eligibleNow = profiles.some((profile) => { const entry = state.clients.get(profile.id); return entry && !entry.client.authInvalid && entry.client.retryAt <= now && profile.repos.some((repo) => !entry.suspendedRepos.has(repoKey(repo))); });
        const cooldowns = profiles.map((profile) => state.clients.get(profile.id)?.client).filter((client) => client && !client.authInvalid && client.retryAt > now).map((client) => client.retryAt);
        const active = latestRuns.some((run) => activeStates.has(run.status)) || visibleDetailKeys.length > 0;
        const nextAt = CimMonitor.nextPollAt(now, expectedRequests, active, cooldowns);
        return { results, runs: latestRuns, nextAt, continueMonitoring: eligibleNow || cooldowns.length > 0 };
    }
    function updateMonitorLabel() {
        const enabled = document.visibilityState === 'visible' && currentProfiles().length > 0;
        const clients = state.profiles.map((profile) => state.clients.get(profile.id)).filter(Boolean);
        const needsToken = clients.filter(({ client }) => client.authInvalid).length;
        const gatedRepos = clients.reduce((count, entry) => count + entry.suspendedRepos.size, 0);
        const rateLimited = clients.some(({ client }) => client.retryAt > Date.now());
        const eligible = clients.some((entry) => !entry.client.authInvalid && entry.client.retryAt <= Date.now() && [...entry.repos].some((repo) => !entry.suspendedRepos.has(repo)));
        const allRepos = clients.reduce((count, entry) => count + entry.repos.size, 0);
        $('monitor-label').textContent = !enabled ? 'Monitoring paused' : needsToken === clients.length ? 'Paused · update token' : gatedRepos === allRepos && allRepos > 0 ? 'Paused · check repository access' : !eligible && rateLimited ? 'Rate limited · waiting' : !eligible && needsToken ? 'Paused · update token or check access' : 'Monitoring while open';
    }
    function syncProfileUI() {
        const select = $('profile-select'); select.replaceChildren(new Option('Select a saved profile…', ''), ...state.profiles.map((profile) => new Option(`${profile.name} · ${profile.repos.length} repositories`, profile.id)));
        if (!state.profiles.some((profile) => profile.id === state.selected)) state.selected = state.profiles[0]?.id || '';
        select.value = state.editingId === null ? '' : state.editingId;
        $('profile-delete').disabled = !state.editingId || !selectedProfileForEdit(); $('forget-token').disabled = !state.editingId || !selectedProfileForEdit()?.token;
    }
    function selectedProfileForEdit() { return state.profiles.find((profile) => profile.id === state.editingId); }
    function openSettings() {
        if (!state.profiles.some((profile) => profile.id === state.editingId)) state.editingId = state.profiles.some((profile) => profile.id === state.selected) ? state.selected : null;
        syncProfileUI(); const profile = selectedProfileForEdit();
        $('profile-id').value = profile?.id || ''; $('profile-name').value = profile?.name || ''; $('repositories').value = profile?.repos.join('\n') || ''; $('remember').checked = profile?.rememberToken === true; $('token').value = '';
        $('forget-token').disabled = !profile?.token; $('profile-delete').disabled = !profile; $('settings-mode').textContent = profile ? 'Edit connection' : 'New connection';
        setSettingsMessage('Blank PAT keeps only this profile’s existing token.', ''); if (!$('settings-dialog').open) $('settings-dialog').showModal();
    }
    function validateForm() {
        const parsed = CimSettings.parseRepositories($('repositories').value); if (parsed.errors.length) throw new Error(parsed.errors.join('\n'));
        if (!parsed.repos.length) throw new Error('Add at least one repository.');
        const token = $('token').value.trim() || (state.editingId ? selectedProfileForEdit()?.token : '') || '';
        if (!token) throw new Error('Enter a personal access token.');
        return { repos: parsed.repos, token };
    }
    async function testAccess() {
        if (state.settingsBusy) return;
        const targetId = state.editingId; const profile = targetId ? state.profiles.find((item) => item.id === targetId) : null; state.settingsBusy = true; setEditorBusy(true); const op = operation(targetId || 'pending'); state.testOperation = op;
        try {
            const proposed = validateForm(); const client = profile?.token === proposed.token ? clientFor(profile).client : new CimApi.GitHubClient(); if (client !== (profile && state.clients.get(profile.id)?.client)) client.reset(proposed.token); const messages = [];
            for (const repo of proposed.repos) {
                if (op.controller.signal.aborted || document.visibilityState !== 'visible') break;
                const [owner, name] = repo.split('/');
                try { await client.testRepo(owner, name, op.controller.signal); if (!op.controller.signal.aborted && profile?.token === proposed.token && state.clients.get(profile.id)?.client === client) state.clients.get(profile.id).suspendedRepos.delete(repoKey(repo)); messages.push(`${repo}: access confirmed`); }
                catch (error) {
                    if (error.kind === CANCELLED) break;
                    messages.push(`${repo}: ${error.message}`);
                }
            }
            if (!op.controller.signal.aborted) setSettingsMessage(messages.join('\n') || 'Access test cancelled while the dashboard was hidden.', messages.every((message) => message.endsWith('access confirmed')) ? 'success' : 'error');
        } catch (error) { if (!op.controller.signal.aborted) setSettingsMessage(error.message, 'error'); }
        finally { done(op); if (state.testOperation === op) state.testOperation = null; state.settingsBusy = false; setEditorBusy(false); updateMonitorLabel(); }
    }
    function setEditorBusy(busy) {
        for (const id of ['profile-select', 'profile-new', 'profile-name', 'repositories', 'token', 'remember', 'forget-token', 'profile-delete', 'save-settings', 'test-access']) $(id).disabled = busy;
        if (!busy) syncProfileUI();
    }
    async function saveProfile(event) {
        event.preventDefault(); if (state.writeBusy || state.settingsBusy) return; state.testOperation?.controller.abort();
        const targetId = state.editingId; const name = $('profile-name').value; const rememberToken = $('remember').checked; const tokenInput = $('token').value; const repositories = $('repositories').value; setEditorBusy(true);
        try {
            const proposedRepos = CimSettings.parseRepositories(repositories); if (proposedRepos.errors.length) throw new Error(proposedRepos.errors.join('\n'));
            if (!proposedRepos.repos.length) throw new Error('Add at least one repository.');
            if (!tokenInput.trim() && !targetId) throw new Error('Enter a personal access token.');
            const saved = await runWrite(() => store.saveProfile({ id: targetId || undefined, name, repos: proposedRepos.repos, rememberToken, tokenInput }));
            $('token').value = ''; state.selected = saved.id; state.editingId = saved.id; syncProfileUI(); $('settings-dialog').close(); setFeedback('Connection saved. Run monitoring is read-only; reruns require Actions write permission.', '');
        } catch (error) { setSettingsMessage(error.message, 'error'); }
        finally { setEditorBusy(false); }
    }
    async function runWrite(write) {
        if (state.writeBusy) throw new Error('A settings change is already in progress.');
        state.writeBusy = true;
        try { return await write(); }
        finally {
            state.writeBusy = false;
            try { await loadSettings(); } catch { setSettingsMessage('Settings could not be reloaded after the storage change.', 'error'); reportStorageError('Settings could not be reloaded after the storage change.'); }
        }
    }
    async function applySettings(profiles) {
        const incoming = new Map(profiles.map((profile) => [profile.id, profile])); const previous = new Map(state.profiles.map((profile) => [profile.id, profile]));
        const changed = new Set();
        for (const [id, old] of previous) { const next = incoming.get(id); if (!next || old.token !== next.token || JSON.stringify(old.repos) !== JSON.stringify(next.repos)) changed.add(id); }
        for (const id of incoming.keys()) if (!previous.has(id)) changed.add(id);
        if (!changed.size && state.profiles.length) { state.profiles = profiles; for (const item of state.runs.values()) item.profileName = incoming.get(item.profileId)?.name || item.profileName; render(); syncProfileUI(); updateMonitorLabel(); return; }
        monitor.stop(); state.epoch++;
        for (const op of state.operations) if (changed.has(op.profileId) || op.profileIds?.some((id) => changed.has(id)) || op.profileId === 'pending') op.controller.abort();
        for (const [key, op] of state.detailOperations) if (changed.has(op.profileId)) { op.controller.abort(); state.detailOperations.delete(key); }
        for (const id of changed) {
            const old = previous.get(id), next = incoming.get(id); const entry = state.clients.get(id);
            if (!next) state.clients.delete(id);
            else if (!old || old.token !== next.token) {
                entry?.client.reset(next.token);
                const client = entry?.client || new CimApi.GitHubClient(); if (!entry) client.reset(next.token);
                state.clients.set(id, { client, token: next.token, repos: new Set(next.repos.map(repoKey)), suspendedRepos: new Set() });
                for (const key of [...state.runs.keys()]) if (key.startsWith(`${id}${KEY_SEPARATOR}`)) state.runs.delete(key);
                for (const map of [state.errors, state.latestLinks, state.historyLinks]) for (const key of [...map.keys()]) if (key.startsWith(`${id}${KEY_SEPARATOR}`)) map.delete(key);
                for (const key of [...state.historyStarted]) if (key.startsWith(`${id}${KEY_SEPARATOR}`)) state.historyStarted.delete(key);
                for (const key of [...state.details.keys()]) if (key.startsWith(`${id}${KEY_SEPARATOR}`)) state.details.delete(key);
            }
            else if (entry) { const oldRepos = new Set(old.repos.map(repoKey)); const newRepos = new Set(next.repos.map(repoKey)); for (const repo of new Set([...oldRepos, ...newRepos])) if (oldRepos.has(repo) !== newRepos.has(repo)) { clearRepoCache(entry, repo); entry.suspendedRepos.delete(repo); for (const key of [...state.runs.keys()]) if (key.startsWith(`${id}${KEY_SEPARATOR}${repo}${KEY_SEPARATOR}`)) state.runs.delete(key); for (const key of [...state.details.keys()]) if (key.startsWith(`${id}${KEY_SEPARATOR}${repo}${KEY_SEPARATOR}`)) state.details.delete(key); state.errors.delete(`${id}${KEY_SEPARATOR}${repo}`); state.latestLinks.delete(`${id}${KEY_SEPARATOR}${repo}`); state.historyLinks.delete(`${id}${KEY_SEPARATOR}${repo}`); state.historyStarted.delete(`${id}${KEY_SEPARATOR}${repo}`); } entry.repos = new Set(next.repos.map(repoKey)); }
            for (const key of [...state.runs.keys()]) if (key.startsWith(`${id}${KEY_SEPARATOR}`) && (!next || !next.repos.some((repo) => key.startsWith(`${profileKey(id, repo)}${KEY_SEPARATOR}`)))) state.runs.delete(key);
            for (const key of [...state.details.keys()]) if (key.startsWith(`${id}${KEY_SEPARATOR}`) && (!next || !next.repos.some((repo) => key.startsWith(`${profileKey(id, repo)}${KEY_SEPARATOR}`)))) state.details.delete(key);
            for (const map of [state.errors, state.latestLinks, state.historyLinks]) for (const key of [...map.keys()]) if (key.startsWith(`${id}${KEY_SEPARATOR}`) && (!next || !next.repos.some((repo) => key === profileKey(id, repo)))) map.delete(key);
            for (const key of [...state.historyStarted]) if (key.startsWith(`${id}${KEY_SEPARATOR}`) && (!next || !next.repos.some((repo) => key === profileKey(id, repo)))) state.historyStarted.delete(key);
        }
        state.profiles = profiles; if (!incoming.has(state.selected)) state.selected = profiles[0]?.id || ALL;
        state.initialLoading = profiles.some((profile) => profile.token && profile.repos.length) && document.visibilityState === 'visible'; render(); syncProfileUI(); updateMonitorLabel();
        if (currentProfiles().length) void monitor.start();
    }
    const loadSettings = CimSettings.createSnapshotLoader(() => store.load(), applySettings);
    async function loadOlder() {
        if (state.loading) return;
        state.loading = true; render(); const selected = $('profile-filter').value; const targets = [...state.historyLinks.entries()].filter(([key, url]) => url && (selected === ALL || key.startsWith(`${selected}${KEY_SEPARATOR}`))); const errors = []; const epoch = state.epoch;
        const controller = new AbortController(); const op = { profileId: selected === ALL ? '*' : selected, profileIds: targets.map(([key]) => key.split(KEY_SEPARATOR)[0]), controller, epoch }; state.operations.add(op);
        try {
            for (const [key, url] of targets) {
                if (controller.signal.aborted || document.visibilityState !== 'visible' || epoch !== state.epoch) break;
                const [id, repo] = key.split(KEY_SEPARATOR); const profile = state.profiles.find((item) => item.id === id); const entry = state.clients.get(id); if (!profile || !entry || entry.client.authInvalid || entry.suspendedRepos.has(repoKey(repo))) continue;
                const [owner, name] = repo.split('/');
                try { const value = await entry.client.listRuns(owner, name, { url, signal: controller.signal }); if (controller.signal.aborted || epoch !== state.epoch || state.clients.get(id) !== entry) continue; for (const run of value.runs) { const runId = runKey(id, repo, run), previous = state.runs.get(runId), details = state.details.get(runId); if (details && previous && previous.run.run_attempt !== run.run_attempt) { details.jobs = []; details.total = 0; details.loaded = false; details.attempt = run.run_attempt ?? null; details.stale = false; details.refreshAfterAttempt = details.expanded; } state.runs.set(runId, { profileId: id, profileName: profile.name, repo, run }); } state.historyLinks.set(key, value.links.next || null); state.historyStarted.add(key); }
                catch (error) { if (error.kind === CANCELLED) break; if (error.kind === 'permission' || error.kind === 'not-found') entry.suspendedRepos.add(repoKey(repo)); errors.push(`${profile.name} · ${repo}: ${error.message}`); }
            }
        } finally { done(op); state.loading = false; render(); }
        if (errors.length) setFeedback(errors.join('\n'), 'error');
    }
    async function deleteProfile() {
        const targetId = state.editingId; const profile = state.profiles.find((item) => item.id === targetId); if (!profile || state.writeBusy || state.settingsBusy || !confirm(`Remove ${profile.name} and its saved connection settings?`)) return;
        setEditorBusy(true);
        const keepOpen = $('settings-dialog').open;
        try { await runWrite(() => store.deleteProfile(targetId)); $('token').value = ''; state.editingId = state.profiles.some((item) => item.id === state.selected) ? state.selected : null; if (keepOpen) openSettings(); else state.editingId = null; setSettingsMessage('Profile removed.', 'success'); }
        catch { setSettingsMessage('Could not remove profile from browser storage.', 'error'); reportStorageError('Could not remove profile from browser storage.'); }
        finally { setEditorBusy(false); }
    }
    async function forgetToken() {
        const targetId = state.editingId; const profile = state.profiles.find((item) => item.id === targetId); if (!profile || state.writeBusy || state.settingsBusy) return;
        setEditorBusy(true);
        const keepOpen = $('settings-dialog').open;
        try { await runWrite(() => store.forgetToken(targetId)); $('token').value = ''; $('remember').checked = false; state.editingId = targetId; if (keepOpen) openSettings(); setSettingsMessage('Token removed from session and device storage. Profile and repositories remain.', 'success'); }
        catch { setSettingsMessage('Could not remove token from browser storage.', 'error'); reportStorageError('Could not remove token from browser storage.'); }
        finally { setEditorBusy(false); }
    }
    $('settings-open').addEventListener('click', openSettings); $('setup-open').addEventListener('click', openSettings);
    $('settings-close').addEventListener('click', () => { state.testOperation?.controller.abort(); $('settings-dialog').close(); }); $('settings-form').addEventListener('submit', saveProfile);
    $('test-access').addEventListener('click', testAccess); $('forget-token').addEventListener('click', forgetToken); $('profile-delete').addEventListener('click', deleteProfile);
    $('profile-select').addEventListener('change', () => { state.testOperation?.controller.abort(); if (!$('profile-select').value) { $('profile-new').click(); return; } state.selected = $('profile-select').value; state.editingId = state.selected || null; openSettings(); });
    $('profile-new').addEventListener('click', () => { state.testOperation?.controller.abort(); state.editingId = null; syncProfileUI(); $('profile-select').value = ''; $('profile-id').value = ''; $('profile-name').value = ''; $('repositories').value = ''; $('token').value = ''; $('remember').checked = false; $('forget-token').disabled = true; $('profile-delete').disabled = true; $('settings-mode').textContent = 'New connection'; setSettingsMessage('Enter a PAT for this new profile. Blank PAT keeps only this profile’s existing token.', ''); if (!$('settings-dialog').open) $('settings-dialog').showModal(); });
    for (const id of ['profile-name', 'repositories', 'token', 'remember']) $(id).addEventListener('input', () => state.testOperation?.controller.abort());
    $('remember').addEventListener('change', () => state.testOperation?.controller.abort());
    $('profile-filter').addEventListener('change', () => { state.profileFilter = $('profile-filter').value; render(); }); $('refresh').addEventListener('click', () => { for (const entry of state.clients.values()) entry.suspendedRepos.clear(); state.forceDetailsRefresh = true; void monitor.refresh(); });
    $('older').addEventListener('click', () => { void loadOlder(); });
    for (const id of ['search', 'status-filter', 'repo-filter', 'workflow-filter', 'branch-filter']) $(id).addEventListener(id === 'search' ? 'input' : 'change', render);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { monitor.pause(); for (const op of state.operations) op.controller.abort(); for (const op of state.detailOperations.values()) op.controller.abort(); state.detailOperations.clear(); } else void monitor.resume(); updateMonitorLabel(); });
    window.addEventListener('pagehide', () => { monitor.stop(); for (const op of state.operations) op.controller.abort(); for (const op of state.detailOperations.values()) op.controller.abort(); state.detailOperations.clear(); });
    let storageTimer = null;
    chrome.storage.onChanged.addListener((changes, area) => {
        if (!['local', 'session'].includes(area) || !Object.keys(changes).some((key) => key.startsWith(CimSettings.PROFILE_PREFIX) || key.startsWith(CimSettings.TOKEN_PREFIX) || CimSettings.LEGACY_KEYS.includes(key))) return;
        if (state.writeBusy) return;
        clearTimeout(storageTimer); storageTimer = setTimeout(() => { if (state.writeBusy) return; void loadSettings().catch(() => reportStorageError('Could not reload changed profile settings from browser storage.')); }, 60);
    });
    void loadSettings().catch(() => reportStorageError('Could not load profile settings from browser storage.'));
})();
