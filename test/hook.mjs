// The hook's hard rule: it must exit 0 on every path and never stall Claude
// Code. roundtrip.mjs covers the happy path; this covers the failure paths and
// which payloads get forwarded at all.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert';
import { socketPathFor } from '../extension/out/socketPath.js';

// A project dir of our own, so this suite never shares a socket with
// roundtrip.mjs or a real Extension Development Host.
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slowtype-hook-test-'));
const sockPath = socketPathFor(projectDir);

// Tests may run inside a Claude Code session, which sets CLAUDE_PROJECT_DIR
// and would silently redirect the hook to a different socket.
const baseEnv = { ...process.env };
delete baseEnv.CLAUDE_PROJECT_DIR;
delete baseEnv.SLOWTYPE_DEBUG_LOG;

function runHook(stdin, env = {}) {
  const start = Date.now();
  const child = spawn('node', ['hook/slowtype-hook.mjs'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...baseEnv, ...env },
  });
  let stdout = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stdin.end(stdin);
  return new Promise((r) =>
    child.on('exit', (code) => r({ code, stdout, elapsed: Date.now() - start }))
  );
}

/** A stand-in extension. `reply` decides what to do with each request. */
async function withServer(reply, fn, at = sockPath) {
  try { fs.unlinkSync(at); } catch {}
  const received = [];
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('error', () => {});
    sock.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl));
      received.push(req);
      reply(sock, req);
    });
  });
  await new Promise((r) => server.listen(at, r));
  try {
    return await fn(received);
  } finally {
    await new Promise((r) => server.close(r));
    try { fs.unlinkSync(at); } catch {}
  }
}

const done = (sock) => sock.end('{"status":"done"}\n');
const payload = (over = {}) => JSON.stringify({
  session_id: 's',
  cwd: projectDir,
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: `${projectDir}/src/a.ts`, content: 'x\n' },
  ...over,
});

// --- failure paths: exit 0, quickly, with no stdout ------------------------
try { fs.unlinkSync(sockPath); } catch {}

