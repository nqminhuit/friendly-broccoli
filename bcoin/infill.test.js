// Run: node --test bcoin/infill.test.js
// The cases come from ecoin's test/ecoin-llama-test.el; "|" marks the caret.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContext, postprocess, nextWord } = require('./infill.js');

function at(marked, options) {
    const caret = marked.indexOf('|');
    return buildContext(marked.slice(0, caret) + marked.slice(caret + 1), caret, options);
}

test('context line windows', () => {
    const ctx = at('l1\nl2\nl3\nl4\nl|5\nl6\nl7\nl8\n', { nPrefix: 2, nSuffix: 2 });
    assert.equal(ctx.prefix, 'l3\nl4\n');
    assert.equal(ctx.middle, 'l');
    assert.equal(ctx.suffix, '5\nl6\nl7\n');
});

test('context indent and middle', () => {
    const ctx = at('x\n    foo(|\ny');
    assert.equal(ctx.middle, '    foo(');
    assert.equal(ctx.nIndent, 4);
    assert.equal(ctx.prefix, 'x\n');
    assert.equal(ctx.suffix, '\ny\n');
    assert.equal(at('\t\tfoo|').nIndent, 2);
});

test('context on a whitespace-only line', () => {
    let ctx = at('x\n    |\ny\n');
    assert.equal(ctx.middle, '');
    assert.equal(ctx.nIndent, 0);
    assert.equal(ctx.suffix, '\ny\n');
    ctx = at('x\n  | \ny\n');
    assert.equal(ctx.middle, '');
    assert.equal(ctx.suffix, ' \ny\n');
});

test('context at the text edges', () => {
    let ctx = at('|abc');
    assert.equal(ctx.prefix, '');
    assert.equal(ctx.middle, '');
    assert.equal(ctx.suffix, 'abc\n');
    ctx = at('abc\n|');
    assert.equal(ctx.prefix, 'abc\n');
    assert.equal(ctx.suffix, '\n');
    assert.equal(at('abc|').suffix, '\n');
});

test('context caps the prefix and suffix at line boundaries', () => {
    const ctx = at('aaaa\nbbbb\n|\ncccc\ndddd\n', { maxPrefixChars: 6, maxSuffixChars: 6 });
    assert.equal(ctx.prefix, 'bbbb\n');
    assert.equal(ctx.suffix, '\ncccc\n');
});

const POST_CASES = [
    // Rule 1: control tokens that leaked into the content.
    ['x = |', '1<|endoftext|>', '1'],
    ['x = |', 'a<|file_sep|>b<|fim_middle|>c<|im_end|>', 'abc'],
    ['x = |', 'foo<|cursor|>bar', 'foobar'],
    ['x = |', '<|endoftext|>', null],
    // Rule 2: trailing blank lines and whitespace, empty result.
    ['x = |', '1  \n\n  \n', '1'],
    ['x = |', 'a\n  b   \n\n', 'a\n  b'],
    ['x = |', '\n\n', null],
    ['x = |', '', null],
    ['f(|', '\n    bar\n', '\n    bar'],
    // Rule 3: indentation already before the caret on a whitespace-only line.
    ['def f():\n    |', '        return 1', '    return 1'],
    ['    |', '  x', 'x'],
    ['\t|', '\t\ty', '\ty'],
    ['def f():\n    |', 'return 1', 'return 1'],
    // Rule 4a: a single line that is the text after the caret.
    ['f(|)', ')', null],
    ['f(|)', ' )', null],
    ['f(|)', 'a)', 'a'],
    // Rule 4b: empty first line and the following lines are already there.
    ['a|\nb\nc', '\nb\nc', null],
    ['a|\nb\nc', '\nb\nd', '\nb\nd'],
    // Rule 4c: the suggestion rewrites the next non-blank line.
    ['    |\n\n    foo', 'foo', null],
    ['    |\n    foo\nbarbaz', 'foo\nbar', null],
    ['    |\n    foo\nbar\nbaz', 'foo\nbar\nbaz', null],
    ['    |\n    foo\nbar\nbaz', 'foo\nbar\nqux', 'foo\nbar\nqux'],
    ['    |\n    foo', 'fox', 'fox'],
    // Rule 5: repetition.
    ['|', 'a\nb\nb\nc', 'a\nb'],
    ['|', 'a\n\n\nb', 'a\n\n\nb'],
    ['|', 'x\nabcabcabcabcabcabcabc', null],
    ['|', '0123456789012345678901234567890123456789', null],
    ['|', 'abcabcabc', 'abcabcabc'],
    // Rule 6: text after the caret keeps only the first line, minus the closers.
    ['f(|)', 'a, b)\nnext', 'a, b'],
    ['f(|)', 'a, b', 'a, b'],
    ['f(|) # c', '1\n2', '1'],
    ['f(|)', '\nfoo', null],
    ['f(|);', 'x);', 'x'],
    // Rule 7: closers the text already has.
    ['if (x) {\n    |\n}\n', 'foo();\n}', 'foo();'],
    ['if (x) {\n    |\n}\n', 'foo();\n  }', 'foo();\n  }'],
    ['x {\n|\n\n}\n', 'a\n\n}', 'a'],
    ['f(|\n)', 'a,\n b\n)', 'a,\n b'],
    ['do\n  |\nend\n', 'work\nend', 'work'],
    ['do\n  |\nend\nend\n', 'work\nend', 'work'],
    ['x\n  |\n  }\n}\n', 'a\n  }\n}', 'a'],
    ['do\n  |\nfoo\n', 'work\nend', 'work\nend'],
    // Nothing special: multi-line text passes through.
    ['def f():\n    |', 'a = 1\n    b = 2', 'a = 1\n    b = 2'],
];

for (const [marked, content, want] of POST_CASES) {
    test(`postprocess ${JSON.stringify(marked)} + ${JSON.stringify(content)}`, () => {
        assert.equal(postprocess(content, at(marked)), want);
    });
}

test('nextWord takes leading space plus a word or a punctuation run', () => {
    assert.equal(nextWord('foo bar'), 'foo');
    assert.equal(nextWord(' bar baz'), ' bar');
    assert.equal(nextWord('(a, b)'), '(');
    assert.equal(nextWord('\n    return 1'), '\n    return');
    assert.equal(nextWord('tiếng Việt'), 'tiếng');
    assert.equal(nextWord('   '), '   ');
});
