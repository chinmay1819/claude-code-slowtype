# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Slowtype makes Claude Code's file writes appear in VS Code as if typed by a person. It does not slow the model down: Claude Code hooks intercept each write, and a VS Code extension replays it with human-like pacing.

## Commands

```sh
npm run build                 # npm install + compile the extension (also copies the hook into extension/hook/)
npm test                      # build, then run every headless test suite
node test/units.mjs           # one suite (build first: tests import compiled JS from extension/out/)
node test/feel.mjs --cps 6 --expr 1.5 [file]   # preview the typing cadence in the terminal, no VS Code needed
node test/e2e-heredoc.mjs     # live test against a running Extension Development Host (not part of npm test)
```

There is no linter. `tsc` runs in strict mode and serves as the type check.

To run the extension, open `extension/` in VS Code and press F5. The Extension Development Host opens `demo/` as its workspace. On a fresh clone, run **Slowtype: Install Claude Code hook** from the command palette in that window. It writes `demo/.claude/settings.json` with an absolute path to `extension/hook/slowtype-hook.mjs`, then restart Claude Code. Run `claude` from inside `demo/`. A socket file that exists doesn't prove the host is running, because the file outlives the window. `e2e-heredoc.mjs` actually connects to check.

`demo/` is a scratch workspace: git tracks only `demo/README.md`. The generated `settings.json` (a machine-specific path) and anything a test session writes there are ignored, so don't commit them.

## Architecture

Two separate programs talk over a Unix domain socket using newline-delimited JSON, one request per connection:

- **`hook/slowtype-hook.mjs`** is the Claude Code hook. It is dependency-free so that it can be copied into the `.vsix`. It forwards the hook payload to the socket and blocks until the extension replies. **It must exit 0 on every path** (no socket, bad JSON, timeout, unknown tool) so that Claude Code carries on at full speed when VS Code is not running.
- **`extension/`** is the VS Code extension. `server.ts` runs requests one at a time from a queue, `extension.ts` sends each request to the right handler, and `animator.ts` does the typing.

Both sides compute the socket path from the project directory (a hash of it, in `tmpdir()`). The hook uses `CLAUDE_PROJECT_DIR` or `cwd`; the extension uses its first workspace folder. `socketPathFor` is **duplicated** in the hook and in `extension/src/socketPath.ts`, and must stay byte-identical. `test/socketpath.mjs` enforces this.

### Core invariant: Claude Code is the only thing that writes files

The animation never leaves anything on disk. There are two mechanisms:

- **Write / Edit / MultiEdit (`PreToolUse`, before the write):** `preview.ts` computes the file text the tool call will produce, and `animator.run` types it into the buffer. The buffer is then **reverted**, the hook exits 0, and Claude Code performs the real write. When the file doesn't exist yet, the animator creates it empty, animates, then deletes it. This avoids tripping Claude Code's read-before-overwrite check. Reverting also keeps `Edit` working, because its `old_string` is still present when the real write runs.
- **Bash (`PreToolUse` and `PostToolUse`, around the command):** Bash commands give no content to predict. On `PreToolUse`, `bash.ts` pulls candidate target paths out of the command text (redirects, `tee`, `sed -i`, `cp`/`mv`/`touch`, bare filenames) and saves their current contents. On `PostToolUse`, `diffSnapshot` finds which of them changed, and `animator.replay` rewinds the buffer to the old content, types forward, and reverts. By then the final bytes are already on disk.

Consequences when editing:
- `preview.ts` must match the real tool semantics exactly, including rejecting a non-unique `old_string` and treating MultiEdit as all-or-nothing. When it isn't sure, it returns `null` and the change is not animated, rather than showing text that won't be written. Keep this file free of `vscode` imports so it stays testable in plain Node.
- Never save a document from the animator. If the user already has unsaved changes in the file, animation is skipped, because reverting would throw them away.
- `diff.ts` computes a single changed span and moves its start back to the beginning of the line, so only the changed region is retyped.

### Pacing (`extension/src/pacing.ts`)

`Typist` models typing as bursts: identifiers type quickly, there are pauses before new lines, strings and argument lists, some keys (shifted symbols, digits, same-hand pairs) are slower, and the speed drifts slowly over time. Indentation appears instantly. It uses a seeded random generator, so a given file always types the same way. A dry run in the constructor sets a scale factor so that `charsPerSecond` is the **effective** rate including pauses; `expressiveness` changes only how uneven the timing is, not the total duration. The chunks must always join back into exactly the input text (tested), or files end up corrupted.

### Timeout chain

These limits must stay in this order: `slowtype.maxAnimationSeconds` (420s; longer changes skip animation) < hook `SLOWTYPE_MAX_MS` (570s) < Claude Code's hook `timeout` (600s, set by `install.ts`). The default speed is 10 c/s; a quick programmer types 6–8 c/s. Settings are read on every request, so changes apply to the next file. Changes to the defaults in code need a rebuild and a restart of the dev host.

## Gotchas

- The hook source is `hook/slowtype-hook.mjs`, but the installed settings point at the copy in `extension/hook/`. `npm run compile` refreshes that copy; `npm run watch` does **not**.
- The `tool_input` field names (`file_path`, `content`, `old_string`, `new_string`, `replace_all`, `edits`, `command`) aren't formally documented. Unrecognised input is skipped rather than causing an error. To record real payloads, point the hook's command at `npm run capture`; they are written to `.slowtype-payloads.jsonl`.
- Bash path detection only reads the command text. A script that writes files the command never names is not animated, and that is intended.
