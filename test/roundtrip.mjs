// Proves the hook blocks for the duration of an "animation" and then exits 0,
// using a stand-in for the VS Code extension. No editor required.
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import assert from 'node:assert';
import { socketPathFor } from '../extension/out/socketPath.js';

const projectDir = process.cwd();
const sockPath = socketPathFor(projectDir);
try { fs.unlinkSync(sockPath); } catch {}

const ANIMATION_MS = 1500;
let received = null;

const server = net.createServer((sock) => {
  sock.on('data', (chunk) => {
    received = JSON.parse(chunk.toString().split('\n')[0]);
    setTimeout(() => sock.end('{"status":"done"}\n'), ANIMATION_MS);
  });
});

await new Promise((r) => server.listen(sockPath, r));

async function runHook(payload) {
  received = null;
  const start = Date.now();
  const child = spawn('node', ['hook/slowtype-hook.mjs'], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise((r) => child.on('exit', r));
  return { code, elapsed: Date.now() - start, received };
}

// --- Write: blocks for the animation, forwards the payload intact ----------
{
  const r = await runHook({
    session_id: 's1',
    cwd: projectDir,
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: `${projectDir}/src/demo.ts`, content: 'export const x = 1;\n' },
  });
  assert.strictEqual(r.code, 0, 'hook must exit 0');
  assert.ok(r.received, 'extension must receive the request');
  assert.strictEqual(r.received.tool_name, 'Write');
  assert.strictEqual(r.received.tool_input.content, 'export const x = 1;\n');
  assert.strictEqual(r.received.hook_event_name, 'PreToolUse');
  assert.strictEqual(r.received.session_id, 's1');
  assert.ok(r.elapsed >= ANIMATION_MS, `must block for the animation (waited ${r.elapsed}ms)`);
  console.log(`ok  Write blocked ${r.elapsed}ms, payload intact, exit 0`);
}

// --- Bash: both phases are forwarded, carrying the command -----------------
for (const event of ['PreToolUse', 'PostToolUse']) {
  const r = await runHook({
    session_id: 's2',
    cwd: projectDir,
    hook_event_name: event,
    tool_name: 'Bash',
    tool_input: { command: "cat > out.ts <<'EOF'\nx\nEOF" },
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.received, `${event} Bash must be forwarded`);
  assert.strictEqual(r.received.hook_event_name, event);
  assert.ok(r.received.tool_input.command.includes('out.ts'));
  console.log(`ok  Bash ${event} forwarded`);
}

// --- Bash with no command, and read-only tools, are not forwarded ----------
for (const payload of [
  { cwd: projectDir, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} },
  { cwd: projectDir, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.ts' } },
  { cwd: projectDir, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'a.ts', content: 'x' } },
]) {
  const r = await runHook(payload);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.received, null, `${payload.tool_name}/${payload.hook_event_name} must not be forwarded`);
}
console.log('ok  irrelevant events are ignored');

server.close();
try { fs.unlinkSync(sockPath); } catch {}
