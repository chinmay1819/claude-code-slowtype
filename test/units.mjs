// Unit tests for the pure logic (diff + pacing), run against the compiled output.
import assert from 'node:assert';
import fs from 'node:fs';
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
{
  // A mid-line change on the first line snaps to offset 0, not -1.
  const s = changedSpan('abc', 'abd');
  assert.deepStrictEqual(s, { start: 0, end: 3, insert: 'abd' });
}
{
  // Regression: a change at offset 0 of a file that starts with a blank line.
  // lastIndexOf('\n', -1) finds that newline, which used to push the start past
  // the change and produce an empty span.
  const s = changedSpan('\nx', 'ax');
  assert.deepStrictEqual(s, { start: 0, end: 1, insert: 'a' });
}
{
  // CRLF files: snapping stops after the \n, never splitting \r\n.
  const oldT = 'a\r\nb\r\n';
  const newT = 'a\r\nc\r\n';
  const s = changedSpan(oldT, newT);
  assert.strictEqual(s.start, 3, 'span starts after the CRLF');
  assert.strictEqual(oldT.slice(0, s.start) + s.insert + oldT.slice(s.end), newT);
}
{
  // Every span must reconstruct the new text, whatever the inputs. Seeded so a
  // failure is reproducible.
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const alphabet = 'ab\n \t{}\r';
  const gen = () => Array.from({ length: (rnd() * 20) | 0 }, () => alphabet[(rnd() * alphabet.length) | 0]).join('');
  for (let i = 0; i < 2000; i++) {
    const oldT = gen();
    const newT = rnd() < 0.5 ? gen() : oldT.slice(0, (rnd() * oldT.length) | 0) + gen() + oldT.slice((rnd() * oldT.length) | 0);
    const s = changedSpan(oldT, newT);
    if (oldT === newT) { assert.strictEqual(s, null); continue; }
    assert.ok(s.start <= s.end && s.end <= oldT.length, `span in bounds for ${JSON.stringify([oldT, newT])}`);
    assert.ok(s.start === 0 || oldT[s.start - 1] === '\n', 'span starts at a line boundary');
    assert.strictEqual(oldT.slice(0, s.start) + s.insert + oldT.slice(s.end), newT,
      `span reconstructs ${JSON.stringify([oldT, newT])}`);
  }
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
{
  // Empty text: nothing to type, and no division surprises.
  assert.ok(new Typist('', P).done, 'empty text is done immediately');
  assert.strictEqual(estimateMs('', P), 0);
}
{
  // charsPerSecond is the *effective* rate, pauses included, and
  // expressiveness redistributes time rather than adding it. Both claims are
  // what make the settings predictable.
  const text = fs.readFileSync(new URL('../extension/src/diff.ts', import.meta.url), 'utf8');
  for (const charsPerSecond of [6, 10, 20]) {
    const desired = (text.length / charsPerSecond) * 1000;
    for (const expressiveness of [0, 0.5, 1, 2]) {
      const ratio = estimateMs(text, { charsPerSecond, expressiveness }) / desired;
      assert.ok(Math.abs(ratio - 1) < 0.05,
        `${charsPerSecond} c/s at expressiveness ${expressiveness} should take ~${desired | 0}ms (ratio ${ratio.toFixed(3)})`);
    }
  }
}
{
  // Above the timer floor, chunks widen instead of delays shrinking. The text
  // must still reconstruct exactly, and chunks must not run past a token.
  const text = 'export function add(a: number, b: number) {\n  return a + b; // "sum"\n}\n'.repeat(3);
  const t = ticks(text, { charsPerSecond: 5000, expressiveness: 1 });
  assert.strictEqual(t.map((x) => x.text).join(''), text, 'high-speed chunks reproduce the text');
  assert.ok(t.some((x) => x.chunk > 1), 'high speed widens chunks');
  assert.ok(t.every((x) => x.delayMs >= 16), 'high speed still respects the timer floor');
}
{
  // Nonsense settings must degrade, not hang or produce NaN.
  for (const opts of [{ charsPerSecond: 0, expressiveness: 1 }, { charsPerSecond: 10, expressiveness: -1 }]) {
    const ms = estimateMs('const x = 1;\n', opts);
    assert.ok(Number.isFinite(ms) && ms > 0, `estimateMs finite for ${JSON.stringify(opts)}`);
    assert.strictEqual(ticks('const x = 1;\n', opts).map((x) => x.text).join(''), 'const x = 1;\n');
  }
}

console.log('ok  diff + pacing');
