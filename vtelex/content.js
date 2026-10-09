// Rewrites the word before the caret as telex keys arrive, and expands shortcuts when a word ends,
// in text inputs, textareas and rich editors. VI/EN is remembered per site (the top frame's host).
(() => {
    'use strict';
    const { convert, step } = globalThis.vtelex;
    const { DEFAULT_MACROS, parseMacros, expand } = globalThis.vtelexMacros;
    const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url']);
    const WORD_RE = /\p{L}+$/u;
    const MAX_WORD = 16;
    // Keys that end a word and trigger shortcut expansion.
    const BOUNDARY_RE = /^(?:Enter|[\s\p{P}])$/u;
    const SITES = 'sites';
    const MACROS = 'macros';
    const IS_TOP = window === window.top;
    const SITE = topHost();
    const sessions = new WeakMap();
    // The last shortcut expansion per field, which a Backspace right after it undoes.
    const undos = new WeakMap();
    let enabled = false;
    let macros;
    // Lowercased starts of shortcuts with marks ("đ", "đc"): telex shows them instead of restoring the keys.
    let shortcutStarts;
    function setMacros(text) {
        macros = parseMacros(text ?? DEFAULT_MACROS);
        shortcutStarts = new Set([...macros.keys()].filter((k) => /[^\x00-\x7f]/.test(k))
            .flatMap((k) => [...k].map((_, i) => k.slice(0, i + 1))));
    }
    const keepShortcut = (out) => shortcutStarts.has(out.toLowerCase());
    setMacros();

    // Frames, including about:blank ones, follow the mode of the page they sit in.
    function topHost() {
        const origins = location.ancestorOrigins;
        try {
            return origins && origins.length ? new URL(origins[origins.length - 1]).hostname : location.hostname;
        } catch {
            return location.hostname;
        }
    }

    function setEnabled(sites) {
        enabled = !!(sites && sites[SITE]);
        if (!IS_TOP) return;
        try {
            chrome.runtime.sendMessage({ type: 'state', enabled }).catch(() => {});
        } catch {
            // The extension was reloaded; this old script is orphaned.
        }
    }

    chrome.storage.local.get([SITES, MACROS], (r) => {
        setEnabled(r[SITES]);
        setMacros(r[MACROS]);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[SITES]) setEnabled(changes[SITES].newValue);
        if (changes[MACROS]) setMacros(changes[MACROS].newValue);
    });

    // Briefly shows the new mode in the page corner; a closed shadow root keeps page CSS out.
    let toastHost = null;
    function toast(on) {
        if (toastHost) toastHost.remove();
        const host = document.createElement('div');
        const label = document.createElement('div');
        label.textContent = on ? 'VI' : 'EN';
        Object.assign(label.style, {
            position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647', padding: '6px 14px',
            borderRadius: '6px', font: '600 15px system-ui, sans-serif', color: '#fff',
            background: on ? '#c62828' : '#616161', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
            pointerEvents: 'none', transition: 'opacity 0.3s',
        });
        host.attachShadow({ mode: 'closed' }).append(label);
        (document.body || document.documentElement).append(host);
        toastHost = host;
        setTimeout(() => { label.style.opacity = '0'; }, 800);
        setTimeout(() => { host.remove(); if (toastHost === host) toastHost = null; }, 1200);
    }

    if (IS_TOP) {
        chrome.runtime.onMessage.addListener((msg) => {
            if (msg.type !== 'toggle') return;
            chrome.storage.local.get(SITES, (r) => {
                const sites = r[SITES] || {};
                const on = !sites[SITE];
                if (on) sites[SITE] = true;
                else delete sites[SITE];
                chrome.storage.local.set({ [SITES]: sites });
                toast(on);
            });
        });
    }

    // Returns the text before the caret and a way to replace its last n chars, or null when not editable here.
    function caretContext(target) {
        const isField = target instanceof HTMLTextAreaElement
              || (target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type));
        if (isField) {
            const caret = target.selectionStart;
            if (caret === null || caret !== target.selectionEnd) return null;
            return {
                before: target.value.slice(0, caret),
                replace(n, text) {
                    target.setSelectionRange(caret - n, caret);
                    if (!document.execCommand('insertText', false, text)) {
                        target.setRangeText(text, caret - n, caret, 'end');
                        target.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                },
            };
        }
        if (!target.isContentEditable) return null;
        const sel = document.getSelection();
        if (!sel || !sel.isCollapsed || !sel.anchorNode) return null;
        const node = sel.anchorNode;
        const offset = sel.anchorOffset;
        const isText = node.nodeType === Node.TEXT_NODE;
        return {
            before: isText ? node.data.slice(0, offset) : '',
            // Slate and CKEditor take text only from beforeinput, which execCommand never fires; others take execCommand.
            replace(n, text) {
                const span = { startContainer: node, startOffset: offset - n, endContainer: node, endOffset: offset };
                const range = document.createRange();
                range.setStart(node, offset - n);
                range.setEnd(node, offset);
                sel.removeAllRanges();
                sel.addRange(range);
                const handled = !(isText ? node.parentElement : node).dispatchEvent(new InputEvent('beforeinput', {
                    inputType: 'insertText', data: text, bubbles: true, cancelable: true, composed: true,
                    targetRanges: [new StaticRange(span)],
                }));
                if (!handled) document.execCommand('insertText', false, text);
            },
        };
    }

    // Rewrites the text before the caret from tail into out, touching only the chars after their common prefix.
    function replaceTail(ctx, tail, out) {
        let same = 0;
        while (same < tail.length && tail[same] === out[same]) same++;
        ctx.replace(tail.length - same, out.slice(same));
    }

    function onKeyDown(e) {
        const target = e.composedPath()[0];
        if (!(target instanceof Element)) return;
        // Any key other than this Backspace forgets the expansion it could undo.
        const undo = undos.get(target);
        undos.delete(target);
        if (!enabled || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
        const isLetter = /^[a-z]$/i.test(e.key);
        const isBackspace = e.key === 'Backspace';
        if (!isLetter && !isBackspace && !BOUNDARY_RE.test(e.key)) return;
        const ctx = caretContext(target);
        if (!ctx) return;

        if (isBackspace) {
            // Rich editors store a trailing space as a non-breaking one.
            if (undo && ctx.before.replace(/\u00a0/g, ' ').endsWith(undo.to)) {
                e.preventDefault();
                sessions.delete(target);
                replaceTail(ctx, undo.to, undo.from);
            }
            return;
        }
        const match = WORD_RE.exec(ctx.before);
        const word = match ? match[0] : '';
        if (word.length > MAX_WORD) return;
        const session = sessions.get(target);

        if (!isLetter) {
            sessions.delete(target);
            // Match the keys as typed first, so a shortcut like "as" wins over telex's "á";
            // their telex form catches "ddc" for "đc", which telex restored as not Vietnamese.
            const typed = session && session.out === word ? session.raw : word;
            const text = word && [typed, word, convert(typed)].map((t) => expand(macros, t)).find(Boolean);
            if (!text) return;
            // Enter must still reach the page (it sends the message), so only the word is rewritten.
            if (e.key === 'Enter') {
                replaceTail(ctx, word, text);
                return;
            }
            e.preventDefault();
            replaceTail(ctx, word, text + e.key);
            undos.set(target, { from: word + e.key, to: text + e.key });
            return;
        }

        const state = step(session, word, e.key, { keep: keepShortcut });
        sessions.set(target, state);
        // A plain append is left to the browser so editors see an ordinary keystroke.
        if (state.out === word + e.key) return;
        e.preventDefault();
        replaceTail(ctx, word, state.out);
    }

    window.addEventListener('keydown', onKeyDown, true);
})();
