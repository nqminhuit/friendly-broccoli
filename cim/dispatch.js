(function (root, factory) {
    const dispatch = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = dispatch;
    root.CimDispatch = dispatch;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const WORKFLOW_PAGE_SIZE = 100;

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
        const state = { generation: 0, listController: null, fileController: null, repoController: null, submitBusy: false, uncertainKey: '', workflows: [], workflowsTruncated: false, target: null };
        const Schema = globalThis.CimWorkflowSchema || null;

        function profiles() { try { return getProfiles() || []; } catch { return []; } }

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
            state.generation++;
            try { state.fileController?.abort(); } catch { /* Stale schema reads never restore. */ }
            state.fileController = null;
            const box = $('dispatch-inputs');
            if (box) box.replaceChildren();
            const meta = $('dispatch-schema-note');
            if (meta) { meta.textContent = message || ''; meta.hidden = !message; }
            const start = $('dispatch-start');
            if (start) start.disabled = true;
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
            const selection = currentSelection();
            const profile = profiles().find((item) => item.id === selection.profileId);
            if (!profile) { setStatus('Add a connection profile with a token to start a workflow.', 'error'); invalidateSchema(''); return; }
            abortReads();
            invalidateSchema('');
            const generation = ++state.generation;
            setStatus('', '');
            setResultLink('', '');
            const workflowSelect = $('dispatch-workflow');
            if (workflowSelect) { workflowSelect.replaceChildren(new Option('Loading workflows…', '')); workflowSelect.disabled = true; }
            const entry = getClientEntry(selection.profileId);
            if (!entry) { setStatus('This profile lost its token. Reopen after saving a token.', 'error'); return; }
            const captured = { profileId: selection.profileId, token: entry.token, repo: selection.repo || profile.repos[0] || '' };
            if (repoSelectValue() !== captured.repo && profile.repos.includes(captured.repo)) { /* keep */ }
            // Default branch + workflow listing use the owning profile client gates.
            const repoController = new AbortController();
            state.repoController = repoController;
            let defaultBranch = '';
            if (captured.repo && captured.repo.includes('/')) {
                const [owner, name] = captured.repo.split('/');
                try {
                    const repo = await entry.client.getRepo(owner, name, { signal: repoController.signal });
                    if (generation !== state.generation || getClientEntry(captured.profileId) !== entry) return;
                    if (typeof repo?.default_branch === 'string' && repo.default_branch) defaultBranch = repo.default_branch;
                } catch (error) {
                    if (generation !== state.generation) return;
                    // Contents/write failures must not suspend run monitoring; show form-only error.
                    if (error?.kind !== 'cancelled') setStatus(`Could not read ${captured.repo}: ${error.message || 'request failed.'}`, 'error');
                }
            }
            if (generation !== state.generation || getClientEntry(captured.profileId) !== entry) return;
            const refInput = $('dispatch-ref');
            if (refInput && !refInput.value.trim() && defaultBranch) refInput.value = defaultBranch;
            if (refInput) refInput.placeholder = defaultBranch || 'main';
            await loadWorkflows(captured, entry, generation);
        }

        function repoSelectValue() { return $('dispatch-repo')?.value || ''; }

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
            let url = null;
            try {
                do {
                    const page = await entry.client.listWorkflows(owner, name, url ? { url, signal: listController.signal } : { signal: listController.signal });
                    if (generation !== state.generation || getClientEntry(captured.profileId) !== entry) return;
                    for (const item of page.workflows) {
                        if (item && (typeof item.id === 'number' || typeof item.id === 'string') && !workflows.has(String(item.id))) workflows.set(String(item.id), item);
                        if (workflows.size >= 500) break;
                    }
                    url = page.links?.next || null;
                    // Never assume the first page holds the target workflow.
                    if (workflows.size >= 500) { state.workflowsTruncated = true; break; }
                } while (url);
            } catch (error) {
                if (generation !== state.generation) return;
                if (error?.kind === 'cancelled') return;
                setStatus(`Could not list workflows: ${error.message || 'request failed.'}`, 'error');
                if (workflowSelect) { workflowSelect.replaceChildren(new Option('Workflows unavailable', '')); workflowSelect.disabled = true; }
                return;
            } finally {
                if (state.listController === listController) state.listController = null;
            }
            if (generation !== state.generation || getClientEntry(captured.profileId) !== entry) return;
            state.workflows = [...workflows.values()];
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
            const selection = currentSelection();
            const profile = profiles().find((item) => item.id === selection.profileId);
            const entry = selection.profileId ? getClientEntry(selection.profileId) : null;
            const workflowOption = $('dispatch-workflow')?.selectedOptions[0];
            const workflowPath = workflowOption?.dataset.path || '';
            const workflowState = workflowOption?.dataset.state || 'active';
            invalidateSchema('');
            if (!profile || !entry || !selection.repo || !selection.workflowId || !selection.ref) {
                invalidateSchema(!selection.ref ? 'Enter a branch or tag ref, then load inputs.' : '');
                return;
            }
            if (workflowState !== 'active') { invalidateSchema('This workflow is disabled and cannot be started.'); return; }
            if (workflowPath && !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(workflowPath)) { invalidateSchema('This workflow file path is unsupported.'); return; }
            const generation = ++state.generation;
            try { state.fileController?.abort(); } catch { /* Replace outstanding reads. */ }
            const fileController = new AbortController();
            state.fileController = fileController;
            setStatus('Loading workflow inputs…', '');
            const captured = { profileId: selection.profileId, token: entry.token, repo: selection.repo, workflowId: selection.workflowId, workflowPath, ref: selection.ref };
            state.target = captured;
            const [owner, name] = captured.repo.split('/');
            try {
                const file = await entry.client.getWorkflowFile(owner, name, captured.workflowPath || captured.workflowId, captured.ref, { signal: fileController.signal });
                if (generation !== state.generation || getClientEntry(captured.profileId) !== entry || entry.token !== captured.token) return;
                if (!Schema) throw new Error('Workflow parser is unavailable.');
                const parsed = Schema.parseWorkflowYaml(file.text);
                if (generation !== state.generation) return;
                // Stale YAML must never restore another workflow/ref/account form.
                const now = currentSelection();
                if (now.profileId !== captured.profileId || now.repo !== captured.repo || now.workflowId !== captured.workflowId || now.ref !== captured.ref) return;
                if (!parsed.dispatchable) { invalidateSchema(parsed.reason); setStatus(parsed.reason, 'error'); return; }
                renderInputs(parsed.inputs, captured);
                setStatus(parsed.inputs.length ? `Loaded ${parsed.inputs.length} input${parsed.inputs.length === 1 ? '' : 's'} from ${captured.ref}.` : `This workflow takes no inputs on ${captured.ref}. Review and start.`, 'success');
                const start = $('dispatch-start');
                if (start) start.disabled = false;
            } catch (error) {
                if (generation !== state.generation) return;
                if (error?.kind === 'cancelled') return;
                if (getClientEntry(captured.profileId) !== entry) return;
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
            const box = $('dispatch-inputs');
            if (!box) return;
            box.replaceChildren();
            const note = $('dispatch-schema-note');
            if (note) { note.textContent = `Inputs reflect ${captured.workflowPath || captured.workflowId} at ref ${captured.ref}.`; note.hidden = false; }
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
                    // String/environment preserve whitespace/UTF-8/multiline exactly.
                    const hasMultiline = typeof input.default === 'string' && input.default.includes('\n');
                    const field = document.createElement(hasMultiline ? 'textarea' : 'input');
                    if (!hasMultiline) field.type = 'text';
                    field.name = input.name;
                    field.setAttribute('aria-label', input.name);
                    field.maxLength = 10000;
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
            if (state.submitBusy) return;
            const selection = currentSelection();
            const profile = profiles().find((item) => item.id === selection.profileId);
            const entry = selection.profileId ? getClientEntry(selection.profileId) : null;
            if (!profile || !entry) { setStatus('Select a connection profile with a token first.', 'error'); return; }
            const workflowOption = $('dispatch-workflow')?.selectedOptions[0];
            const workflowName = workflowOption ? workflowOption.textContent : selection.workflowId;
            const workflowPath = workflowOption?.dataset.path || selection.workflowId;
            if (!selection.repo || !selection.workflowId || !selection.ref) { setStatus('Choose a repository, workflow, and ref before starting.', 'error'); return; }
            // Repeat identical uncertain dispatches stay gated until explicit acknowledgement.
            const values = readFormValues();
            if (!Schema) { setStatus('Workflow parser is unavailable.', 'error'); return; }
            if (!state.target || state.target.profileId !== selection.profileId || state.target.repo !== selection.repo || state.target.workflowId !== selection.workflowId || state.target.ref !== selection.ref) { setStatus('Load inputs for this workflow and ref first.', 'error'); return; }
            const effective = Array.isArray(state.target.inputsSchema) ? state.target.inputsSchema : [];
            const checked = Schema.validateDispatchValues(effective, values);
            showFieldErrors(checked.errors);
            if (!checked.ok) { setStatus('Fix the highlighted inputs before starting.', 'error'); return; }
            if (Schema.isPayloadTooLarge(selection.ref, checked.inputs)) { setStatus('Workflow inputs exceed the 65535 character payload limit.', 'error'); return; }
            const gateKey = `${selection.profileId}|${selection.repo}|${selection.workflowId}|${selection.ref}|${JSON.stringify(checked.inputs)}`;
            if (state.uncertainKey && state.uncertainKey === gateKey) { setStatus('This exact request is uncertain. Check GitHub, then acknowledge to allow another request.', 'error'); return; }
            const warning = `Start workflow?\n\n${profile.name} · ${selection.repo}\n${workflowName} · ref ${selection.ref}\n\nGitHub runs use this profile’s workflow privileges and may incur Actions usage charges.`;
            if (!globalThis.confirm(warning)) return;
            // Capture immutable target+PAT for submission; recheck ownership before sending.
            const captured = { profileId: profile.id, token: profile.token, repo: selection.repo, workflowId: selection.workflowId, workflowPath, ref: selection.ref, inputs: checked.inputs, workflowName };
            const owned = () => getClientEntry(captured.profileId) === entry && entry.token === captured.token && entry.token === profile.token;
            if (!owned()) { setStatus('The selected profile changed. Reload before starting.', 'error'); return; }
            state.submitBusy = true;
            const start = $('dispatch-start');
            if (start) start.disabled = true;
            setStatus('Starting workflow…', '');
            setResultLink('', '');
            const [owner, name] = captured.repo.split('/');
            try {
                const outcome = await entry.client.dispatchWorkflow(owner, name, captured.workflowId, { ref: captured.ref, inputs: captured.inputs, signal: submitSignal() });
                if (!owned()) { setStatus('The selected profile changed during the request. Check GitHub for this workflow.', 'error'); return; }
                state.uncertainKey = '';
                setStatus(`Workflow requested. Monitoring run ${outcome.runId}.`, 'success');
                setResultLink(`Open run ${outcome.runId} on GitHub ↗`, outcome.htmlUrl);
                try { await onDispatched?.({ profileId: captured.profileId, repo: captured.repo, runId: outcome.runId, token: captured.token, htmlUrl: outcome.htmlUrl }); } catch { /* Pinning never blocks the result link. */ }
            } catch (error) {
                if (!owned()) { setStatus('The selected profile changed. Check GitHub before retrying.', 'error'); return; }
                if (error?.ambiguous) {
                    state.uncertainKey = gateKey;
                    // Ambiguous dispatch has no known run ID: link the workflow page, never newest row.
                    const repoUrl = `https://github.com/${captured.repo}/actions/workflows/${encodeURIComponent(String(captured.workflowPath || captured.workflowId).split('/').pop())}`;
                    setStatus('Request may have been accepted; check GitHub before retrying.', 'error');
                    setResultLink('Open workflow on GitHub to verify ↗', repoUrl);
                    renderAcknowledge();
                } else if (error?.kind !== 'cancelled') {
                    setStatus(error.message || 'Could not start the workflow.', 'error');
                } else {
                    // Queued POST cancelled before send leaves no request and no gate.
                    setStatus('Start was cancelled before GitHub received it. Review and try again.', 'error');
                }
            } finally {
                state.submitBusy = false;
                if (start && !state.uncertainKey) start.disabled = false;
            }
        }

        let submitController = null;
        function submitSignal() {
            try { submitController?.abort(); } catch { /* Replace prior submit. */ }
            submitController = new AbortController();
            return submitController.signal;
        }



        function renderAcknowledge() {
            const box = $('dispatch-result');
            if (!box) return;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'button quiet';
            button.textContent = 'I checked GitHub; allow another request';
            button.addEventListener('click', () => { state.uncertainKey = ''; setStatus('', ''); const start = $('dispatch-start'); if (start) start.disabled = false; button.remove(); });
            box.append(button);
            const start = $('dispatch-start');
            if (start) start.disabled = true;
        }

        function open() {
            const dialog = $('dispatch-dialog');
            if (!dialog) return;
            syncRepoOptions();
            if (!$('dispatch-ref')?.value) { /* default branch fills on load */ }
            if (!dialog.open) { dialog.showModal(); const first = $('dispatch-profile'); first?.focus({ preventScroll: true }); }
            void loadReposAndWorkflows();
        }

        function close() {
            abortReads();
            try { submitController?.abort(); } catch { /* Closing never declares the workflow stopped. */ }
            state.generation++;
            state.submitBusy = false;
            const dialog = $('dispatch-dialog');
            if (dialog?.open) dialog.close();
            $('new-run')?.focus({ preventScroll: true });
        }

        function handleHidden() {
            // Reads abort on hide; a sent POST abort stays uncertain via owned catch above.
            abortReads();
            try { submitController?.abort(); } catch { /* Uncertain POSTs gate until acknowledged. */ }
        }

        function handleProfileChange(profileId) {
            // Drop only the changed target's private form info; other targets stay usable.
            const selection = currentSelection();
            if (selection.profileId !== profileId) return;
            abortReads();
            try { submitController?.abort(); } catch { /* Credential-owned POSTs resolve separately. */ }
            state.generation++;
            state.uncertainKey = '';
            state.target = null;
            invalidateSchema('');
            setStatus('This profile changed. Reselect it to start a workflow.', 'error');
            syncRepoOptions();
        }

        // Target changes invalidate old fields/schema and abort outstanding reads.
        document.getElementById('dispatch-profile')?.addEventListener('change', () => { syncRepoOptions(); const ref = $('dispatch-ref'); if (ref) ref.value = ''; void loadReposAndWorkflows(); });
        document.getElementById('dispatch-repo')?.addEventListener('change', () => { const ref = $('dispatch-ref'); if (ref) ref.value = ''; void loadReposAndWorkflows(); });
        document.getElementById('dispatch-workflow')?.addEventListener('change', () => { void loadSchema(); });
        document.getElementById('dispatch-load')?.addEventListener('click', () => { void loadSchema(); });
        document.getElementById('dispatch-ref')?.addEventListener('change', () => { invalidateSchema('Ref changed. Load inputs for this ref.'); const start = $('dispatch-start'); if (start) start.disabled = true; });
        document.getElementById('dispatch-form')?.addEventListener('submit', (event) => { void submit(event); });
        document.getElementById('dispatch-close')?.addEventListener('click', () => close());
        document.getElementById('dispatch-dialog')?.addEventListener('close', () => { abortReads(); state.generation++; });



        return { open, close, handleHidden, handleProfileChange, _state: state };
    }

    return { createDispatchController, safeGitHubUrl };
});
