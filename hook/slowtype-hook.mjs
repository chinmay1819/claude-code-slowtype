#!/usr/bin/env node
// Claude Code hook for Write|Edit|MultiEdit|Bash.
//
// Write/Edit/MultiEdit (PreToolUse): blocks the tool call while the VS Code
// extension animates the pending change into a real editor, then exits 0 so
// Claude Code performs the actual write itself.
//
// Bash (PreToolUse + PostToolUse): Claude Code writes files with heredocs and
// redirects at least as often as it uses Write. We can't know what a command
// will produce, so we snapshot beforehand and replay the diff afterwards.
//
// Hard rule: this must NEVER break a Claude Code session. Every failure path —
// no VS Code, stale socket, malformed payload, animation hang — exits 0 and
// lets the tool call proceed at full speed.

import net from 'node:net';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROTOCOL_VERSION = 1;

// Kept deliberately dependency-free so this file can be copied anywhere — into
// a packaged .vsix, into a user's own hooks directory — and still run.
// MUST stay byte-identical to extension/src/socketPath.ts; the two sides find
// each other by independently deriving the same path. test/socketpath.mjs
// guards that invariant.
function socketPathFor(projectDir) {
  const hash = createHash('sha1').update(projectDir).digest('hex').slice(0, 12);
  return join(tmpdir(), `slowtype-${hash}.sock`);
}

const encode = (obj) => JSON.stringify(obj) + '\n';

// Must outlast the longest animation the extension will start (420s by default)
// yet exit before Claude Code's own 600s hook timeout kills the process.
const MAX_MS = Number(process.env.SLOWTYPE_MAX_MS ?? 570_000);
const DEBUG_LOG = process.env.SLOWTYPE_DEBUG_LOG; // capture raw payloads when set

/** Files we never animate: generated, huge, or not meant to be read. */
const DENY = [
  /\/(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$/,
  /\.min\.(js|css)$/,
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|woff2?|ttf|so|dylib|wasm)$/i,
  /\/(node_modules|\.git|dist|build|out|__pycache__)\//,
];

const bail = () => process.exit(0);

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(buf); } };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    setTimeout(done, 2000).unref(); // never hang waiting for stdin
  });
}

/**
 * Which (tool, event) pairs we care about.
 *
 * Bash needs both phases: PreToolUse to snapshot, PostToolUse to replay what
 * actually changed. Everything else only needs the pre phase.
 */
function shouldForward(toolName, event, input) {
  if (!input || typeof input !== 'object') return false;

  if (toolName === 'Bash') {
    if (event !== 'PreToolUse' && event !== 'PostToolUse') return false;
    return typeof input.command === 'string' && input.command.length > 0;
  }

  if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)) return false;
  if (event !== 'PreToolUse') return false;

  const filePath = input.file_path;
  if (typeof filePath !== 'string') return false;
  return !DENY.some((re) => re.test(filePath));
}

async function main() {
  const raw = await readStdin();
  if (DEBUG_LOG) {
    try { appendFileSync(DEBUG_LOG, raw.trim() + '\n'); } catch {}
  }

  let payload;
  try { payload = JSON.parse(raw); } catch { return bail(); }

  const { tool_name, tool_input, cwd, session_id } = payload ?? {};
  const event = payload?.hook_event_name ?? 'PreToolUse';
  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd;
  if (!projectDir || !shouldForward(tool_name, event, tool_input)) return bail();

  await new Promise((resolve) => {
    let finished = false;
    const finish = () => { if (!finished) { finished = true; resolve(); } };

    const sock = net.createConnection(socketPathFor(projectDir));
    const cap = setTimeout(() => { sock.destroy(); finish(); }, MAX_MS);
    cap.unref();

    // Any socket problem at all: VS Code isn't listening, or the extension
    // crashed. Proceed instantly rather than stalling the agent.
    sock.on('error', () => { clearTimeout(cap); finish(); });
    sock.on('close', () => { clearTimeout(cap); finish(); });

    sock.on('connect', () => {
      sock.write(encode({
        v: PROTOCOL_VERSION,
        tool_name,
        tool_input,
        hook_event_name: event,
        session_id,
        cwd: cwd || projectDir,
      }));
    });

    let inbuf = '';
    sock.on('data', (chunk) => {
      inbuf += chunk;
      if (inbuf.includes('\n')) {   // extension signalled completion
        clearTimeout(cap);
        sock.end();
        finish();
      }
    });
  });

  // Exit 0 with no stdout: no permission decision, so the tool call proceeds
  // normally. For PostToolUse there is nothing left to decide anyway.
  process.exit(0);
}

main().catch(bail);
