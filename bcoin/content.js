// Shows a FIM suggestion as grey ghost text in textareas after a typing pause, on sites switched on.
// Tab accepts it, Ctrl+Right accepts a word, Esc dismisses, typing its next characters shrinks it.
(() => {
    'use strict';
    const { buildContext, postprocess, nextWord } = globalThis.bcoinInfill;
    const SITES = 'sites';
    const DEBOUNCE_MS = 300;
    const BACKOFF_MS = 10000;
    const CACHE_SIZE = 100;
    const WATCH_MS = 200;
    const IS_TOP = window === window.top;
    const SITE = topHost();
    const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
    const cache = new Map();
    let enabled = false;
    let timer = null;
    let seq = 0;
    let backoffUntil = 0;
    // The visible suggestion: the field, its value and caret when shown, and the remaining text.
    let ghost = null;
    let overlay = null;
    let watcher = null;

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

    chrome.storage.local.get(SITES, (r) => setEnabled(r[SITES]));
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[SITES]) setEnabled(changes[SITES].newValue);
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

    const isTextarea = (el) => el instanceof HTMLTextAreaElement && !el.readOnly && !el.disabled;

    // An open @mention or #issue list owns Tab, so no ghost then.
    function autocompleteOpen(el) {
        if (el.getAttribute('aria-expanded') === 'true' || el.getAttribute('aria-activedescendant')) return true;
        const ids = `${el.getAttribute('aria-controls') || ''} ${el.getAttribute('aria-owns') || ''}`.split(/\s+/).filter(Boolean);
        const lists = ids.map((id) => document.getElementById(id));
        const expander = el.closest('text-expander');
        if (expander) lists.push(expander.querySelector('[role="listbox"]'));
        return lists.some((l) => l && l.getClientRects().length > 0);
    }

    function clear() {
        ghost = null;
        if (overlay) overlay.host.remove();
        overlay = null;
        clearInterval(watcher);
        watcher = null;
    }

    function snapshotHolds(g) {
        const el = g.el;
        return document.activeElement === el && el.value === g.value
            && el.selectionStart === g.caret && el.selectionEnd === g.caret;
    }

    const MIRRORED = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch', 'lineHeight',
                      'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'tabSize', 'textAlign', 'direction',
                      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth',
                      'borderBottomWidth', 'borderLeftWidth', 'whiteSpace', 'overflowWrap', 'wordBreak', 'boxSizing'];

    // Draws the field's text, invisible, over the field with the ghost in grey at the caret, so it wraps alike.
    function render() {
        const el = ghost.el;
        if (!overlay) {
            const host = document.createElement('div');
            host.setAttribute('data-bcoin', 'ghost');
            const root = host.attachShadow({ mode: 'open' });
            const box = document.createElement('div');
            const mirror = document.createElement('div');
            const before = document.createElement('span');
            const text = document.createElement('span');
            const after = document.createElement('span');
            mirror.append(before, text, after);
            box.append(mirror);
            root.append(box);
            document.documentElement.append(host);
            overlay = { host, box, mirror, before, text, after };
        }
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const borders = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
        const scrollbar = Math.max(0, el.offsetWidth - el.clientWidth - borders);
        Object.assign(overlay.box.style, {
            position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
            overflow: 'hidden', pointerEvents: 'none', zIndex: '2147483647', margin: '0',
        });
        const m = overlay.mirror.style;
        for (const p of MIRRORED) m[p] = cs[p];
        Object.assign(m, {
            position: 'absolute', left: `${-el.scrollLeft}px`, top: `${-el.scrollTop}px`, width: `${r.width}px`,
            boxSizing: 'border-box', borderStyle: 'solid', borderColor: 'transparent', color: 'transparent',
            paddingRight: `${parseFloat(cs.paddingRight) + scrollbar}px`, margin: '0',
        });
        if (cs.whiteSpace !== 'pre') m.whiteSpace = 'pre-wrap';
        overlay.before.textContent = ghost.value.slice(0, ghost.caret);
        overlay.text.textContent = ghost.text;
        Object.assign(overlay.text.style, { color: cs.color, opacity: '0.45' });
        overlay.after.textContent = ghost.value.slice(ghost.caret);
    }

    function show(el, text) {
        clear();
        ghost = { el, value: el.value, caret: el.selectionStart, text };
        render();
        // Pages can change the value without an input event, and fields move as they grow or scroll.
        watcher = setInterval(() => {
            if (!ghost || !snapshotHolds(ghost)) clear();
            else render();
        }, WATCH_MS);
    }

    function remember(key, text) {
        cache.delete(key);
        cache.set(key, text);
        if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    }

    async function request(el) {
        if (!enabled || document.activeElement !== el || !isTextarea(el) || Date.now() < backoffUntil) return;
        const caret = el.selectionStart;
        if (caret !== el.selectionEnd || autocompleteOpen(el)) return;
        const ctx = buildContext(el.value, caret);
        // The overlay cannot push text aside, so only suggest at the end of a line.
        if (/\S/.test(ctx.textAfter)) return;
        const key = `${ctx.prefix}\x1e${ctx.middle}\x1e${ctx.suffix}`;
        const value = el.value;
        let content = cache.get(key);
        if (content === undefined) {
            const mine = ++seq;
            let res;
            try {
                res = await chrome.runtime.sendMessage({
                    type: 'infill',
                    ctx: { prefix: ctx.prefix, middle: ctx.middle, suffix: ctx.suffix, nIndent: ctx.nIndent },
                });
            } catch {
                return;
            }
            if (!res || res.aborted) return;
            if (res.error) {
                backoffUntil = Date.now() + BACKOFF_MS;
                return;
            }
            content = res.content;
            remember(key, content);
            if (mine !== seq) return;
        }
        if (document.activeElement !== el || el.value !== value || el.selectionStart !== caret || el.selectionEnd !== caret) return;
        const text = postprocess(content, ctx);
        if (text) show(el, text);
    }

    function schedule(el) {
        clearTimeout(timer);
        timer = setTimeout(() => request(el), DEBOUNCE_MS);
    }

    function insert(el, text) {
        el.focus();
        if (!document.execCommand('insertText', false, text)) {
            const at = el.selectionStart;
            el.setRangeText(text, at, el.selectionEnd, 'end');
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        }
    }

    document.addEventListener('input', (e) => {
        const el = e.composedPath()[0];
        if (!enabled || !isTextarea(el)) return;
        if (ghost && ghost.el === el) {
            const g = ghost;
            const caret = el.selectionStart;
            const typed = el.value.slice(g.caret, caret);
            const typedThrough = caret > g.caret && el.selectionEnd === caret
                && el.value.length - g.value.length === typed.length
                && el.value.slice(0, g.caret) === g.value.slice(0, g.caret)
                && el.value.slice(caret) === g.value.slice(g.caret)
                && g.text.startsWith(typed);
            if (typedThrough && g.text.length > typed.length) {
                ghost = { el, value: el.value, caret, text: g.text.slice(typed.length) };
                render();
                return;
            }
        }
        clear();
        schedule(el);
    }, true);

    window.addEventListener('keydown', (e) => {
        if (!ghost) return;
        const el = ghost.el;
        if (e.composedPath()[0] !== el) return;
        if (!snapshotHolds(ghost)) {
            clear();
            return;
        }
        const plain = !e.altKey && !e.metaKey && !e.shiftKey;
        let accept = null;
        if (e.key === 'Tab' && plain && !e.ctrlKey) {
            if (autocompleteOpen(el)) {
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
        insert(el, accept);
    }, true);

    for (const type of ['mousedown', 'focusout']) document.addEventListener(type, () => clear(), true);
    document.addEventListener('scroll', () => { if (ghost) render(); }, true);
    window.addEventListener('resize', () => clear());
})();
