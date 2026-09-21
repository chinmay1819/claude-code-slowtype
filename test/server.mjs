// The extension's socket server: one request per connection, handled strictly
// one at a time, always answered. server.ts only uses `vscode` for types, so
// the compiled output runs in plain Node.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HookServer } = require('../extension/out/server.js');
const { socketPathFor } = require('../extension/out/socketPath.js');

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slowtype-server-test-'));
const sockPath = socketPathFor(projectDir);

const logLines = [];
const log = { appendLine: (l) => logLines.push(l) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const events = [];
let handler = async () => {};
const server = new HookServer(projectDir, (req) => handler(req), log);

// A socket file left by a window that didn't shut down cleanly must not stop
// the server from binding.
fs.writeFileSync(sockPath, 'stale');
server.start();
for (let i = 0; i < 100 && !logLines.some((l) => l.startsWith('listening')); i++) await sleep(10);
assert.ok(logLines.some((l) => l.startsWith('listening')), `server must bind over a stale file (log: ${logLines})`);

/** Send raw bytes (possibly in pieces) and collect the full reply. */
function send(pieces) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    let reply = '';
    sock.on('connect', async () => {
      for (const p of [].concat(pieces)) {
        sock.write(p);
        await sleep(20);
      }
    });
    sock.on('data', (c) => { reply += c; });
    sock.on('end', () => resolve(reply));
    sock.on('error', reject);
  });
}
const req = (obj) => JSON.stringify(obj) + '\n';

// --- a request is handled and answered --------------------------------------
{
  const seen = [];
  handler = async (r) => { seen.push(r); };
  const reply = await send(req({ tool_name: 'Write', n: 1 }));
  assert.strictEqual(reply, '{"status":"done"}\n');
  assert.deepStrictEqual(seen, [{ tool_name: 'Write', n: 1 }]);
  console.log('ok  request handled and answered');
}

// --- a request split across TCP chunks is reassembled -----------------------
{
  const seen = [];
  handler = async (r) => { seen.push(r); };
  const whole = req({ tool_name: 'Write', content: 'x'.repeat(50) });
  const reply = await send([whole.slice(0, 10), whole.slice(10, 30), whole.slice(30)]);
  assert.strictEqual(reply, '{"status":"done"}\n');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].content, 'x'.repeat(50));
  console.log('ok  chunked request reassembled');
}

// --- requests never overlap -------------------------------------------------
{
  handler = async (r) => {
    events.push(`start ${r.n}`);
    await sleep(150);
    events.push(`end ${r.n}`);
  };
  const a = send(req({ n: 1 }));
  await sleep(30); // make sure #1 is queued first
  const b = send(req({ n: 2 }));
  const c = send(req({ n: 3 }));
  const replies = await Promise.all([a, b, c]);
  assert.ok(replies.every((r) => r === '{"status":"done"}\n'), 'every connection is answered');
  assert.deepStrictEqual(events.slice(0, 2), ['start 1', 'end 1'], 'first request runs alone');
  for (let i = 0; i < events.length; i += 2) {
    const n = events[i].split(' ')[1];
    assert.strictEqual(events[i + 1], `end ${n}`, `animations must not overlap: ${events}`);
  }
  console.log('ok  requests are serialised');
}

// --- bad JSON is refused without reaching the handler -----------------------
{
  let called = false;
  handler = async () => { called = true; };
  const reply = await send('{nope\n');
  assert.strictEqual(reply, '{"status":"skipped"}\n');
  assert.strictEqual(called, false);
  console.log('ok  bad JSON answered with skipped');
}

// --- a failing handler still answers, and doesn't poison the queue ----------
{
  handler = async () => { throw new Error('boom'); };
  assert.strictEqual(await send(req({})), '{"status":"done"}\n');
  assert.ok(logLines.some((l) => l.includes('animation failed') && l.includes('boom')), 'failure is logged');

  let ran = false;
  handler = async () => { ran = true; };
  assert.strictEqual(await send(req({})), '{"status":"done"}\n');
  assert.ok(ran, 'the next request still runs');
  console.log('ok  handler failure is contained');
}

// --- a hook that gives up mid-animation doesn't break the server ------------
{
  let release;
  handler = () => new Promise((r) => { release = r; });
  const sock = net.createConnection(sockPath);
  sock.on('error', () => {});
  await new Promise((r) => sock.on('connect', r));
  sock.write(req({ n: 'abandoned' }));
  await sleep(50);
  sock.destroy(); // the hook hit its cap and left
  release();

  handler = async () => {};
  assert.strictEqual(await send(req({})), '{"status":"done"}\n');
  console.log('ok  abandoned connection is tolerated');
}

// --- dispose removes the socket ---------------------------------------------
server.dispose();
assert.ok(!fs.existsSync(sockPath), 'dispose removes the socket file');
server.dispose(); // idempotent
fs.rmSync(projectDir, { recursive: true, force: true });
console.log('ok  dispose cleans up');
