// Constants that live in different files but must agree. Nothing enforces these
// at compile time; drift shows up only as a hook killed mid-animation or a
// setting whose documented default isn't the real one.
import fs from 'node:fs';
import assert from 'node:assert';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('extension/package.json'));
const props = pkg.contributes.configuration.properties;
const extensionSrc = read('extension/src/extension.ts');
const hookSrc = read('hook/slowtype-hook.mjs');
const installSrc = read('extension/src/install.ts');

const num = (src, re, what) => {
  const m = src.match(re);
  assert.ok(m, `could not find ${what}; update test/config.mjs if it moved`);
  return Number(m[1].replace(/_/g, ''));
};

// --- timeout chain: animation cap < hook cap < Claude Code's hook timeout ---
{
  const animDefaultMs = props['slowtype.maxAnimationSeconds'].default * 1000;
  const animMaxMs = props['slowtype.maxAnimationSeconds'].maximum * 1000;
  const animFallbackMs = num(extensionSrc, /get<number>\('maxAnimationSeconds',\s*([\d_]+)\)/, 'maxAnimationSeconds fallback') * 1000;
  const hookMs = num(hookSrc, /SLOWTYPE_MAX_MS\s*\?\?\s*([\d_]+)/, 'hook SLOWTYPE_MAX_MS default');
  const claudeMs = num(installSrc, /timeout:\s*([\d_]+)/, 'installed hook timeout') * 1000;

  assert.strictEqual(animFallbackMs, animDefaultMs, 'extension.ts fallback matches package.json default');
  assert.ok(animDefaultMs < hookMs, `default animation cap (${animDefaultMs}) < hook cap (${hookMs})`);
  assert.ok(animMaxMs < hookMs, `largest allowed animation cap (${animMaxMs}) < hook cap (${hookMs})`);
  assert.ok(hookMs < claudeMs, `hook cap (${hookMs}) < Claude Code hook timeout (${claudeMs})`);
}

// --- other setting defaults match between package.json and extension.ts ----
for (const [key, fallback] of [
  ['charsPerSecond', num(extensionSrc, /get<number>\('charsPerSecond',\s*([\d.]+)\)/, 'charsPerSecond fallback')],
  ['expressiveness', num(extensionSrc, /get<number>\('expressiveness',\s*([\d.]+)\)/, 'expressiveness fallback')],
]) {
  assert.strictEqual(fallback, props[`slowtype.${key}`].default, `${key}: extension.ts fallback matches package.json`);
}
assert.match(extensionSrc, /get<boolean>\('enabled',\s*true\)/);
assert.strictEqual(props['slowtype.enabled'].default, true);

// --- every contributed command is registered, and vice versa ---------------
{
  const contributed = pkg.contributes.commands.map((c) => c.command).sort();
  const registered = [...extensionSrc.matchAll(/registerCommand\('([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(registered, contributed, 'package.json commands and registerCommand calls agree');
  for (const kb of pkg.contributes.keybindings) {
    assert.ok(contributed.includes(kb.command), `keybinding targets a real command: ${kb.command}`);
  }
}

console.log('ok  timeout chain and cross-file constants agree');
