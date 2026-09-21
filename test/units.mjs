// Unit tests for the pure logic (diff + pacing), run against the compiled output.
import assert from 'node:assert';
import { changedSpan } from '../extension/out/diff.js';
import { Typist, estimateMs } from '../extension/out/pacing.js';

const P = { charsPerSecond: 55, expressiveness: 1 };

// --- diff ------------------------------------------------------------------
{
  assert.strictEqual(changedSpan('same', 'same'), null, 'identical text has no span');
}
{
  const s = changedSpan('', 'hello');
  assert.deepStrictEqual(s, { start: 0, end: 0, insert: 'hello' }, 'new file inserts everything');
}
{
  const oldT = 'line1\nline2\nline3\n';
  const newT = 'line1\nCHANGED\nline3\n';
  const s = changedSpan(oldT, newT);
  assert.strictEqual(oldT.slice(0, s.start) + s.insert + oldT.slice(s.end), newT, 'span reconstructs new text');
  assert.strictEqual(s.start, 6, 'span snaps to the start of the changed line');
  assert.ok(!s.insert.includes('line1'), 'unchanged prefix is not retyped');
  assert.ok(!s.insert.includes('line3'), 'unchanged suffix is not retyped');
}
{
  // Appending to a file should only type the appended part.
  const oldT = 'a\nb\n';
  const newT = 'a\nb\nc\n';
  const s = changedSpan(oldT, newT);
  assert.strictEqual(oldT.slice(0, s.start) + s.insert + oldT.slice(s.end), newT);
  assert.ok(s.insert.length <= 4, `append types little (${JSON.stringify(s.insert)})`);
}
{
  // Deletion-only change must still reconstruct.
  const oldT = 'keep\ndrop\nkeep2\n';
  const newT = 'keep\nkeep2\n';
  const s = changedSpan(oldT, newT);
  assert.strictEqual(oldT.slice(0, s.start) + s.insert + oldT.slice(s.end), newT);
}

// --- pacing ----------------------------------------------------------------
const ticks = (text, opts = P) => {
  const t = new Typist(text, opts);
  const out = [];
  while (!t.done) {
    const from = t.position;
    const tick = t.next();
    out.push({ from, text: text.slice(from, from + tick.chunk), ...tick });
  }
  return out;
};

{
  // The most important invariant: whatever the pacing does, the concatenated
  // chunks must reproduce the text exactly. A bug here corrupts files.
  for (const sample of [
    'const x = 1;\n',
    'function f(a, b) {\n  return a + b;\n}\n',
    '  indented\n\ttabbed\n',
    'const s = "hello \\" world";\n',
    'unterminated = "oops\n',
    'a',
    '\n\n\n',
    '日本語とemoji🙂\n',
  ]) {
    assert.strictEqual(ticks(sample).map((t) => t.text).join(''), sample,
      `chunks must reproduce ${JSON.stringify(sample)}`);
  }
}
{
  const t = ticks('const x = 1;\n');
  assert.ok(t.every((x) => x.chunk >= 1), 'every tick makes progress');
  assert.ok(t.every((x) => x.delayMs >= 16), 'every delay respects the timer floor');
}
{
  // Indentation arrives as one motion, not N space keystrokes.
  const t = ticks('if (x) {\n    deep();\n}\n');
  const indentTick = t.find((x) => x.text === '    ');
  assert.ok(indentTick, 'leading indentation is emitted as a single chunk');
}
{
  // Bursty, not metronomic: the spread of delays should be wide.
  const delays = ticks('function longName(argument) {\n  return argument + 1;\n}\n')
    .map((x) => x.delayMs);
  const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
  const max = Math.max(...delays);
  assert.ok(max > mean * 2.5, `pauses must stand out from the base rate (max ${max.toFixed(0)}, mean ${mean.toFixed(0)})`);
}
{
  // Words are faster per-character than the symbol soup around them.
  const t = ticks('x = someIdentifier;\n');
  const inWord = t.filter((x) => /[a-z]/i.test(x.text) && x.delayMs < 100);
  assert.ok(inWord.length > 5, 'identifiers type as a fast burst');
}
{
  // expressiveness 0 means no thinking pauses at all.
  const flat = ticks('a b\nc d\n', { charsPerSecond: 55, expressiveness: 0 });
  const delays = flat.map((x) => x.delayMs);
  const spread = Math.max(...delays) / Math.min(...delays);
  assert.ok(spread < 3, `expressiveness 0 should be near-flat (spread ${spread.toFixed(2)})`);
}
{
  // Deterministic: the same text must always type the same way.
  const a = ticks('const value = compute(1, 2);\n').map((x) => x.delayMs.toFixed(3)).join();
  const b = ticks('const value = compute(1, 2);\n').map((x) => x.delayMs.toFixed(3)).join();
  assert.strictEqual(a, b, 'pacing is seeded and reproducible');
}
{
  // Speed setting still broadly controls duration.
  const text = 'const alpha = beta + gamma;\n'.repeat(4);
  const slow = estimateMs(text, { charsPerSecond: 20, expressiveness: 1 });
  const fast = estimateMs(text, { charsPerSecond: 200, expressiveness: 1 });
  assert.ok(slow > fast * 2, `speed setting must matter (slow ${slow|0}ms, fast ${fast|0}ms)`);
  assert.ok(Number.isFinite(slow) && slow > 0);
}
{
  // estimateMs must terminate on pathological input.
  const big = 'x'.repeat(20000);
  assert.ok(estimateMs(big, { charsPerSecond: 1000, expressiveness: 1 }) > 0);
}

console.log('ok  diff + pacing');
