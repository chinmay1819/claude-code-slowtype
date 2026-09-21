// The correctness-critical tests: the text we animate towards must equal the
// text Claude Code will actually write. If these drift, the viewer sees a lie.
import assert from 'node:assert';
import { targetTextFor, applyEdit } from '../extension/out/preview.js';

// --- Write -----------------------------------------------------------------
assert.strictEqual(targetTextFor('Write', { content: 'hi\n' }, 'old'), 'hi\n');
assert.strictEqual(targetTextFor('Write', {}, 'old'), null, 'missing content is skipped');

// --- Edit ------------------------------------------------------------------
{
  const src = 'const a = 1;\nconst b = 2;\n';
  assert.strictEqual(
    targetTextFor('Edit', { old_string: 'const b = 2;', new_string: 'const b = 99;' }, src),
    'const a = 1;\nconst b = 99;\n'
  );
}
assert.strictEqual(
  applyEdit('abc', { old_string: 'zzz', new_string: 'x' }),
  null,
  'a non-matching edit is skipped so the real tool can report it'
);
assert.strictEqual(
  applyEdit('x x', { old_string: 'x', new_string: 'y' }),
  null,
  'an ambiguous match is skipped, matching the real tool refusing to guess'
);
assert.strictEqual(
  applyEdit('x x', { old_string: 'x', new_string: 'y', replace_all: true }),
  'y y',
  'replace_all handles multiple matches'
);
assert.strictEqual(applyEdit('abc', { old_string: '', new_string: 'x' }), null);
assert.strictEqual(applyEdit('abc', { old_string: 'a', new_string: 'a' }), null, 'no-op edit');
assert.strictEqual(
  applyEdit('abc', { old_string: 'zzz', new_string: 'x', replace_all: true }),
  null,
  'replace_all with no match is skipped too'
);
assert.strictEqual(applyEdit('abc', { old_string: 'a' }), null, 'missing new_string is skipped');
assert.strictEqual(applyEdit('abc', null), null, 'missing edit is skipped');
assert.strictEqual(applyEdit('abc', { old_string: 'b', new_string: '' }), 'ac', 'deletion via empty new_string');
{
  // new_string is literal text. `$&`, `$1` and `$$` must not be treated as
  // String.replace patterns.
  assert.strictEqual(applyEdit('let a;', { old_string: 'a', new_string: '$&$1$$' }), 'let $&$1$$;');
  assert.strictEqual(
    applyEdit('a a', { old_string: 'a', new_string: '$&', replace_all: true }),
    '$& $&'
  );
}
{
  // Overlapping candidates: 'aa' occurs twice in 'aaa' (at 0 and 1), but the
  // uniqueness check only looks for non-overlapping repeats.
  assert.strictEqual(applyEdit('aaa', { old_string: 'aa', new_string: 'b' }), 'ba');
}
assert.strictEqual(targetTextFor('Write', { content: '' }, 'old'), '', 'writing an empty file is still a write');
assert.strictEqual(targetTextFor('Write', { content: 42 }, 'old'), null, 'non-string content is skipped');
assert.strictEqual(targetTextFor('Write', undefined, 'old'), null, 'missing input is skipped');
assert.strictEqual(targetTextFor('Edit', { old_string: 'x', new_string: 'y' }, ''), null,
  'an edit against a missing (empty) file is skipped');

// --- MultiEdit -------------------------------------------------------------
{
  const src = 'one\ntwo\nthree\n';
  const out = targetTextFor('MultiEdit', {
    edits: [
      { old_string: 'one', new_string: '1' },
      { old_string: 'three', new_string: '3' },
    ],
  }, src);
  assert.strictEqual(out, '1\ntwo\n3\n', 'edits apply in sequence');
}
{
  // Later edits see the result of earlier ones, as the real tool does.
  const out = targetTextFor('MultiEdit', {
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'b', new_string: 'c' },
    ],
  }, 'a');
  assert.strictEqual(out, 'c');
}
{
  // If any edit in the batch can't apply, the whole batch is skipped — the real
  // MultiEdit is atomic, so animating a partial result would be wrong.
  const out = targetTextFor('MultiEdit', {
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'NOPE', new_string: 'x' },
    ],
  }, 'a');
  assert.strictEqual(out, null);
}
{
  // An edit that only becomes ambiguous because of an earlier edit still
  // sinks the batch.
  const out = targetTextFor('MultiEdit', {
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'b', new_string: 'c' },
    ],
  }, 'a b');
  assert.strictEqual(out, null);
}
{
  // replace_all is honoured per edit inside a batch.
  const out = targetTextFor('MultiEdit', {
    edits: [
      { old_string: 'x', new_string: 'y', replace_all: true },
      { old_string: 'end', new_string: 'END' },
    ],
  }, 'x x end');
  assert.strictEqual(out, 'y y END');
}
assert.strictEqual(targetTextFor('MultiEdit', { edits: [] }, 'a'), null);
assert.strictEqual(targetTextFor('MultiEdit', {}, 'a'), null, 'missing edits is skipped');
assert.strictEqual(targetTextFor('MultiEdit', { edits: 'nope' }, 'a'), null, 'non-array edits is skipped');
assert.strictEqual(targetTextFor('Bash', {}, 'a'), null, 'unknown tools are ignored');

console.log('ok  preview matches tool semantics');
