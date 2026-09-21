# Slowtype for Claude Code

Watch Claude Code **type** its code into VS Code, character by character, instead
of files appearing fully-formed. Built for pair-programming: you can read along,
follow what it's doing, and interrupt.

```
┌──────────────┬────────────────────────────┐
│ EXPLORER     │ src/auth.ts             ●  │
│  src/        │ 12  export async function  │
│   auth.ts ●  │ 13    const token = awai█  │
└──────────────┴────────────────────────────┘
                  ⌨ typing src/auth.ts
```

## How it works

Claude Code writes files atomically — a `Write` or `Edit` lands the whole thing in
an instant, and there is no way to make the model itself produce text slowly. So
this doesn't slow the model down. It **intercepts and replays**:

1. A `PreToolUse` hook fires on `Write`/`Edit`/`MultiEdit`. Hooks run
   synchronously and block the tool call until they exit — that block is the
   window we animate in.
2. The hook forwards the pending change to a VS Code extension over a Unix socket
   and waits.
3. The extension opens the real file, computes what the change will produce, and
   types it in with a human cadence.
4. The extension then **reverts the buffer** to exactly its prior state and
   replies. The hook exits 0, and Claude Code performs the genuine write.

The last step is the important one. Claude Code remains the only thing that ever
mutates your files; the animation is a preview that leaves no trace. That's what
keeps `Edit` working (its `old_string` is still there when it runs) and keeps the
final bytes identical to a session without Slowtype.

### Bash writes

Claude Code writes files with heredocs and redirects at least as often as it uses
`Write`, and a `Bash` call tells us nothing about what it will produce. So Bash is
handled by bracketing instead of predicting:

- `PreToolUse` — snapshot the content of every file the command names.
- `PostToolUse` — the command has run, so compare against the snapshot and replay
  each change.

Replaying after the fact is the *safer* half of this project: the final bytes are
already on disk, so the extension only rewinds the editor buffer, types forward,
and reverts. Nothing it does can affect the result.

Target files are found syntactically — redirects, `tee`, `sed -i`, `cp`/`mv`, and
bare filenames in the command. A command that writes files it never names (say
`python build.py` emitting a whole directory) is missed, and that degrades to no
animation, which is the right failure.

## Install

```sh
npm install && npm run build
```

Then load `extension/` in VS Code (F5 in the Extension Development Host, or
package it with `npx vsce package` and install the `.vsix`).

With your project open in VS Code, run **Slowtype: Install Claude Code hook**
from the command palette. It merges this into your project's
`.claude/settings.json` without touching hooks you already have:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          { "type": "command", "command": "node \"…/hook/slowtype-hook.mjs\"", "timeout": 600 }
        ]
      }
    ]
  }
}
```

Restart Claude Code to pick up the hook.

## Using it

| Command | Default key | |
|---|---|---|
| `Slowtype: Fast-forward current file` | `ctrl+alt+.` | Finish this file instantly |
| `Slowtype: Skip remaining writes` | `ctrl+alt+shift+.` | Stop animating the rest of this turn |
| `Slowtype: Set typing speed` | | Human 6 / Slow 10 / Relaxed 20 / Fast 45 c/s |
| `Slowtype: Toggle on/off` | | |

Settings:

- `slowtype.charsPerSecond` (default 10) — the **effective** average rate. For
  scale, a quick programmer types 6-8 c/s. The
  model calibrates itself so this is what you actually get, pauses included.
- `slowtype.expressiveness` (default 1) — how unevenly that time is distributed.
  0 is a flat, mechanical rate; 1.5 is a more hesitant typist. It changes the
  rhythm, not the duration.
- `slowtype.maxAnimationSeconds` (default 420) — bigger changes are applied
  without animation. Kept under Claude Code's 600s hook timeout.

## It never breaks your session

Every failure path exits 0 and lets the tool call proceed at full speed:

- **VS Code isn't running** → socket connect fails, hook exits in ~40ms.
- **Animation hangs** → the hook caps itself at `SLOWTYPE_MAX_MS` (default 570s)
  and disconnects; the extension fast-forwards.
- **You have unsaved edits in the file** → animation is skipped entirely, because
  reverting would destroy your work.
- **Malformed or unrecognised payload** → skipped.
- **Generated files** (lockfiles, `.min.js`, binaries, `node_modules`) → skipped.

## Design notes

**No fake typos.** Tempting for demos, wrong for this. You're meant to be reading
the code; a wrong character on screen is actively misleading.

**Bursts and pauses, not jitter.** The first version paced at a near-constant rate
and read as a teleprinter. Real typing is *bursty*: familiar identifiers come out
as one fast motor gesture, and then there is a genuine 200-600ms pause at the
points where the typist had to decide something. The pauses carry almost all of
the humanity. `extension/src/pacing.ts` models four effects — token bursts,
decision pauses, per-keystroke difficulty (shifted symbols are slower; same-hand
digraphs slower than alternating), and a slow drift so the typist warms up and
tires. Indentation is instant, because in a real editor it comes from auto-indent
rather than N space keystrokes.

Tune it without touching VS Code:

```sh
node test/feel.mjs                      # built-in sample
node test/feel.mjs src/animator.ts      # a real file
node test/feel.mjs --cps 30 --expr 1.6  # slower, more hesitant
```

**Single-span diffs.** When overwriting an existing file, only the changed region
is retyped, snapped back to a line boundary. A full multi-hunk diff would make the
cursor hop around; one contiguous region reads like a person editing.

## Verifying the tool payload shapes

The field names inside `tool_input` (`file_path`, `content`, `old_string`,
`new_string`, `edits`) are not formally documented. The code treats anything it
doesn't recognise as "skip", so drift degrades to no animation rather than to
breakage. To confirm them against your Claude Code version, point the hook's
command at `npm run capture`, run a session, and read `.slowtype-payloads.jsonl`.

## Tests

```sh
npm test
```

- `preview.mjs` — the text we animate towards matches real tool semantics. The
  one that matters most: if it drifts, the viewer sees a lie.
- `socketpath.mjs` — the hook and the extension independently derive the same
  socket path (they're separate programs with duplicated logic).
- `roundtrip.mjs` — the hook really does block for the animation, then exits 0.
- `bash.mjs` — which commands are recognised as file writes, and which paths are
  correctly refused (outside the project, globs, lockfiles, `/dev/null`, `2>&1`).
- `units.mjs` — diff reconstruction, and that the pacing chunks always reproduce
  the text exactly. A bug there would corrupt files.

## Not doing

- Making the model generate slowly. Not possible, and not what you want.
- Editors other than VS Code. The socket protocol is editor-agnostic, so a Neovim
  or JetBrains host could be added against the same hook.