for (const [name, stdin] of [
  ['empty stdin', ''],
  ['malformed JSON', '{not json'],
  ['JSON null', 'null'],
  ['JSON array', '[]'],
  ['no cwd and no project dir', JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/a.ts', content: '' } })],
  ['nothing listening', payload()],
]) {
  const r = await runHook(stdin);
  assert.strictEqual(r.code, 0, `${name}: must exit 0`);
  assert.strictEqual(r.stdout, '', `${name}: must print nothing (no permission decision)`);
  assert.ok(r.elapsed < 1500, `${name}: must not stall (took ${r.elapsed}ms)`);
}
console.log('ok  hook exits 0 on bad input and with no extension');

{
  // A socket file left behind by a closed VS Code window: the file exists but
  // nobody is listening, so connect() fails.
  fs.writeFileSync(sockPath, '');
  const r = await runHook(payload());
  assert.strictEqual(r.code, 0);
  assert.ok(r.elapsed < 1500, `stale socket must not stall (took ${r.elapsed}ms)`);
  fs.unlinkSync(sockPath);
  console.log('ok  stale socket file is harmless');
}

// Extension accepts the request, then hangs forever: the hook's own cap fires.
await withServer(() => {}, async (received) => {
  const r = await runHook(payload(), { SLOWTYPE_MAX_MS: '400' });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(received.length, 1, 'request was delivered');
  assert.ok(r.elapsed >= 400, `must wait for the cap (took ${r.elapsed}ms)`);
  assert.ok(r.elapsed < 3000, `must give up at the cap (took ${r.elapsed}ms)`);
  console.log(`ok  hung extension is abandoned at SLOWTYPE_MAX_MS (${r.elapsed}ms)`);
});

// Extension closes the connection without replying (e.g. it crashed mid-animation).
await withServer((sock) => sock.destroy(), async () => {
  const r = await runHook(payload());
  assert.strictEqual(r.code, 0);
  assert.ok(r.elapsed < 1500, `dropped connection must not stall (took ${r.elapsed}ms)`);
  console.log('ok  dropped connection exits 0');
});

// Extension replies with something that isn't JSON: completion is the newline.
await withServer((sock) => sock.end('garbage\n'), async () => {
  const r = await runHook(payload());
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
});

// --- what gets forwarded ---------------------------------------------------
await withServer(done, async (received) => {
  const forwarded = async (over) => {
    const before = received.length;
    const r = await runHook(payload(over));
    assert.strictEqual(r.code, 0);
    return received.length > before ? received[received.length - 1] : null;
  };

  // Edit and MultiEdit are forwarded like Write.
  for (const tool_name of ['Edit', 'MultiEdit']) {
    const req = await forwarded({ tool_name, tool_input: { file_path: `${projectDir}/a.ts`, edits: [] } });
    assert.ok(req, `${tool_name} must be forwarded`);
    assert.strictEqual(req.tool_name, tool_name);
  }

  // The wire format the extension relies on.
  {
    const req = await forwarded({});
    assert.strictEqual(req.v, 1, 'protocol version is sent');
    assert.strictEqual(req.cwd, projectDir);
  }

  // A payload with no hook_event_name is treated as PreToolUse.
  {
    const raw = JSON.parse(payload());
    delete raw.hook_event_name;
    const before = received.length;
    await runHook(JSON.stringify(raw));
    assert.strictEqual(received.length, before + 1, 'missing event name defaults to PreToolUse');
    assert.strictEqual(received.at(-1).hook_event_name, 'PreToolUse');
  }

  // Generated and binary files are never animated.
  for (const p of [
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock',
    'dist/app.min.js', 'site.min.css', 'logo.png', 'photo.JPG', 'font.woff2',
    'node_modules/x/index.js', '.git/config', 'dist/index.js', 'build/a.ts',
    'out/extension.js', 'pkg/__pycache__/m.py',
  ]) {
    const req = await forwarded({ tool_input: { file_path: `${projectDir}/${p}`, content: 'x' } });
    assert.strictEqual(req, null, `${p} must not be forwarded`);
  }
  // …but a name that merely contains a denied word is fine.
  assert.ok(await forwarded({ tool_input: { file_path: `${projectDir}/src/distance.ts`, content: 'x' } }),
    'src/distance.ts must be forwarded');

  // Malformed tool_input is skipped rather than forwarded.
  for (const tool_input of [null, 'str', { content: 'x' }, { file_path: 42 }]) {
    assert.strictEqual(await forwarded({ tool_input }), null, `tool_input ${JSON.stringify(tool_input)} is skipped`);
  }
  assert.strictEqual(await forwarded({ tool_name: 'Bash', hook_event_name: 'Notification', tool_input: { command: 'ls' } }),
    null, 'Bash outside Pre/PostToolUse is skipped');
  assert.strictEqual(await forwarded({ tool_name: 'Bash', tool_input: { command: 42 } }), null,
    'non-string Bash command is skipped');
  console.log('ok  hook forwards only animatable payloads');
});

// CLAUDE_PROJECT_DIR wins over the payload's cwd when choosing the socket.
{
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'slowtype-hook-cwd-'));
  await withServer(done, async (received) => {
    await runHook(payload({ cwd: other }), { CLAUDE_PROJECT_DIR: projectDir });
    assert.strictEqual(received.length, 1, 'CLAUDE_PROJECT_DIR picks the socket');
    assert.strictEqual(received[0].cwd, other, 'the real cwd is still reported');
  });
  fs.rmSync(other, { recursive: true, force: true });
  console.log('ok  CLAUDE_PROJECT_DIR takes precedence over cwd');
}

// SLOWTYPE_DEBUG_LOG captures the raw payload, even ones that are skipped.
{
  const log = path.join(projectDir, 'payloads.jsonl');
  const raw = payload({ tool_name: 'Read' });
  const r = await runHook(raw, { SLOWTYPE_DEBUG_LOG: log });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(fs.readFileSync(log, 'utf8'), raw + '\n');
  console.log('ok  debug log captures payloads');
}

fs.rmSync(projectDir, { recursive: true, force: true });
