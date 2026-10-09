// Text expansion: a finished word that is a shortcut ("ko") becomes its text ("không").
(function (root) {
    'use strict';

    const DEFAULT_MACROS = `# shortcut = text, one per line. Shortcuts match whole words, ignoring case.
ko = không
đc = được
nc = nước
trc = trước
ntn = như thế nào
bn = bao nhiêu
hnay = hôm nay
hqua = hôm qua
vd = ví dụ
`;

    // Lines of "shortcut = text"; blank lines, # comments and malformed lines are skipped.
    function parseMacros(text) {
        const macros = new Map();
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            const eq = trimmed.indexOf('=');
            if (!trimmed || trimmed.startsWith('#') || eq < 0) continue;
            const key = trimmed.slice(0, eq).trim().toLowerCase();
            const value = trimmed.slice(eq + 1).trim();
            if (key && value && !/\s/.test(key)) macros.set(key, value);
        }
        return macros;
    }

    // The expansion for typed, following its case ("Ko" -> "Không", "KO" -> "KHÔNG"), or null.
    function expand(macros, typed) {
        const value = macros.get(typed.toLowerCase());
        if (value === undefined) return null;
        const first = typed[0];
        if (typed.length > 1 && typed === typed.toUpperCase() && typed !== typed.toLowerCase()) return value.toUpperCase();
        if (first !== first.toLowerCase()) return value[0].toUpperCase() + value.slice(1);
        return value;
    }

    const api = { DEFAULT_MACROS, parseMacros, expand };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.vtelexMacros = api;
})(globalThis);
