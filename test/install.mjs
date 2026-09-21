// "Install Claude Code hook" edits the user's .claude/settings.json. It must
// merge rather than overwrite, and re-running it must not duplicate entries.
// install.ts needs `vscode`, so a minimal stand-in is injected here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import Module, { createRequire } from 'node:module';

const messages = [];
const vscodeStub = {
  Uri: {
    file: (p) => ({ fsPath: p }),
    joinPath: (u, ...parts) => ({ fsPath: path.join(u.fsPath, ...parts) }),
  },
  workspace: {
    fs: {
      readFile: async (u) => fs.readFileSync(u.fsPath),
      writeFile: async (u, bytes) => fs.writeFileSync(u.fsPath, bytes),
      createDirectory: async (u) => fs.mkdirSync(u.fsPath, { recursive: true }),
    },
  },
  window: { showInformationMessage: (m) => messages.push(m) },
};

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscodeStub : realLoad.call(this, request, ...rest);
};
const { installHook } = createRequire(import.meta.url)('../extension/out/install.js');
Module._load = realLoad;

const extDir = '/opt/ext dir'; // a space, to check the command is quoted
const context = { asAbsolutePath: (p) => path.join(extDir, p) };
const hookPath = path.join(extDir, 'hook', 'slowtype-hook.mjs');

const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slowtype-install-test-'));
const settingsOf = (dir) => path.join(dir, '.claude', 'settings.json');
const read = (dir) => JSON.parse(fs.readFileSync(settingsOf(dir), 'utf8'));

const ours = (event, s) =>
  s.hooks[event].filter((m) => m.hooks.some((h) => h.command.includes('slowtype-hook.mjs')));

// --- fresh project: creates .claude/settings.json ---------------------------
{
  const dir = fresh();
  await installHook(context, dir);
  const s = read(dir);

  assert.deepStrictEqual(s.hooks.PreToolUse, [{
    matcher: 'Write|Edit|MultiEdit|Bash',
    hooks: [{ type: 'command', command: `node ${JSON.stringify(hookPath)}`, timeout: 600 }],
  }]);
  assert.deepStrictEqual(s.hooks.PostToolUse, [{
    matcher: 'Bash',
    hooks: [{ type: 'command', command: `node ${JSON.stringify(hookPath)}`, timeout: 600 }],
  }]);
  assert.ok(fs.readFileSync(settingsOf(dir), 'utf8').endsWith('}\n'), 'file ends with a newline');
  assert.strictEqual(messages.length, 1, 'user is told to restart Claude Code');
  fs.rmSync(dir, { recursive: true });
  console.log('ok  install into a fresh project');
}

// --- existing settings: other keys and other hooks survive ------------------
{
  const dir = fresh();
  fs.mkdirSync(path.join(dir, '.claude'));
  const theirs = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo audit' }] };
  fs.writeFileSync(settingsOf(dir), JSON.stringify({
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PreToolUse: [theirs],
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    },
  }));

  await installHook(context, dir);
  const s = read(dir);
  assert.deepStrictEqual(s.permissions, { allow: ['Bash(npm test)'] }, 'unrelated settings survive');
  assert.deepStrictEqual(s.hooks.Stop, [{ hooks: [{ type: 'command', command: 'say done' }] }], 'other events survive');
  assert.deepStrictEqual(s.hooks.PreToolUse[0], theirs, "the user's own PreToolUse hook survives, first");
  assert.strictEqual(ours('PreToolUse', s).length, 1);
  assert.strictEqual(ours('PostToolUse', s).length, 1);
  fs.rmSync(dir, { recursive: true });
  console.log('ok  existing settings are merged, not replaced');
}

// --- re-running is idempotent, and repairs a stale entry --------------------
{
  const dir = fresh();
  fs.mkdirSync(path.join(dir, '.claude'));
  // An entry from an older install: wrong matcher, old path, no timeout.
  fs.writeFileSync(settingsOf(dir), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node /old/slowtype-hook.mjs' }] }] },
  }));

  await installHook(context, dir);
  const once = read(dir);
  await installHook(context, dir);
  const twice = read(dir);

  assert.deepStrictEqual(twice, once, 'second install changes nothing');
  assert.strictEqual(once.hooks.PreToolUse.length, 1, 'the old entry is updated in place, not duplicated');
  assert.strictEqual(once.hooks.PreToolUse[0].matcher, 'Write|Edit|MultiEdit|Bash');
  assert.strictEqual(once.hooks.PreToolUse[0].hooks[0].command, `node ${JSON.stringify(hookPath)}`);
  assert.strictEqual(once.hooks.PreToolUse[0].hooks[0].timeout, 600);
  fs.rmSync(dir, { recursive: true });
  console.log('ok  reinstall is idempotent and repairs old entries');
}

// --- an empty settings file is treated as {} --------------------------------
{
  const dir = fresh();
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(settingsOf(dir), '\n');
  await installHook(context, dir);
  assert.strictEqual(ours('PreToolUse', read(dir)).length, 1);
  fs.rmSync(dir, { recursive: true });
  console.log('ok  empty settings file');
}
