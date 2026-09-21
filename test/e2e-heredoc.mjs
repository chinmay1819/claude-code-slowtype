#!/usr/bin/env node
// End-to-end test against the LIVE extension in the Extension Development Host.
// Simulates exactly what Claude Code does for a heredoc write:
//
//   PreToolUse(Bash)  -> extension snapshots the target
//   <the command runs, really writing the file>
//   PostToolUse(Bash) -> extension replays the change into the editor
//
// Watch the dev-host window while this runs.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import net from 'node:net';
import { socketPathFor } from '../extension/out/socketPath.js';

const projectDir = path.resolve('demo');
const target = path.join(projectDir, 'greet.ts');
const sock = socketPathFor(projectDir);

// The socket *file* outlives the VS Code window that created it, so existence
// proves nothing. Actually connect. (The hook swallows this error on purpose,
// which is exactly why this test has to check separately.)
const listening = await new Promise((resolve) => {
  const c = net.createConnection(sock);
  c.on('connect', () => { c.destroy(); resolve(true); });
  c.on('error', () => resolve(false));
});
if (!listening) {
  console.error(`Nothing is listening at ${sock}`);
  console.error('The Extension Development Host is not running. Open extension/ in VS Code');
  console.error('and press F5; it opens the demo/ folder automatically.');
  process.exit(1);
}
console.log(`extension socket: ${sock}`);

const CONTENT = `export interface Greeting {
  name: string;
  formal: boolean;
}

export function greet({ name, formal }: Greeting): string {
  const opener = formal ? 'Good evening' : 'Hey';
  return \`\${opener}, \${name}!\`;
}
`;

// The command Claude Code would actually run.
const command = `cat > ${JSON.stringify(target)} <<'SLOWEOF'\n${CONTENT}SLOWEOF`;

const hook = (payload) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('node', ['extension/hook/slowtype-hook.mjs'], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.stdin.end(JSON.stringify(payload));
    child.on('exit', (code) => resolve({ code, ms: Date.now() - started }));
  });

const base = {
  session_id: 'e2e-heredoc',
  cwd: projectDir,
  tool_name: 'Bash',
  tool_input: { command },
};

// Start from a clean slate so this is a file *creation*.
fs.rmSync(target, { force: true });

const pre = await hook({ ...base, hook_event_name: 'PreToolUse' });
console.log(`PreToolUse  exit=${pre.code} ${pre.ms}ms  (snapshot taken)`);

execSync(command, { shell: '/bin/bash' });
const onDisk = fs.readFileSync(target, 'utf8');
console.log(`command ran, wrote ${onDisk.length} bytes`);

console.log('PostToolUse ... watch VS Code now');
const post = await hook({ ...base, hook_event_name: 'PostToolUse' });
console.log(`PostToolUse exit=${post.code} ${post.ms}ms`);

// The whole point: the animation must not have altered the file.
const after = fs.readFileSync(target, 'utf8');
if (after !== CONTENT) {
  console.error('FAIL: file on disk was modified by the animation');
  process.exit(1);
}

const animated = post.ms > 1000;
console.log(`\n${animated ? 'PASS' : 'INCONCLUSIVE'}: disk content intact, ` +
  `PostToolUse blocked ${post.ms}ms`);
if (!animated) {
  console.log('PostToolUse returned immediately — the extension did not animate.');
  console.log('Most likely the dev host is running the old build: reload it with Cmd+R.');
}
