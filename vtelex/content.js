// Rewrites the word before the caret as telex keys arrive, and expands shortcuts when a word ends,
// in text inputs, textareas and rich editors.
(() => {
    'use strict';
    const { convert, step } = globalThis.vtelex;
    const { DEFAULT_MACROS, parseMacros, expand } = globalThis.vtelexMacros;
    const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url']);
    const WORD_RE = /\p{L}+$/u;
    const MAX_WORD = 16;
    // Keys that end a word and trigger shortcut expansion.
    const BOUNDARY_RE = /^(?:Enter|[\s\p{P}])$/u;
    const ENABLED = 'enabled';
    const MACROS = 'macros';
    const sessions = new WeakMap();
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

    chrome.storage.local.get([ENABLED, MACROS], (r) => {
        enabled = !!r[ENABLED];
        setMacros(r[MACROS]);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[ENABLED]) enabled = !!changes[ENABLED].newValue;
        if (changes[MACROS]) setMacros(changes[MACROS].newValue);
    });

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

    // Rewrites word into out, touching only the chars after their common prefix.
    function replaceWord(ctx, word, out) {
        let same = 0;
        while (same < word.length && word[same] === out[same]) same++;
        ctx.replace(word.length - same, out.slice(same));
    }

    function onKeyDown(e) {
        if (!enabled || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
        const isLetter = /^[a-z]$/i.test(e.key);
        if (!isLetter && !BOUNDARY_RE.test(e.key)) return;
        const target = e.composedPath()[0];
        if (!(target instanceof Element)) return;
        const ctx = caretContext(target);
        if (!ctx) return;
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
                replaceWord(ctx, word, text);
                return;
            }
            e.preventDefault();
            replaceWord(ctx, word, text + e.key);
            return;
        }

        const state = step(session, word, e.key, { keep: keepShortcut });
        sessions.set(target, state);
        // A plain append is left to the browser so editors see an ordinary keystroke.
        if (state.out === word + e.key) return;
        e.preventDefault();
        replaceWord(ctx, word, state.out);
    }

    window.addEventListener('keydown', onKeyDown, true);
})();
