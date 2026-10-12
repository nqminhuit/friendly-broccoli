// Run: node --test tools/vtelex/telex.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { apply, convert, step, isValid } = require('./telex.js');

// Types keys one by one the way content.js does, and returns the final word.
function type(keys, opts) {
    let state = null;
    let word = '';
    for (const key of keys) {
        state = step(state, word, key, opts);
        word = state.out;
    }
    return word;
}

const CASES = [
    ['tieengs', 'tiếng'],
    ['vieetj', 'việt'],
    ['Vieetj', 'Việt'],
    ['dduowngf', 'đường'],
    ['nguyeenx', 'nguyễn'],
    ['nguowif', 'người'],
    ['hoaf', 'hòa'],
    ['thuys', 'thúy'],
    ['khoer', 'khỏe'],
    ['hoafn', 'hoàn'],
    ['toans', 'toán'],
    ['quaf', 'quà'],
    ['quoocs', 'quốc'],
    ['gif', 'gì'],
    ['giaf', 'già'],
    ['giuwax', 'giữa'],
    ['muaw', 'mưa'],
    ['muwa', 'mưa'],
    ['hoawcj', 'hoặc'],
    ['ruouwj', 'rượu'],
    ['khuyeen', 'khuyên'],
    ['oais', 'oái'],
    ['xooongf', 'xoòng'],
    ['tieesng', 'tiếng'],
    ['tiengse', 'tiếng'],
    ['dataa', 'data'],
    ['Dataa', 'Data'],
    ['DATAA', 'DATA'],
    ['dataA', 'datA'],
    ['dataaa', 'dataa'],
    ['dataas', 'datas'],
    ['genee', 'gene'],
    ['homoo', 'homo'],
    ['data', 'dât'],
    ['daat', 'dât'],
    ['DDUWOWNGF', 'ĐƯỜNG'],
    ['w', 'ư'],
    ['tw', 'tư'],
    ['ww', 'w'],
    ['tww', 'tw'],
    ['tuww', 'tuw'],
    ['ass', 'as'],
    ['aaa', 'aa'],
    ['ddd', 'dd'],
    ['asz', 'a'],
    ['as', 'á'],
    ['s', 's'],
    ['with', 'with'],
    ['windows', 'windows'],
    ['hello', 'hello'],
    ['bans', 'bán'],
    ['banis', 'banis'],
];

for (const [keys, want] of CASES) {
    test(`${keys} -> ${want}`, () => assert.equal(type(keys), want));
}

test('modern tone placement', () => {
    assert.equal(type('hoaf', { modernTone: true }), 'hoà');
    assert.equal(type('thuys', { modernTone: true }), 'thuý');
    assert.equal(type('muaf', { modernTone: true }), 'mùa');
});

test('state resets when the word before the caret changed', () => {
    const state = step(null, 'tie', 'e');
    assert.equal(state.out, 'tiê');
    // The user moved the caret to another word: the stale state must not leak.
    assert.equal(step(state, 'ba', 'f').out, 'bà');
});

test('convert skips the restore step', () => {
    assert.equal(type('ddc'), 'ddc');
    assert.equal(require('./telex.js').convert('ddc'), 'đc');
    assert.equal(require('./telex.js').convert('DDC'), 'ĐC');
});

test('repeated vowel marks escape a marked syllable before a final consonant', () => {
    assert.equal(apply('dât', 'a'), 'data');
    assert.equal(convert('dataa'), 'data');
    assert.equal(apply('dất', 'a'), 'dáta');
    assert.equal(type('datsaa'), 'datsaa');

    let state = null;
    let word = '';
    for (const key of 'dataa') {
        state = step(state, word, key);
        word = state.out;
    }
    assert.equal(state.raw, 'dataa');
    assert.equal(state.out, 'data');
});

test('keep shows a shortcut start instead of the raw keys', () => {
    const keep = (out) => out.toLowerCase() === 'đc';
    assert.equal(type('ddc', { keep }), 'đc');
    assert.equal(type('DDc', { keep }), 'Đc');
    // Past the shortcut it restores as usual.
    assert.equal(type('ddcx', { keep }), 'ddcx');
});

test('isValid', () => {
    for (const w of ['tiếng', 'đường', 'quốc', 'gì', 'th', 'ư', 'khuyên']) assert.ok(isValid(w), w);
    for (const w of ['ưin', 'wín', 'tẽt', 'bani']) assert.ok(!isValid(w), w);
});
