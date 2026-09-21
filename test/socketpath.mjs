// The hook and the extension are separate programs that must independently
// derive the same socket path, or they will never find each other. This test
// runs both implementations against the same inputs and compares.
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { socketPathFor as fromExtension } from '../extension/out/socketPath.js';

// Invoke the hook's own copy of the function, in its own process.
const fromHook = (dir) =>
  execFileSync('node', [
    '--input-type=module',
    '-e',
    `import {createHash} from 'node:crypto';import {tmpdir} from 'node:os';import {join} from 'node:path';
     const src = await import('node:fs').then(f=>f.readFileSync('hook/slowtype-hook.mjs','utf8'));
     const body = src.match(/function socketPathFor\\(projectDir\\) \\{[\\s\\S]*?\\n\\}/)[0];
     const fn = new Function('createHash','tmpdir','join', body + '; return socketPathFor;')(createHash,tmpdir,join);
     process.stdout.write(fn(${JSON.stringify(dir)}));`,
  ]).toString();

for (const dir of [
  '/Users/someone/project',
  '/tmp/a b/with spaces',
  '/very/deep/nested/path/to/a/repo',
  '/',
]) {
  assert.strictEqual(
    fromHook(dir),
    fromExtension(dir),
    `socket path disagreement for ${dir}`
  );
}

// Different projects must not collide.
assert.notStrictEqual(fromExtension('/a'), fromExtension('/b'));

console.log('ok  hook and extension agree on socket paths');
