// Telex engine: pure functions over one word, shared by content.js and the node tests.
(function (root) {
    'use strict';

    // Toneless vowel -> its six forms: none, sắc (s), huyền (f), hỏi (r), ngã (x), nặng (j).
    const TONED = {
        a: 'aáàảãạ', ă: 'ăắằẳẵặ', â: 'âấầẩẫậ',
        e: 'eéèẻẽẹ', ê: 'êếềểễệ',
        i: 'iíìỉĩị',
        o: 'oóòỏõọ', ô: 'ôốồổỗộ', ơ: 'ơớờởỡợ',
        u: 'uúùủũụ', ư: 'ưứừửữự',
        y: 'yýỳỷỹỵ',
    };
    const TONE_KEYS = 'sfrxj';
    const UNTONE = {};
    for (const [v, forms] of Object.entries(TONED)) {
        [...forms].forEach((c, tone) => { UNTONE[c] = { v, tone }; });
    }
    const VOWELS = new Set(Object.keys(TONED));
    const PLAIN = { ă: 'a', â: 'a', ê: 'e', ô: 'o', ơ: 'o', ư: 'u', đ: 'd' };
    const HAT = { a: 'â', ă: 'â', e: 'ê', o: 'ô', ơ: 'ô' };
    const HOOK = { a: 'ă', â: 'ă', o: 'ơ', ô: 'ơ', u: 'ư' };
    const HOOKED = new Set(['ă', 'ơ', 'ư']);
    const MARKED = new Set(['ă', 'â', 'ê', 'ô', 'ơ', 'ư']);

    const INITIALS = new Set('b c ch d đ g gh gi h k kh l m n ng ngh nh p ph qu r s t th tr v x'.split(' '));
    const FINALS = new Set(['c', 'ch', 'm', 'n', 'ng', 'nh', 'p', 't']);
    const STOP_FINALS = new Set(['c', 'ch', 'p', 't']);
    const CLUSTERS = ('a ă â e ê i o ô ơ u ư y ai ao au ay âu ây eo êu ia iê iu oa oă oe oi ôi ơi oo ua uâ uê ui uô uơ uy ưa ưi ươ ưu yê ' +
                      'iêu oai oao oay oeo uây uôi uya uyê uyu ươi ươu yêu').split(' ');
    const FINAL_CLUSTERS = 'a ă â e ê i o ô ơ u ư oa oă oe oo uâ uê uô ươ uy iê yê uyê'.split(' ');

    const plain = (s) => [...s].map((c) => PLAIN[c] || c).join('');
    const prefixes = (words) => new Set(words.flatMap((w) => [...w].map((_, i) => w.slice(0, i + 1))));
    // Unmarked spellings ("ie", "uo") and "ưo" are what telex shows before the mark key arrives.
    const CLUSTER_PREFIXES = prefixes([...CLUSTERS, ...CLUSTERS.map(plain), 'ưo']);
    const TAKES_FINAL = new Set([...FINAL_CLUSTERS, ...FINAL_CLUSTERS.map(plain), 'ưo']);
    const INITIAL_PREFIXES = prefixes([...INITIALS, 'q']);
    const FINAL_PREFIXES = prefixes([...FINALS]);

    function decompose(word) {
        const chars = [];
        const upper = [];
        let tone = 0;
        for (const c of word) {
            const lower = c.toLowerCase();
            const t = UNTONE[lower];
            chars.push(t ? t.v : lower);
            upper.push(c !== lower);
            if (t && t.tone) tone = t.tone;
        }
        return { chars, upper, tone };
    }

    // Splits chars into initial, vowel cluster and final; null when vowels follow the final (not one syllable).
    function structure(chars) {
        let start = 0;
        if (chars[0] === 'q' && chars[1] === 'u') start = 2;
        else if (chars[0] === 'g' && chars[1] === 'i' && VOWELS.has(chars[2])) start = 2;
        while (start < chars.length && !VOWELS.has(chars[start])) start++;
        let end = start;
        while (end < chars.length && VOWELS.has(chars[end])) end++;
        if (chars.slice(end).some((c) => VOWELS.has(c))) return null;
        return { start, end };
    }

    function tonePosition(chars, s, modernTone) {
        const { start, end } = s;
        const n = end - start;
        if (n === 0) return -1;
        for (let i = end - 1; i >= start; i--) if (MARKED.has(chars[i])) return i;
        if (end < chars.length || n === 1) return end - 1;
        if (n >= 3) return start + 1;
        const pair = chars[start] + chars[start + 1];
        return modernTone && (pair === 'oa' || pair === 'oe' || pair === 'uy') ? start + 1 : start;
    }

    function compose(chars, upper, tone, modernTone) {
        const s = structure(chars);
        const pos = s && tone ? tonePosition(chars, s, modernTone) : -1;
        return chars.map((c, i) => {
            const ch = i === pos ? TONED[c][tone] : c;
            return upper[i] ? ch.toUpperCase() : ch;
        }).join('');
    }

    // Returns the word after typing key at its end.
    function apply(word, key, opts = {}) {
        const k = key.toLowerCase();
        const literal = word + key;
        const { chars, upper, tone } = decompose(word);
        const s = structure(chars);
        if (!s) return literal;
        const cluster = [];
        for (let i = s.start; i < s.end; i++) cluster.push(i);
        let newTone = tone;
        const append = (c, up) => { chars.push(c); upper.push(up); };

        if (TONE_KEYS.includes(k) && cluster.length) {
            const t = TONE_KEYS.indexOf(k) + 1;
            if (tone === t) {
                newTone = 0;
                append(k, key !== k);
            } else {
                newTone = t;
            }
        } else if (k === 'z' && tone) {
            newTone = 0;
        } else if (k === 'd' && (chars[0] === 'd' || chars[0] === 'đ')) {
            if (chars[0] === 'đ') {
                chars[0] = 'd';
                append(k, key !== k);
            } else {
                chars[0] = 'đ';
            }
        } else if ('aeo'.includes(k) && cluster.some((i) => plain(chars[i]) === k)) {
            const i = cluster.filter((j) => plain(chars[j]) === k).pop();
            if (chars[i] === HAT[k]) {
                chars[i] = k;
                append(k, key !== k);
            } else {
                chars[i] = HAT[chars[i]];
            }
        } else if (k === 'w') {
            const hooked = cluster.filter((i) => HOOKED.has(chars[i]));
            const uo = cluster.find((i) => plain(chars[i]) === 'u' && plain(chars[i + 1] || '') === 'o' && i + 1 < s.end);
            if (hooked.length && !(uo !== undefined && hooked.length === 1)) {
                hooked.forEach((i) => { chars[i] = PLAIN[chars[i]]; });
                append(k, key !== k);
            } else if (uo !== undefined) {
                chars[uo] = 'ư';
                chars[uo + 1] = 'ơ';
            } else if (cluster.length) {
                const candidates = cluster.filter((i) => HOOK[chars[i]]).reverse();
                if (!candidates.length) return literal;
                // Prefer the candidate that keeps the word valid: "oa"+w is "oă", "ua"+w is "ưa".
                const tryHook = (i) => { const c = chars.slice(); c[i] = HOOK[c[i]]; return c; };
                const pick = candidates.find((i) => isValid(compose(tryHook(i), upper, tone, opts.modernTone)))
                      ?? candidates[0];
                chars[pick] = HOOK[chars[pick]];
            } else {
                append('ư', key !== k);
            }
        } else {
            append(k, key !== k);
        }
        // A vowel after the final ("bani") means this is no longer one syllable.
        if (!structure(chars)) return literal;
        return compose(chars, upper, newTone, opts.modernTone);
    }

    // True when word could still be (the start of) one Vietnamese syllable.
    function isValid(word) {
        const { chars, tone } = decompose(word);
        const s = structure(chars);
        if (!s) return false;
        const initial = chars.slice(0, s.start).join('');
        const cluster = chars.slice(s.start, s.end).join('');
        const final = chars.slice(s.end).join('');
        if (!cluster) return INITIAL_PREFIXES.has(initial) || initial === '';
        if (initial && !INITIALS.has(initial)) return false;
        if (!CLUSTER_PREFIXES.has(cluster)) return false;
        if (final) {
            if (!TAKES_FINAL.has(cluster) || !FINAL_PREFIXES.has(final)) return false;
            if (STOP_FINALS.has(final) && ![0, 1, 5].includes(tone)) return false;
        }
        return true;
    }

    const NON_ASCII = /[^\x00-\x7f]/;

    // One keystroke for the word before the caret. state remembers the raw keys of the current word,
    // so a word that stops being Vietnamese (e.g. "with") is restored to what was typed,
    // unless opts.keep(out) says to show it as is (the start of a shortcut like "đc").
    function step(state, word, key, opts = {}) {
        const st = state && state.out === word ? state : { raw: word, out: word, literal: false };
        const raw = st.raw + key;
        if (st.literal) return { raw, out: word + key, literal: true };
        // "ww" turns a standalone ư (from "w", not "uw") back into w.
        if (/^w$/i.test(key) && /[^u]w$|^w$/i.test(st.raw) && /ư$/i.test(word)) {
            return { raw, out: word.slice(0, -1) + st.raw.slice(-1), literal: true };
        }
        const out = apply(word, key, opts);
        if (NON_ASCII.test(out) && !isValid(out) && !(opts.keep && opts.keep(out))) {
            return { raw, out: raw, literal: true };
        }
        return { raw, out, literal: false };
    }

    // Telex for raw keys without the restore step, so "ddc" gives "đc" for shortcut lookup.
    function convert(raw, opts = {}) {
        return [...raw].reduce((word, key) => apply(word, key, opts), '');
    }

    const api = { apply, convert, isValid, step };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.vtelex = api;
})(globalThis);
