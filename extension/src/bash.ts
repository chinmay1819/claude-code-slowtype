/**
 * Detecting file writes performed by Bash.
 *
 * `Write`/`Edit` are not the only way Claude Code writes files — it very often
 * reaches for a heredoc (`cat > f <<'EOF'`), a redirect, `tee`, or `sed -i`.
 * Those go through the `Bash` tool, which tells us nothing about what the
 * resulting file will contain, so the Write/Edit strategy of computing the
 * target text up front cannot work.
 *
 * Instead we bracket the command:
 *
 *   PreToolUse(Bash)  — snapshot the content of any file the command names.
 *   PostToolUse(Bash) — the command has run, so the new content is already on
 *                       disk. Compare against the snapshot and replay the change.
 *
 * Replaying *after the fact* turns out to be the safer half of this project.
 * The disk already holds the final bytes, so we only ever manipulate the editor
 * buffer and then revert it back to disk. Nothing we do can affect the result.
 *
 * We extract candidate paths syntactically rather than tracing the filesystem.
 * A command like `python build.py` that writes files it never names will be
 * missed — that degrades to "no animation", which is the correct failure.
 */

import * as path from 'node:path';

/** Tokens that introduce a write target. */
const REDIRECT = /(?:^|\s)(?:\d?>>?|\|\s*tee(?:\s+-a)?)\s+("[^"]+"|'[^']+'|[^\s;|&<>]+)/g;

/** `sed -i`, `sed -i.bak`, and the GNU/BSD spelling differences around it. */
const SED_INPLACE = /\bsed\b[^;|&]*?\s-i(?:\.\w+)?\b([^;|&]*)/g;

/** Commands whose final argument is a destination path. */
const DEST_ARG = /\b(?:mv|cp|install|touch)\s+([^;|&]+)/g;

/** Never animate these, whatever the command does to them. */
const DENY = [
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$/,
  /\.min\.(?:js|css)$/,
  /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|woff2?|ttf|so|dylib|wasm|lock)$/i,
  /(?:^|\/)(?:node_modules|\.git|dist|build|out|__pycache__|\.venv)(?:\/|$)/,
];

function unquote(tok: string): string {
  const t = tok.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

function plausiblePath(tok: string): boolean {
  if (!tok || tok.startsWith('-')) return false;
  if (/[*?$`(){}]/.test(tok)) return false;      // globs and substitutions: can't resolve
  if (/^\/dev\//.test(tok)) return false;
  if (tok === '&1' || tok === '&2') return false; // fd duplication, not a file
  return true;
}

/**
 * Best-effort list of absolute paths the command might write, restricted to the
 * project directory.
 */
export function candidateWrites(command: string, cwd: string, projectDir: string): string[] {
  const found = new Set<string>();

  const add = (raw: string) => {
    const tok = unquote(raw);
    if (!plausiblePath(tok)) return;

    const abs = path.resolve(cwd, tok);
    // Stay inside the project. A command writing to /etc is not ours to narrate.
    const rel = path.relative(projectDir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return;
    if (DENY.some((re) => re.test(rel))) return;

    found.add(abs);
  };

  for (const m of command.matchAll(REDIRECT)) add(m[1]);

  for (const m of command.matchAll(SED_INPLACE)) {
    // Everything after the expression that isn't a flag is a target file.
    for (const tok of m[1].split(/\s+/)) {
      if (tok && !tok.startsWith('-') && !/^['"]?s[\/|#]/.test(tok)) add(tok);
    }
  }

  for (const m of command.matchAll(DEST_ARG)) {
    const args = m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
    if (args.length) add(args[args.length - 1]);
  }

  // Bare filenames anywhere in the command — catches `python gen.py out.ts` and
  // heredoc forms the redirect pattern misses.
  for (const m of command.matchAll(/(?:^|\s)((?:[\w.\-\/]+\/)?[\w.\-]+\.[A-Za-z]{1,5})(?=\s|$|;)/g)) {
    add(m[1]);
  }

  return [...found];
}

export interface Snapshot {
  /** Absolute path → content before the command ran, or null if it didn't exist. */
  files: Map<string, string | null>;
}

export interface Change {
  filePath: string;
  before: string | null;
  after: string;
}

/** Files that actually changed, given a snapshot and the current disk state. */
export function diffSnapshot(
  snap: Snapshot,
  readNow: (p: string) => string | null
): Change[] {
  const out: Change[] = [];
  for (const [filePath, before] of snap.files) {
    const after = readNow(filePath);
    if (after === null) continue;       // deleted, or still absent
    if (after === before) continue;     // untouched
    out.push({ filePath, before, after });
  }
  return out;
}
