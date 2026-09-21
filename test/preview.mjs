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
assert.strictEqual(targetTextFor('MultiEdit', { edits: [] }, 'a'), null);
assert.strictEqual(targetTextFor('Bash', {}, 'a'), null, 'unknown tools are ignored');

console.log('ok  preview matches tool semantics');
