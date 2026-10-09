// Shows a FIM suggestion as grey ghost text after a typing pause, on sites switched on, in textareas and in
// rich editors (contenteditable). Tab accepts it, Ctrl+Right accepts a word, Esc dismisses, typing its next
// characters shrinks it.
(() => {
    'use strict';
    const { buildContext, postprocess, nextWord } = globalThis.bcoinInfill;
    const SITES = 'sites';
    const SETTINGS = 'settings';
    const DEBOUNCE_MS = 300;
    const BACKOFF_MS = 10000;
    const CACHE_SIZE = 100;
    const WATCH_MS = 200;
    const IS_TOP = window === window.top;
    const SITE = topHost();
    const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
    // Code editors draw their own text and have their own completion.
    const CODE_EDITORS = '.monaco-editor, .cm-editor, .CodeMirror, .ace_editor';
    const BLOCK_RE = /^(?:ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TR|UL)$/;
    const cache = new Map();
    let enabled = false;
    let timer = null;
    let seq = 0;
    let backoffUntil = 0;
    // The visible suggestion: its field, the text before and after the caret when shown, and the remaining text.
    let ghost = null;
    let overlay = null;
    let watcher = null;
    // Rich editors such as CKEditor 5 apply some typing themselves, without an input event, so their DOM is watched.
    let observed = null;
    let debug = false;
    // With the Page context option, the visible page text above the field goes along as extra context.
    let pageContext = false;
    const PAGE_CONTEXT_CHARS = 4000;
    const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION']);

    // With the Debug option, explains in the page console why a suggestion did or did not show.
    const log = (...args) => { if (debug) console.info('[bcoin]', ...args); };

    function topHost() {
        const origins = location.ancestorOrigins;
        try {
            return origins && origins.length ? new URL(origins[origins.length - 1]).hostname : location.hostname;
        } catch {
            return location.hostname;
        }
    }

    function report() {
        if (!IS_TOP) return;
        try {
            chrome.runtime.sendMessage({ type: 'state', enabled }).catch(() => {});
        } catch {
            // The extension was reloaded; this old script is orphaned.
        }
    }

    function setEnabled(sites) {
        enabled = !!(sites && sites[SITE]);
        if (!enabled) clear();
        report();
    }

    function applySettings(settings) {
        debug = !!(settings && settings.debug);
        pageContext = !!(settings && settings.pageContext);
    }

    chrome.storage.local.get([SITES, SETTINGS], (r) => {
        setEnabled(r[SITES]);
        applySettings(r[SETTINGS]);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[SITES]) setEnabled(changes[SITES].newValue);
        if (changes[SETTINGS]) applySettings(changes[SETTINGS].newValue);
    });

    let toastHost = null;
    function toast(on) {
        if (toastHost) toastHost.remove();
        const host = document.createElement('div');
        const label = document.createElement('div');
        label.textContent = on ? 'bcoin on' : 'bcoin off';
        Object.assign(label.style, {
            position: 'fixed', right: '16px', bottom: '56px', zIndex: '2147483647', padding: '6px 14px',
            borderRadius: '6px', font: '600 15px system-ui, sans-serif', color: '#fff',
            background: on ? '#2e7d32' : '#616161', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
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

    // An open @mention or #issue list owns Tab, so no ghost then.
    function autocompleteOpen(el) {
        if (el.getAttribute('aria-expanded') === 'true' || el.getAttribute('aria-activedescendant')) return true;
        const ids = `${el.getAttribute('aria-controls') || ''} ${el.getAttribute('aria-owns') || ''}`.split(/\s+/).filter(Boolean);
        const lists = ids.map((id) => document.getElementById(id));
        const expander = el.closest('text-expander');
        if (expander) lists.push(expander.querySelector('[role="listbox"]'));
        return lists.some((l) => l && l.getClientRects().length > 0);
    }

    // The ghost's overlay: a host with an open shadow root (the tests read it) holding a fixed, click-through box.
    function overlayBox() {
        if (!overlay) {
            const host = document.createElement('div');
            host.setAttribute('data-bcoin', 'ghost');
            const box = document.createElement('div');
            host.attachShadow({ mode: 'open' }).append(box);
            document.documentElement.append(host);
            overlay = { host, box };
        }
        Object.assign(overlay.box.style, { position: 'fixed', pointerEvents: 'none', zIndex: '2147483647', margin: '0' });
        return overlay.box;
    }

    const MIRRORED = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch', 'lineHeight',
                      'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'tabSize', 'textAlign', 'direction',
                      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth',
                      'borderBottomWidth', 'borderLeftWidth', 'whiteSpace', 'overflowWrap', 'wordBreak', 'boxSizing'];

    // A <textarea>: the text is its value, and the ghost is drawn in an invisible copy of the field laid over it,
    // so it wraps the same way.
    function textareaField(el) {
        return {
            el,
            multiline: true,
            read() {
                const c = el.selectionStart;
                if (c === null || c !== el.selectionEnd) return null;
                return { before: el.value.slice(0, c), after: el.value.slice(c) };
            },
            insert(text) {
                if (!document.execCommand('insertText', false, text)) {
                    el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
                    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
                }
            },
            draw(g) {
                const box = overlayBox();
                const cs = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                const borders = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
                const scrollbar = Math.max(0, el.offsetWidth - el.clientWidth - borders);
                Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, overflow: 'hidden' });
                const mirror = document.createElement('div');
                const m = mirror.style;
                for (const p of MIRRORED) m[p] = cs[p];
                Object.assign(m, {
                    position: 'absolute', left: `${-el.scrollLeft}px`, top: `${-el.scrollTop}px`, width: `${r.width}px`,
                    boxSizing: 'border-box', borderStyle: 'solid', borderColor: 'transparent', color: 'transparent',
                    paddingRight: `${parseFloat(cs.paddingRight) + scrollbar}px`, margin: '0',
                });
                if (cs.whiteSpace !== 'pre') m.whiteSpace = 'pre-wrap';
                const text = document.createElement('span');
                text.setAttribute('data-ghost', '');
                text.textContent = g.text;
                Object.assign(text.style, { color: cs.color, opacity: '0.45' });
                mirror.append(g.before, text, g.after);
                box.replaceChildren(mirror);
            },
        };
    }

    // The text of a DOM fragment, with a newline for <br> and between blocks. Nbsp becomes a space, and invisible
    // format characters (zero-width spaces, CKEditor's word-joiner fillers) are dropped, since editors add and
    // remove them while idle.
    function fragmentText(frag) {
        let s = '';
        let pendingBreak = false;
        const emit = (t) => {
            if (pendingBreak && s && !s.endsWith('\n')) s += '\n';
            pendingBreak = false;
            s += t;
        };
        const walk = (n) => {
            if (n.nodeType === Node.TEXT_NODE) {
                const t = n.data.replace(/\u00a0/g, ' ').replace(/\p{Cf}/gu, '');
                if (t) emit(t);
            } else if (n.nodeName === 'BR') {
                emit('\n');
            } else if (n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
                const block = BLOCK_RE.test(n.nodeName);
                if (block) pendingBreak = true;
                for (const c of n.childNodes) walk(c);
                if (block) pendingBreak = true;
            }
        };
        walk(frag);
        return s;
    }

    // A contenteditable editor: the text comes from the DOM around the selection, and the ghost is one line
    // drawn at the caret, since chat editors send on Enter.
    function richField(host) {
        const caretRange = () => {
            const sel = document.getSelection();
            if (!sel || !sel.rangeCount || !sel.isCollapsed || !host.contains(sel.anchorNode)) return null;
            return sel.getRangeAt(0);
        };
        return {
            el: host,
            multiline: false,
            read() {
                const caret = caretRange();
                if (!caret) return null;
                const head = document.createRange();
                head.selectNodeContents(host);
                head.setEnd(caret.startContainer, caret.startOffset);
                const tail = document.createRange();
                tail.selectNodeContents(host);
                tail.setStart(caret.startContainer, caret.startOffset);
                return { before: fragmentText(head.cloneContents()), after: fragmentText(tail.cloneContents()) };
            },
            // Slate and CKEditor take text only from beforeinput, which execCommand never fires; others take execCommand.
            insert(text) {
                const caret = caretRange();
                if (!caret) return;
                const target = caret.startContainer.nodeType === Node.TEXT_NODE ? caret.startContainer.parentElement : caret.startContainer;
                const handled = !target.dispatchEvent(new InputEvent('beforeinput', {
                    inputType: 'insertText', data: text, bubbles: true, cancelable: true, composed: true,
                    targetRanges: [new StaticRange({ startContainer: caret.startContainer, startOffset: caret.startOffset,
                                                     endContainer: caret.startContainer, endOffset: caret.startOffset })],
                }));
                if (!handled) document.execCommand('insertText', false, text);
            },
            draw(g) {
                const caret = caretRange();
                if (!caret) return;
                const node = caret.startContainer.nodeType === Node.TEXT_NODE ? caret.startContainer.parentElement : caret.startContainer;
                const cs = getComputedStyle(node);
                let rect = caret.getClientRects()[0];
                // An empty line has no caret rect, so use its block's content box.
                if (!rect || (!rect.width && !rect.height)) {
                    const r = node.getBoundingClientRect();
                    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
                    rect = { left: r.left + parseFloat(cs.paddingLeft), top: r.top + parseFloat(cs.paddingTop), height: lineHeight };
                }
                const hostRect = host.getBoundingClientRect();
                const box = overlayBox();
                Object.assign(box.style, {
                    left: `${rect.left}px`, top: `${rect.top}px`, height: `${rect.height}px`, lineHeight: `${rect.height}px`,
                    maxWidth: `${Math.max(0, hostRect.right - rect.left)}px`, overflow: 'hidden', whiteSpace: 'pre',
                    textOverflow: 'ellipsis', font: cs.font, letterSpacing: cs.letterSpacing, color: cs.color, opacity: '0.45',
                });
                const text = document.createElement('span');
                text.setAttribute('data-ghost', '');
                text.textContent = g.text;
                box.replaceChildren(text);
            },
        };
    }

    // The visible text before the field in reading order, its last PAGE_CONTEXT_CHARS characters: in a chat, the
    // latest messages above the box. Walks back from the field, so long pages cost no more than the cap.
    function pageText(field) {
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
        walker.currentNode = field;
        const parts = [];
        let length = 0;
        let lastBlock = null;
        for (let node = walker.previousNode(); node && length < PAGE_CONTEXT_CHARS; node = walker.previousNode()) {
            const parent = node.parentElement;
            if (!parent || SKIPPED_TAGS.has(parent.tagName) || parent.closest('[data-bcoin]')) continue;
            const text = node.data.replace(/\u00a0/g, ' ').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ');
            if (!text.trim() || !parent.checkVisibility()) continue;
            let block = parent;
            while (block.parentElement && !BLOCK_RE.test(block.tagName)) block = block.parentElement;
            parts.unshift(block === lastBlock ? text : text + '\n');
            lastBlock = block;
            length += text.length + 1;
        }
        const all = parts.join('').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
        return all.slice(-PAGE_CONTEXT_CHARS);
    }

    // The field the event target belongs to, or null where bcoin stays out (inputs, password fields, code editors).
    function fieldFor(el) {
        if (el instanceof HTMLTextAreaElement) return el.readOnly || el.disabled ? null : textareaField(el);
        if (!(el instanceof HTMLElement) || !el.isContentEditable || el.closest(CODE_EDITORS)) return null;
        let host = el;
        while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
        return richField(host);
    }

    function clear() {
        ghost = null;
        if (overlay) overlay.host.remove();
        overlay = null;
        clearInterval(watcher);
        watcher = null;
    }

    const lineOf = (after) => after.split('\n', 1)[0];

    // Same caret spot: same text before it and same rest of its line. Lines below may change (editors and pages
    // keep re-rendering them), since a suggestion depends only on what precedes the caret and where its line ends.
    const sameSpot = (a, b) => !!a && !!b && a.before === b.before && lineOf(a.after) === lineOf(b.after);

    // For the Debug log: where the text at the caret changed, with invisible characters escaped.
    function describeChange(a, b) {
        if (!b) return 'no caret in the field now';
        const inBefore = a.before !== b.before;
        const x = inBefore ? a.before : lineOf(a.after);
        const y = inBefore ? b.before : lineOf(b.after);
        let i = 0;
        while (i < x.length && x[i] === y[i]) i++;
        const show = (t) => JSON.stringify(t.slice(i, i + 16))
            .replace(/[^\x20-\x7e\u00c0-\u1ef9]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
        return `${inBefore ? 'text before the caret' : 'rest of the line'} changed at ${i}: ${show(x)} -> ${show(y)}`;
    }

    function snapshotHolds(g) {
        if (document.activeElement !== g.field.el && !g.field.el.contains(document.activeElement)) return false;
        return sameSpot(g.field.read(), g);
    }

    function show(field, text, at) {
        clear();
        ghost = { field, before: at.before, after: at.after, text };
        field.draw(ghost);
        // Pages can change the text without an input event, and fields move as they grow or scroll.
        watcher = setInterval(() => {
            if (!ghost || !snapshotHolds(ghost)) clear();
            else ghost.field.draw(ghost);
        }, WATCH_MS);
    }

    function remember(key, text) {
        cache.delete(key);
        cache.set(key, text);
        if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    }

    async function request(field) {
        if (!enabled) return;
        if (Date.now() < backoffUntil) return log('skip: backing off after a server error');
        if (autocompleteOpen(field.el)) return log('skip: an autocomplete list is open', field.el);
        const at = field.read();
        if (!at) return log('skip: no caret, or a selection, in the field');
        const ctx = buildContext(at.before + at.after, at.before.length);
        // The overlay cannot push text aside, so only suggest at the end of a line.
        if (/\S/.test(ctx.textAfter)) return log('skip: text after the caret on this line', JSON.stringify(ctx.textAfter));
        const extra = pageContext ? pageText(field.el) : '';
        const key = `${extra}\x1e${ctx.prefix}\x1e${ctx.middle}\x1e${ctx.suffix}`;
        let content = cache.get(key);
        if (content === undefined) {
            const mine = ++seq;
            log('request', { prompt: ctx.middle, prefixChars: ctx.prefix.length, suffixChars: ctx.suffix.length, pageChars: extra.length });
            let res;
            try {
                res = await chrome.runtime.sendMessage({
                    type: 'infill',
                    ctx: { prefix: ctx.prefix, middle: ctx.middle, suffix: ctx.suffix, nIndent: ctx.nIndent, extra },
                });
            } catch {
                return;
            }
            if (!res || res.aborted) return;
            if (res.error) {
                backoffUntil = Date.now() + BACKOFF_MS;
                return log('server error', res.error);
            }
            content = res.content;
            remember(key, content);
            log('answer', JSON.stringify(content));
            if (mine !== seq) return log('drop: a newer request replaced this one');
        }
        const now = field.read();
        if (!sameSpot(now, at)) return log('drop: the text changed meanwhile;', describeChange(at, now));
        let text = postprocess(content, ctx);
        if (text && !field.multiline) text = text.split('\n')[0];
        if (!text || !/\S/.test(text)) return log('drop: nothing left after clean-up');
        log('show', JSON.stringify(text));
        show(field, text, at);
    }

    // What the field held when the last request was scheduled, so a re-render that changes nothing at the caret
    // neither restarts the pause nor sends the same request again.
    let pending = null;

    function schedule(field, at) {
        pending = { el: field.el, at };
        clearTimeout(timer);
        timer = setTimeout(() => request(field), DEBOUNCE_MS);
    }

    // The field's text may have changed: shrink a ghost typed through, else clear it and ask again after a pause.
    function changed(field) {
        if (!enabled) return;
        const now = field.read();
        if (ghost && ghost.field.el === field.el) {
            const g = ghost;
            if (sameSpot(now, g)) return;
            const typed = now && lineOf(now.after) === lineOf(g.after) && now.before.startsWith(g.before)
                ? now.before.slice(g.before.length) : null;
            if (typed && g.text.startsWith(typed) && g.text.length > typed.length) {
                ghost = { ...g, before: now.before, after: now.after, text: g.text.slice(typed.length) };
                g.field.draw(ghost);
                return;
            }
        } else if (pending && pending.el === field.el && sameSpot(now, pending.at)) {
            return;
        }
        clear();
        schedule(field, now);
    }

    document.addEventListener('input', (e) => {
        const field = fieldFor(e.composedPath()[0]);
        if (field) changed(field);
    }, true);

    // Watches the focused rich editor, coalescing a burst of mutations into one check.
    function observe(field) {
        if (observed && observed.el === field.el) return;
        if (observed) observed.observer.disconnect();
        let queued = false;
        const observer = new MutationObserver(() => {
            if (queued) return;
            queued = true;
            queueMicrotask(() => {
                queued = false;
                if (document.activeElement === field.el || field.el.contains(document.activeElement)) changed(field);
            });
        });
        observer.observe(field.el, { childList: true, characterData: true, subtree: true });
        observed = { el: field.el, observer };
    }

    document.addEventListener('focusin', (e) => {
        const field = fieldFor(e.composedPath()[0]);
        if (field && !field.multiline) observe(field);
    }, true);

    window.addEventListener('keydown', (e) => {
        // A field focused before bcoin loaded or was switched on never saw focusin.
        if (enabled && !ghost) {
            const field = fieldFor(e.composedPath()[0]);
            if (field && !field.multiline) observe(field);
        }
        if (!ghost) return;
        const target = e.composedPath()[0];
        if (target !== ghost.field.el && !ghost.field.el.contains(target)) return;
        if (!snapshotHolds(ghost)) {
            clear();
            return;
        }
        const plain = !e.altKey && !e.metaKey && !e.shiftKey;
        let accept = null;
        if (e.key === 'Tab' && plain && !e.ctrlKey) {
            if (autocompleteOpen(ghost.field.el)) {
                clear();
                return;
            }
            accept = ghost.text;
        } else if (e.key === 'ArrowRight' && plain && e.ctrlKey) {
            accept = nextWord(ghost.text);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            clear();
            return;
        } else {
            if (NAV_KEYS.has(e.key)) clear();
            return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        // The input event then shrinks the ghost by what went in, or asks again after a full accept.
        ghost.field.insert(accept);
    }, true);

    for (const type of ['mousedown', 'focusout']) document.addEventListener(type, () => clear(), true);
    document.addEventListener('scroll', () => { if (ghost) ghost.field.draw(ghost); }, true);
    window.addEventListener('resize', () => clear());
})();
