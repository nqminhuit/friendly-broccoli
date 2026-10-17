(function (root, factory) {
    const dispatch = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = dispatch;
    root.CimDispatch = dispatch;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const MAX_WORKFLOWS = 500;
    const UNCERTAIN_ACK = 'I checked GitHub; allow another request';
    const TEXTAREA_MIN_LINES = 2;
    const TEXTAREA_MAX_LINES = 10;

    function safeGitHubUrl(value) {
        try {
            const url = new URL(String(value ?? ''));
            if (url.protocol === 'https:' && url.origin === 'https://github.com' && !url.username && !url.password) return url.href;
        } catch { /* Invalid URLs stay hidden. */ }
        return '';
    }

    function text(parent, tag, value, className) {
        const node = parent.ownerDocument.createElement(tag);
        node.textContent = value ?? '';
        if (className) node.className = className;
        parent.append(node);
        return node;
    }

    function createDispatchController({ document, getProfiles, getClientEntry, onDispatched, isVisible }) {
        const $ = (id) => document.getElementById(id);
        // Uncertain dispatches are keyed per immutable target+body; a resolved B never clears A.
        const state = { generation: 0, listController: null, fileController: null, repoController: null, submitBusy: false, submitSeq: 0, uncertain: new Map(), workflows: [], workflowsTruncated: false, target: null, schemaReady: false };
        const Schema = globalThis.CimWorkflowSchema || null;

        function profiles() { try { return getProfiles() || []; } catch { return []; } }

        function visible() { try { const check = isVisible; return typeof check === 'function' ? check() !== false : true; } catch { return true; } }

        function dialogOpen() { try { return Boolean($('dispatch-dialog')?.open); } catch { return false; } }

        const fittedTextareas = new WeakMap();

        // String fields grow with their wrapped content between a compact and a roomy
        // height, and are never capped, so a manual resize survives until text or width changes.
        function fitTextarea(field) {
            if (!field || field.tagName !== 'TEXTAREA') return;
            const view = document && document.defaultView;
            const style = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(field) : null;
            if (!style) return;
            const prior = fittedTextareas.get(field);
            const width = field.clientWidth;
            if (prior && prior.value === field.value && prior.width === width) return;
            const lineHeight = parseFloat(style.lineHeight);
            if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
            const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
            const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
            field.style.height = 'auto';
            const content = field.scrollHeight + border;
            const compact = lineHeight * TEXTAREA_MIN_LINES + padding + border;
            const roomy = lineHeight * TEXTAREA_MAX_LINES + padding + border;
            field.style.height = Math.round(Math.min(Math.max(content, compact), roomy)) + 'px';
            fittedTextareas.set(field, { value: field.value, width: field.clientWidth });
        }

        function fitTextareas() {
            const box = $('dispatch-inputs');
            if (!box || typeof box.querySelectorAll !== 'function') return;
            for (const field of box.querySelectorAll('textarea')) fitTextarea(field);
        }

        // Every read/post continuation must recheck lifetime: open dialog, visible page,
        // current generation, and owning profile credential.
        function readAlive(generation, entry, captured) {
            if (generation !== state.generation || !dialogOpen() || !visible()) return false;
            if (!entry || !captured) return false;
            try { if (getClientEntry(captured.profileId) !== entry || entry.token !== captured.token) return false; } catch { return false; }
            return true;
        }

        function setStatus(message, kind) {
            const target = $('dispatch-status');
            if (!target) return;
            target.textContent = message || '';
            target.className = `dispatch-status ${kind || ''}`;
            target.hidden = !message;
        }

        function setResultLink(label, href) {
            const box = $('dispatch-result');
            if (!box) return;
            box.replaceChildren();
            if (!label) return;
            const safe = safeGitHubUrl(href);
            if (safe) {
                const link = document.createElement('a');
                link.href = safe;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = label;
                box.append(link);
            } else text(box, 'span', label, 'dispatch-result-text');
        }

        function abortReads() {
            for (const key of ['listController', 'fileController', 'repoController']) {
                try { state[key]?.abort(); } catch { /* Aborted reads stay silent. */ }
                state[key] = null;
            }
        }

        function invalidateSchema(message) {
            try { state.fileController?.abort(); } catch { /* Stale schema reads never restore. */ }
            state.fileController = null;
            // Readiness clears with the form: submission needs a freshly loaded schema.
            state.schemaReady = false;
            state.target = null;
            const box = $('dispatch-inputs');
            if (box) box.replaceChildren();
            const meta = $('dispatch-schema-note');
            // A truncated workflow listing stays visible across schema reloads.
            const truncatedNote = state.workflowsTruncated && state.workflows.length ? ` Showing the first ${state.workflows.length} workflows; the repository list is truncated.` : '';
            if (meta) { meta.textContent = `${message || ''}${truncatedNote}`; meta.hidden = !meta.textContent; }
            const start = $('dispatch-start');
            if (start) start.disabled = true;
        }

        function setControlsEnabled(enabled) {
            for (const id of ['dispatch-profile', 'dispatch-repo', 'dispatch-workflow', 'dispatch-ref', 'dispatch-load', 'dispatch-start']) {
                const node = $(id);
                if (node) node.disabled = !enabled;
            }
        }

        function gateKeyFor(selection, inputs) {
            return `${selection.profileId}|${selection.repo}|${selection.workflowId}|${selection.ref}|${JSON.stringify(inputs ?? null)}`;
        }

        function targetPrefixOf(record) {
            return `${record.profileId}|${record.repo}|${record.workflowId}|${record.ref}`;
        }

        function selectionPrefix(selection) {
            return `${selection.profileId}|${selection.repo}|${selection.workflowId}|${selection.ref}`;
        }

        function matchingUncertain(selection) {
            const prefix = selectionPrefix(selection);
            const matches = [];
            for (const [key, record] of state.uncertain) {
                if (targetPrefixOf(record) === prefix) matches.push([key, record]);
            }
            return matches;
        }

        function renderAcknowledge(matches) {
            const box = $('dispatch-result');
            if (!box) return;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'button quiet';
            button.textContent = UNCERTAIN_ACK;
            button.addEventListener('click', () => {
                for (const [key] of matches) state.uncertain.delete(key);
                setStatus('', '');
                setResultLink('', '');
                button.remove();
                if (state.schemaReady && dialogOpen() && visible()) {
                    const start = $('dispatch-start');
                    if (start) start.disabled = false;
                } else if (dialogOpen() && visible()) {
                    // Acknowledgement is an explicit user gesture: reload the
                    // current target inputs (GET only, never POST) when hidden
                    // time cleared schema readiness.
                    void loadSchema();
                }
            });
            box.append(button);
            const start = $('dispatch-start');
            if (start) start.disabled = true;
        }

        // Reopening an uncertain target restores its warning, workflow link, and ack.
        function restoreUncertainBanner(selection) {
            const matches = matchingUncertain(selection);
            if (!matches.length) return false;
            const [, record] = matches[0];
            const box = $('dispatch-result');
            const already = [...(box?.querySelectorAll?.('button') || [])].some((node) => node.textContent === UNCERTAIN_ACK);
            setStatus('Request may have been accepted; check GitHub before retrying.', 'error');
            if (!box?.textContent?.includes('Open workflow on GitHub')) setResultLink('Open workflow on GitHub to verify ↗', record.workflowUrl);
            if (!already) renderAcknowledge(matches);
            else { const start = $('dispatch-start'); if (start) start.disabled = true; }
            return true;
        }

        function currentSelection() {
            return { profileId: $('dispatch-profile')?.value || '', repo: $('dispatch-repo')?.value || '', workflowId: $('dispatch-workflow')?.value || '', ref: $('dispatch-ref')?.value.trim() || '' };
        }

        function syncRepoOptions() {
            const list = profiles();
            const profileSelect = $('dispatch-profile');
            const priorProfile = profileSelect?.value || '';
            if (profileSelect) {
                profileSelect.replaceChildren();
                for (const profile of list) {
                    const option = document.createElement('option');
                    option.value = profile.id;
                    option.textContent = `${profile.name} · ${profile.repos.length} repositories`;
                    profileSelect.append(option);
                }
                if (list.some((item) => item.id === priorProfile)) profileSelect.value = priorProfile;
                profileSelect.disabled = !list.length;
            }
            const active = list.find((item) => item.id === (profileSelect?.value || '')) || list[0];
            const repoSelect = $('dispatch-repo');
            const priorRepo = repoSelect?.value || '';
            if (repoSelect) {
                repoSelect.replaceChildren();
                for (const repo of active?.repos || []) {
                    const option = document.createElement('option');
                    option.value = repo;
                    option.textContent = repo;
                    repoSelect.append(option);
                }
                if ((active?.repos || []).includes(priorRepo)) repoSelect.value = priorRepo;
                repoSelect.disabled = !(active?.repos || []).length;
            }
        }

        async function loadReposAndWorkflows() {
            if (!dialogOpen() || !visible()) return;
            const selection = currentSelection();
            const profile = profiles().find((item) => item.id === selection.profileId);
            if (!profile) { setStatus('Add a connection profile with a token to start a workflow.', 'error'); invalidateSchema(''); return; }
            abortReads();
            invalidateSchema('');
            state.workflows = [];
            state.workflowsTruncated = false;
            const generation = ++state.generation;
            setStatus('', '');
            // Preserve an uncertain target's warning/link/ack across reloads.
            if (!restoreUncertainBanner(selection)) setResultLink('', '');
            const workflowSelect = $('dispatch-workflow');
            if (workflowSelect) { workflowSelect.replaceChildren(new Option('Loading workflows…', '')); workflowSelect.disabled = true; }
            const entry = getClientEntry(selection.profileId);
            if (!entry || !entry.token) { setStatus('This profile lost its token. Reopen after saving a token.', 'error'); return; }
            if (!profile.repos.includes(selection.repo) && selection.repo) { setStatus('This repository is no longer in the selected profile.', 'error'); return; }
            const captured = { profileId: selection.profileId, token: entry.token, repo: selection.repo || profile.repos[0] || '' };
            // Default branch + workflow listing use the owning profile client gates.
            const repoController = new AbortController();
            state.repoController = repoController;
            let defaultBranch = '';
            if (captured.repo && captured.repo.includes('/')) {
                const [owner, name] = captured.repo.split('/');
                try {
                    const repo = await entry.client.getRepo(owner, name, { signal: repoController.signal });
                    if (!readAlive(generation, entry, captured)) return;
                    if (typeof repo?.default_branch === 'string' && repo.default_branch) defaultBranch = repo.default_branch;
                } catch (error) {
                    if (!readAlive(generation, entry, captured)) return;
                    // Contents/write failures must not suspend run monitoring; show form-only error.
                    if (error?.kind !== 'cancelled') setStatus(`Could not read ${captured.repo}: ${error.message || 'request failed.'}`, 'error');
                }
            }
            if (!readAlive(generation, entry, captured)) return;
            const refInput = $('dispatch-ref');
            if (refInput && !refInput.value.trim() && defaultBranch) refInput.value = defaultBranch;
            if (refInput) refInput.placeholder = defaultBranch || 'main';
            await loadWorkflows(captured, entry, generation);
        }

        async function loadWorkflows(captured, entry, generation) {
            const workflowSelect = $('dispatch-workflow');
            const [owner, name] = String(captured.repo || '').split('/');
            if (!owner || !name) {
                if (workflowSelect) { workflowSelect.replaceChildren(new Option('Select a repository first', '')); workflowSelect.disabled = true; }
                return;
            }
            const listController = new AbortController();
            state.listController = listController;
            const workflows = new Map();
            const seenPages = new Set();
            let url = null;
            let truncated = false;
            try {
                do {
                    // A repeated Link page means the listing cycles: surface it, never spin.
                    if (url && seenPages.has(url)) { truncated = true; break; }
                    if (url) seenPages.add(url);
                    const page = await entry.client.listWorkflows(owner, name, url ? { url, signal: listController.signal } : { signal: listController.signal });
                    if (!readAlive(generation, entry, captured)) return;
                    for (const item of page.workflows) {
                        if (item && (typeof item.id === 'number' || typeof item.id === 'string') && !workflows.has(String(item.id))) workflows.set(String(item.id), item);
                        if (workflows.size >= MAX_WORKFLOWS) break;
                    }
                    url = page.links?.next || null;
                    // Never assume the first page holds the target workflow.
                    if (workflows.size >= MAX_WORKFLOWS) { truncated = true; break; }
                } while (url);
            } catch (error) {
                if (!readAlive(generation, entry, captured)) return;
                if (error?.kind === 'cancelled') return;
                setStatus(`Could not list workflows: ${error.message || 'request failed.'}`, 'error');
                if (workflowSelect) { workflowSelect.replaceChildren(new Option('Workflows unavailable', '')); workflowSelect.disabled = true; }
                return;
            } finally {
                if (state.listController === listController) state.listController = null;
            }
            if (!readAlive(generation, entry, captured)) return;
            state.workflows = [...workflows.values()];
            state.workflowsTruncated = truncated;
            renderWorkflowOptions(captured);
        }

        function renderWorkflowOptions(captured) {
            const workflowSelect = $('dispatch-workflow');
            if (!workflowSelect) return;
            const prior = workflowSelect.value || '';
            workflowSelect.replaceChildren();
            if (!state.workflows.length) {
                workflowSelect.append(new Option('No workflows found', ''));
                workflowSelect.disabled = true;
                invalidateSchema('No workflows were returned for this repository.');
                return;
            }
            for (const item of state.workflows) {
                const id = String(item.id ?? '');
                const label = `${item.name || item.path || `Workflow ${id}`}${item.state && item.state !== 'active' ? ` · ${item.state} (cannot start)` : ''}`;
                const option = new Option(label, id);
                option.dataset.path = typeof item.path === 'string' ? item.path : '';
                option.dataset.state = typeof item.state === 'string' ? item.state : 'active';
                workflowSelect.append(option);
            }
            workflowSelect.disabled = false;
            if ([...workflowSelect.options].some((option) => option.value === prior)) workflowSelect.value = prior;
            const chosen = workflowSelect.selectedOptions[0];
            if (chosen && chosen.dataset.state && chosen.dataset.state !== 'active') invalidateSchema('This workflow is disabled and cannot be started.');
            else void loadSchema();
        }

        async function loadSchema() {
            if (!dialogOpen() || !visible()) return;
            const selection = currentSelection();
            const profile = profiles().find((item) => item.id === selection.profileId);
            const entry = selection.profileId ? getClientEntry(selection.profileId) : null;
            const workflowOption = $('dispatch-workflow')?.selectedOptions[0];
            const workflowPath = workflowOption?.dataset.path || '';
            const workflowState = workflowOption?.dataset.state || 'active';
            invalidateSchema('');
            if (!profile || !entry || !entry.token || !selection.repo || !selection.workflowId || !selection.ref) {
                invalidateSchema(!selection.ref ? 'Enter a branch or tag ref, then load inputs.' : '');
                return;
            }
            // A removed repo stays non-dispatchable even when the client object is shared.
            if (!profile.repos.includes(selection.repo)) { invalidateSchema('This repository is no longer in the selected profile.'); return; }
            if (workflowState !== 'active') { invalidateSchema('This workflow is disabled and cannot be started.'); return; }
            if (workflowPath && !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(workflowPath)) { invalidateSchema('This workflow file path is unsupported.'); return; }
            const generation = ++state.generation;
            try { state.fileController?.abort(); } catch { /* Replace outstanding reads. */ }
            const fileController = new AbortController();
            state.fileController = fileController;
            setStatus('Loading workflow inputs…', '');
            const captured = { profileId: selection.profileId, token: entry.token, repo: selection.repo, workflowId: selection.workflowId, workflowPath, ref: selection.ref };
            const [owner, name] = captured.repo.split('/');
            try {
                const file = await entry.client.getWorkflowFile(owner, name, captured.workflowPath || captured.workflowId, captured.ref, { signal: fileController.signal });
                if (!readAlive(generation, entry, captured)) return;
                if (!Schema) throw new Error('Workflow parser is unavailable.');
                const parsed = Schema.parseWorkflowYaml(file.text);
                if (!readAlive(generation, entry, captured)) return;
                // Stale YAML must never restore another workflow/ref/account form.
                const now = currentSelection();
                if (now.profileId !== captured.profileId || now.repo !== captured.repo || now.workflowId !== captured.workflowId || now.ref !== captured.ref) return;
                if (!parsed.dispatchable) { invalidateSchema(parsed.reason); setStatus(parsed.reason, 'error'); return; }
                renderInputs(parsed.inputs, captured);
                // A revisited uncertain target keeps its gate until acknowledged.
                if (!restoreUncertainBanner(now)) {
                    setStatus(parsed.inputs.length ? `Loaded ${parsed.inputs.length} input${parsed.inputs.length === 1 ? '' : 's'} from ${captured.ref}.` : `This workflow takes no inputs on ${captured.ref}. Review and start.`, 'success');
                    const start = $('dispatch-start');
                    if (start) start.disabled = false;
                }
            } catch (error) {
                if (!readAlive(generation, entry, captured)) return;
                if (error?.kind === 'cancelled') return;
                const now = currentSelection();
                if (now.profileId !== captured.profileId || now.repo !== captured.repo || now.workflowId !== captured.workflowId || now.ref !== captured.ref) return;
                invalidateSchema('');
                setStatus(error.message || 'Could not load workflow inputs.', 'error');
            } finally {
                if (state.fileController === fileController) state.fileController = null;
            }
        }

        function renderInputs(inputs, captured) {
            captured.inputsSchema = inputs;
            state.target = captured;
            state.schemaReady = true;
            const box = $('dispatch-inputs');
            if (!box) return;
            box.replaceChildren();
            const note = $('dispatch-schema-note');
            // Provider payload limit applies at submit; fields never truncate input.
            const truncatedNote = state.workflowsTruncated && state.workflows.length ? ` Showing the first ${state.workflows.length} workflows; the repository list is truncated.` : '';
            if (note) { note.textContent = `Inputs reflect ${captured.workflowPath || captured.workflowId} at ref ${captured.ref}.${truncatedNote}`; note.hidden = false; }
            for (const input of inputs) {
                const wrap = document.createElement('label');
                wrap.className = 'dispatch-field';
                wrap.dataset.input = input.name;
                const head = document.createElement('span');
                head.className = 'dispatch-field-head';
                text(head, 'strong', `${input.name}${input.required ? ' (required)' : ''}`);
                if (input.description) text(head, 'small', input.description, 'dispatch-help');
                text(head, 'small', `Type: ${input.type}${input.type === 'choice' && input.options ? ` (${input.options.length} options)` : ''}${input.type === 'environment' ? ' · GitHub environment name' : ''}`, 'dispatch-help');
                wrap.append(head);
                if (input.type === 'boolean') {
                    const check = document.createElement('input');
                    check.type = 'checkbox';
                    check.name = input.name;
                    check.checked = input.default === true;
                    check.setAttribute('aria-label', input.name);
                    wrap.append(check);
                } else if (input.type === 'choice') {
                    const select = document.createElement('select');
                    select.name = input.name;
                    select.setAttribute('aria-label', input.name);
                    if (!input.required) select.append(new Option('Use workflow default', ''));
                    for (const option of input.options || []) select.append(new Option(option, option));
                    if (typeof input.default === 'string' && (input.options || []).includes(input.default)) select.value = input.default;
                    wrap.append(select);
                } else if (input.type === 'number') {
                    const field = document.createElement('input');
                    field.type = 'number';
                    field.step = 'any';
                    field.name = input.name;
                    field.setAttribute('aria-label', input.name);
                    if (typeof input.default === 'number') field.value = String(input.default);
                    if (input.required) field.setAttribute('aria-required', 'true');
                    wrap.append(field);
                } else {
                    // Strings use a multiline-capable control so pasted newlines survive;
                    // environments stay single-line names. No field truncates input.
                    const field = input.type === 'environment'
                        ? (() => { const node = document.createElement('input'); node.type = 'text'; return node; })()
                        : document.createElement('textarea');
                    field.name = input.name;
                    field.setAttribute('aria-label', input.name);
                    if (typeof input.default === 'string') field.value = input.default;
                    if (input.type === 'environment') field.placeholder = 'environment name';
                    if (input.required) field.setAttribute('aria-required', 'true');
                    wrap.append(field);
                }
                const error = document.createElement('span');
                error.className = 'dispatch-error';
                error.hidden = true;
                error.dataset.errorFor = input.name;
                wrap.append(error);
                box.append(wrap);
            }
            fitTextareas();
        }

        function readFormValues() {
            const box = $('dispatch-inputs');
            const values = Object.create(null);
            if (!box) return values;
            for (const wrap of box.querySelectorAll('[data-input]')) {
                const name = wrap.dataset.input;
                const field = wrap.querySelector('[name]');
                if (!field) continue;
                if (field.type === 'checkbox') values[name] = field.checked;
                else values[name] = field.value;
            }
            return values;
        }

        function showFieldErrors(errors) {
            const box = $('dispatch-inputs');
            if (!box) return;
            for (const error of box.querySelectorAll('[data-error-for]')) {
                const message = Object.prototype.hasOwnProperty.call(errors, error.dataset.errorFor) ? errors[error.dataset.errorFor] : '';
                error.textContent = message;
                error.hidden = !message;
            }
        }

        async function submit(event) {
            event?.preventDefault();
            // One active submission owns busy/controls/result; concurrent submits wait.
            if (state.submitBusy) return;
            if (!dialogOpen() || !visible()) { setStatus('Reopen the dialog while the dashboard is visible to start.', 'error'); return; }
            const selection = currentSelection();
            const profile = profiles().find((item) => item.id === selection.profileId);
            const entry = selection.profileId ? getClientEntry(selection.profileId) : null;
            if (!profile || !entry || !entry.token) { setStatus('Select a connection profile with a token first.', 'error'); return; }
            const workflowOption = $('dispatch-workflow')?.selectedOptions[0];
            const workflowName = workflowOption ? workflowOption.textContent : selection.workflowId;
            const workflowPath = workflowOption?.dataset.path || selection.workflowId;
            const workflowState = workflowOption?.dataset.state || 'active';
            if (!selection.repo || !selection.workflowId || !selection.ref) { setStatus('Choose a repository, workflow, and ref before starting.', 'error'); return; }
            // Stale DOM never dispatches: repo must belong to the profile, workflow active,
            // ref must match the loaded schema target.
            if (!profile.repos.includes(selection.repo)) { setStatus('This repository is no longer in the selected profile.', 'error'); return; }
            if (workflowState !== 'active') { setStatus('This workflow is disabled and cannot be started.', 'error'); return; }
            if (!state.schemaReady || !state.target || state.target.profileId !== selection.profileId || state.target.repo !== selection.repo || state.target.workflowId !== selection.workflowId || state.target.ref !== selection.ref) { setStatus('Load inputs for this workflow and ref first.', 'error'); return; }
            // Repeat identical uncertain dispatches stay gated until explicit acknowledgement.
            const values = readFormValues();
            if (!Schema) { setStatus('Workflow parser is unavailable.', 'error'); return; }
            const effective = Array.isArray(state.target.inputsSchema) ? state.target.inputsSchema : [];
            const checked = Schema.validateDispatchValues(effective, values);
            showFieldErrors(checked.errors);
            if (!checked.ok) { setStatus('Fix the highlighted inputs before starting.', 'error'); return; }
            if (Schema.isPayloadTooLarge(selection.ref, checked.inputs)) { setStatus('Workflow inputs exceed the 65535 character payload limit.', 'error'); return; }
            const gateKey = gateKeyFor(selection, checked.inputs);
            if (state.uncertain.has(gateKey)) { setStatus('This exact request is uncertain. Check GitHub, then acknowledge to allow another request.', 'error'); return; }
            // Snapshot immutable target+PAT; recheck ownership before and after sending.
            const captured = { profileId: profile.id, token: entry.token, repo: selection.repo, workflowId: selection.workflowId, workflowPath, ref: selection.ref, inputs: checked.inputs, workflowName };
            const owned = () => {
                try { return getClientEntry(captured.profileId) === entry && entry.token === captured.token; } catch { return false; }
            };
            const stillCurrent = () => {
                const now = currentSelection();
                return now.profileId === captured.profileId && now.repo === captured.repo && now.workflowId === captured.workflowId && now.ref === captured.ref;
            };
            if (!owned() || !stillCurrent()) { setStatus('The selected profile changed. Reload before starting.', 'error'); return; }
            const seq = ++state.submitSeq;
            const genAtSubmit = state.generation;
            const isOwner = () => state.submitSeq === seq;
            state.submitBusy = true;
            setControlsEnabled(false);
            setStatus('Starting workflow…', '');
            if (stillCurrent()) setResultLink('', '');
            const [owner, name] = captured.repo.split('/');
            try {
                const outcome = await entry.client.dispatchWorkflow(owner, name, captured.workflowId, { ref: captured.ref, inputs: captured.inputs, signal: submitSignal() });
                if (!isOwner()) return;
                if (!stillCurrent()) return;
                if (!owned() || !dialogOpen()) { setStatus('The selected profile changed during the request. Check GitHub for this workflow.', 'error'); return; }
                // Only this exact target+body resolves; other uncertain targets stay gated.
                state.uncertain.delete(gateKey);
                if (!stillCurrent()) return;
                setStatus(`Workflow requested. Monitoring run ${outcome.runId}.`, 'success');
                setResultLink(`Open run ${outcome.runId} on GitHub ↗`, outcome.htmlUrl);
                try { await onDispatched?.({ profileId: captured.profileId, repo: captured.repo, runId: outcome.runId, token: captured.token, htmlUrl: outcome.htmlUrl }); } catch { /* Pinning never blocks the result link. */ }
            } catch (error) {
                if (!isOwner()) return;
                if (!owned()) { if (stillCurrent() || dialogOpen()) setStatus('The selected profile changed. Check GitHub before retrying.', 'error'); return; }
                if (error?.ambiguous) {
                    const repoUrl = `https://github.com/${captured.repo}/actions/workflows/${encodeURIComponent(String(captured.workflowPath || captured.workflowId).split('/').pop())}`;
                    // Owned uncertainty survives close/reopen even when the form moved.
                    state.uncertain.set(gateKey, { profileId: captured.profileId, token: captured.token, repo: captured.repo, workflowId: captured.workflowId, ref: captured.ref, inputs: captured.inputs, workflowUrl: repoUrl });
                    if (!stillCurrent() || !dialogOpen()) return;
                    // Ambiguous dispatch has no known run ID: link the workflow page, never newest row.
                    setStatus('Request may have been accepted; check GitHub before retrying.', 'error');
                    setResultLink('Open workflow on GitHub to verify ↗', repoUrl);
                    renderAcknowledge([[gateKey, state.uncertain.get(gateKey)]]);
                } else if (error?.kind !== 'cancelled') {
                    if (!stillCurrent()) return;
                    setStatus(error.message || 'Could not start the workflow.', 'error');
                } else {
                    if (!stillCurrent()) return;
                    // Queued POST cancelled before send leaves no request and no gate.
                    setStatus('Start was cancelled before GitHub received it. Review and try again.', 'error');
                }
            } finally {
                // A stale operation never enables or clobbers a newer submission.
                if (isOwner()) {
                    state.submitBusy = false;
                    if (dialogOpen() && genAtSubmit === state.generation) {
                        setControlsEnabled(true);
                        const start = $('dispatch-start');
                        if (start) start.disabled = !state.schemaReady || matchingUncertain(currentSelection()).length > 0;
                    } else if (dialogOpen()) {
                        const start = $('dispatch-start');
                        if (start) start.disabled = !state.schemaReady || matchingUncertain(currentSelection()).length > 0;
                    }
                }
            }
        }

        let submitController = null;
        function submitSignal() {
            try { submitController?.abort(); } catch { /* Replace prior submit. */ }
            submitController = new AbortController();
            return submitController.signal;
        }



        function open() {
            const dialog = $('dispatch-dialog');
            if (!dialog) return;
            syncRepoOptions();
            // Never carry a stale ref from another account/repo into a new target.
            const now = currentSelection();
            const refInput = $('dispatch-ref');
            if (refInput && (!state.target || state.target.profileId !== now.profileId || state.target.repo !== now.repo)) refInput.value = '';
            if (!dialog.open) { dialog.showModal(); const first = $('dispatch-profile'); first?.focus({ preventScroll: true }); }
            if (!dialogOpen() || !visible()) return;
            // Reopening restores controls an aborted submission may have disabled.
            setControlsEnabled(true);
            void loadReposAndWorkflows();
        }

        // Dialog-close and hide share one path: invalidate reads+readiness, keep
        // owned uncertainty, and never settle another operation's busy flag.
        function noteClosed() {
            abortReads();
            try { submitController?.abort(); } catch { /* Closing never declares the workflow stopped. */ }
            state.generation++;
            state.schemaReady = false;
            state.target = null;
            invalidateSchema('');
        }

        function close() {
            noteClosed();
            const dialog = $('dispatch-dialog');
            if (dialog?.open) dialog.close();
            $('new-run')?.focus({ preventScroll: true });
        }

        function handleHidden() {
            // Reads abort on hide without launching replacements; a sent POST abort
            // stays uncertain via its owned catch. Generation invalidates continuations.
            abortReads();
            try { submitController?.abort(); } catch { /* Uncertain POSTs gate until acknowledged. */ }
            state.generation++;
            state.schemaReady = false;
        }

        function handleProfileChange(profileId) {
            // Clear only the changed profile's records; other profiles stay usable.
            for (const [key, record] of [...state.uncertain]) {
                if (record.profileId === profileId) state.uncertain.delete(key);
            }
            // Unrelated selections keep their form and in-flight operations.
            const selection = currentSelection();
            if (selection.profileId !== profileId && state.target?.profileId !== profileId) return;
            abortReads();
            try { submitController?.abort(); } catch { /* Credential-owned POSTs resolve separately. */ }
            state.generation++;
            state.submitSeq++;
            state.submitBusy = false;
            invalidateSchema('');
            setResultLink('', '');
            setStatus('This profile changed. Reselect it to start a workflow.', 'error');
            syncRepoOptions();
            // A removed profile/repo never dispatches through stale selectors, and
            // controls aborted mid-POST stay usable; Start waits for fresh inputs.
            setControlsEnabled(true);
            const start = $('dispatch-start');
            if (start) start.disabled = true;
        }

        // Target changes invalidate old fields/schema and abort outstanding reads.
        // Ref invalidates on every keystroke without network traffic per keystroke.
        const refChanged = () => { state.generation++; invalidateSchema('Ref changed. Load inputs for this ref.'); };
        document.getElementById('dispatch-profile')?.addEventListener('change', () => { syncRepoOptions(); const ref = $('dispatch-ref'); if (ref) ref.value = ''; void loadReposAndWorkflows(); });
        document.getElementById('dispatch-repo')?.addEventListener('change', () => { const ref = $('dispatch-ref'); if (ref) ref.value = ''; void loadReposAndWorkflows(); });
        document.getElementById('dispatch-workflow')?.addEventListener('change', () => { void loadSchema(); });
        document.getElementById('dispatch-load')?.addEventListener('click', () => { void loadSchema(); });
        document.getElementById('dispatch-ref')?.addEventListener('input', refChanged);
        document.getElementById('dispatch-ref')?.addEventListener('change', refChanged);
        // One delegated listener keeps growth local: no per-keystroke reads or network.
        document.getElementById('dispatch-inputs')?.addEventListener('input', (event) => { fitTextarea(event?.target); });
        // Narrowing the window re-wraps open fields; unchanged text and width keep a manual resize.
        document.defaultView?.addEventListener?.('resize', () => fitTextareas());
        document.getElementById('dispatch-form')?.addEventListener('submit', (event) => { void submit(event); });
        document.getElementById('dispatch-close')?.addEventListener('click', () => close());
        // closedby="any" needs Chrome 134; backdrop clicks only count when press and release are both outside the box (padding/scrollbar clicks also target the dialog).
        const dialogEl = document.getElementById('dispatch-dialog');
        const outsideBox = (event) => {
            const r = dialogEl.getBoundingClientRect();
            return event.target === dialogEl && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom);
        };
        let pressedOutside = false;
        dialogEl?.addEventListener('pointerdown', (event) => { pressedOutside = outsideBox(event); });
        dialogEl?.addEventListener('click', (event) => {
            const wasOutside = pressedOutside;
            pressedOutside = false;
            if (wasOutside && outsideBox(event)) close();
        });
        // Escape stops the lifetime synchronously; close only acts while still closed.
        document.getElementById('dispatch-dialog')?.addEventListener('cancel', () => { noteClosed(); });
        document.getElementById('dispatch-dialog')?.addEventListener('close', () => {
            if ($('dispatch-dialog')?.open) return;
            noteClosed();
        });



        return { open, close, handleHidden, handleProfileChange, _state: state };
    }

    return { createDispatchController, safeGitHubUrl };
});
