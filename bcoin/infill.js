// Pure FIM helpers shared by content.js and the node tests: the /infill context around the caret
// and the clean-up of the model's answer, ported from ecoin-llama.el (github.com/nqminhuit/ecoin).
(function (root) {
    'use strict';

    const LEAK_RE = /<\|(?:endoftext|file_sep|fim_[a-z_]*|im_end|cursor)\|>/g;
    const CLOSER_RE = /^[ \t]*(?:[\])}>]+[;,]?|end|fi|done|esac|endif|endfor|endwhile|endfunction|end;|end,)[ \t]*$/;
    // Degenerate repetition at the end of a line (Tabby).
    const REPEAT_RES = [/(.{3,})\1{5,}$/, /(.{10,})\1{3,}$/];
    const DEFAULTS = { nPrefix: 256, nSuffix: 64, maxPrefixChars: 12000, maxSuffixChars: 4000 };

    const isBlank = (s) => /^\s*$/.test(s);
    const sameLines = (a, b) => a.length === b.length && a.every((l, i) => l === b[i]);

    // Keeps the bottom of text within max chars, starting at a line.
    function cutTop(text, max) {
        if (text.length <= max) return text;
        const tail = text.slice(text.length - max);
        const nl = tail.indexOf('\n');
        return nl >= 0 ? tail.slice(nl + 1) : '';
    }

    // Keeps the top of text within max chars, ending at a line.
    function cutBottom(text, max) {
        if (text.length <= max) return text;
        const nl = text.slice(0, max).lastIndexOf('\n');
        return nl >= 0 ? text.slice(0, nl + 1) : '';
    }

    // The /infill context for the caret at index caret of text, as ecoin-llama--context builds it.
    function buildContext(text, caret, options = {}) {
        const o = { ...DEFAULTS, ...options };
        const bol = text.lastIndexOf('\n', caret - 1) + 1;
        const nl = text.indexOf('\n', caret);
        const eol = nl < 0 ? text.length : nl;
        const textBefore = text.slice(bol, caret);
        const textAfter = text.slice(caret, eol);
        const line = textBefore + textAfter;
        const blank = /^[ \t]*$/.test(line);
        const aboveLines = text.slice(0, bol).split('\n').slice(0, -1).slice(-o.nPrefix);
        const above = aboveLines.map((l) => l + '\n').join('');
        const rest = nl < 0 ? '' : text.slice(eol + 1);
        const next = rest === '' ? [] : rest.split('\n');
        let below = rest.split('\n').slice(0, o.nSuffix).join('\n');
        if (rest.split('\n').length > o.nSuffix) below += '\n';
        if (below && !below.endsWith('\n')) below += '\n';
        return {
            prefix: cutTop(above, o.maxPrefixChars),
            middle: blank ? '' : textBefore,
            suffix: textAfter + '\n' + cutBottom(below, o.maxSuffixChars),
            nIndent: blank ? 0 : /^[ \t]*/.exec(line)[0].length,
            textBefore,
            textAfter,
            next,
        };
    }

    // True when the suggestion only repeats the text around the caret (the llama.vim rules).
    function repeatsText(lines, before, after, next) {
        const first = lines[0];
        const n = lines.length;
        if (n === 1 && (first === after || first.trim() === after.trim())) return true;
        if (first === '' && n > 1 && sameLines(lines.slice(1), next.slice(0, n - 1))) return true;
        const t = next.findIndex((l) => !isBlank(l));
        if (t < 0 || before + first !== next[t]) return false;
        const afterTail = next.slice(t + 1);
        return n === 1
            || (n === 2 && afterTail.length > 0 && afterTail[0].startsWith(lines[1]))
            || (n > 2 && sameLines(lines.slice(1), afterTail.slice(0, n - 1)));
    }

    // Cuts lines at the second of two consecutive identical non-blank lines.
    function cutRepeats(lines) {
        const out = [lines[0]];
        for (let i = 1; i < lines.length; i++) {
            if (lines[i] === lines[i - 1] && !isBlank(lines[i])) break;
            out.push(lines[i]);
        }
        return out;
    }

    // Drops trailing closer-only lines that the following text already holds; the first line always stays.
    function snipClosers(lines, next) {
        const following = next.filter((l) => !isBlank(l));
        const tail = [];
        const rest = lines.slice(1).reverse();
        for (const l of rest) {
            if (!isBlank(l) && !CLOSER_RE.test(l)) break;
            if (!isBlank(l)) tail.unshift(l);
        }
        let k = tail.length;
        while (k > 0 && !sameLines(tail.slice(tail.length - k), following.slice(0, k))) k--;
        if (k === 0) return lines;
        const src = lines.slice().reverse();
        let j = 0;
        while (j < src.length && (k > 0 || isBlank(src[j]))) {
            if (!isBlank(src[j])) k--;
            j++;
        }
        return src.slice(j).reverse();
    }

    // Turns the model's raw content into ghost text for ctx, or null for none.
    function postprocess(content, ctx) {
        const rev = content.replace(LEAK_RE, '').split('\n').reverse();
        while (rev.length && isBlank(rev[0])) rev.shift();
        if (!rev.length) return null;
        rev[0] = rev[0].replace(/\s+$/, '');
        let lines = rev.reverse();
        // On a whitespace-only line, the indentation before the caret is already typed.
        if (isBlank(ctx.textBefore + ctx.textAfter)) {
            const m = /^[ \t]+/.exec(lines[0]);
            if (m) lines[0] = lines[0].slice(Math.min(m[0].length, ctx.textBefore.length));
        }
        if (repeatsText(lines, ctx.textBefore, ctx.textAfter, ctx.next)) return null;
        lines = cutRepeats(lines);
        if (REPEAT_RES.some((re) => re.test(lines[lines.length - 1]))) return null;
        if (/[^ \t]/.test(ctx.textAfter)) {
            let first = lines[0];
            const tail = ctx.textAfter.trim();
            if (tail && first.endsWith(tail)) first = first.slice(0, first.length - tail.length);
            lines = [first];
        }
        if (lines.length > 1) lines = snipClosers(lines, ctx.next);
        const out = lines.join('\n');
        return /[^ \t\n]/.test(out) ? out : null;
    }

    // The next word of ghost to accept: leading whitespace plus a run of word or of punctuation characters.
    function nextWord(ghost) {
        const m = /^\s*(?:[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]+)/u.exec(ghost);
        return m ? m[0] : ghost;
    }

    const api = { buildContext, postprocess, nextWord };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.bcoinInfill = api;
})(globalThis);
