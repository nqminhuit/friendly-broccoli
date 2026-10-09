// Run: node --test tools/vtelex/macros.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_MACROS, parseMacros, expand } = require('./macros.js');

test('parseMacros skips comments, blanks and malformed lines', () => {
    const m = parseMacros('# note\n\n Ko = không \nbad line\ntwo words = x\n= x\nk =\nvd = ví dụ = eg\n');
    assert.deepEqual([...m], [['ko', 'không'], ['vd', 'ví dụ = eg']]);
});

test('expand follows the typed case', () => {
    const m = parseMacros('ko = không\nj = gì\nnma = nhưng mà');
    assert.equal(expand(m, 'ko'), 'không');
    assert.equal(expand(m, 'Ko'), 'Không');
    assert.equal(expand(m, 'KO'), 'KHÔNG');
    assert.equal(expand(m, 'J'), 'Gì');
    assert.equal(expand(m, 'Nma'), 'Nhưng mà');
    assert.equal(expand(m, 'kok'), null);
});

test('defaults parse', () => {
    const m = parseMacros(DEFAULT_MACROS);
    assert.equal(m.get('ko'), 'không');
    assert.equal(m.get('đc'), 'được');
});
