import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { Animator } from './animator';
import { candidateWrites, diffSnapshot, Snapshot } from './bash';
import { HookServer } from './server';
import { installHook } from './install';

// Effective characters per second. For scale: 40 wpm is ~3.3 c/s, a quick
// programmer is 6-8 c/s. Anything much above 20 stops reading as a person.
const SPEEDS: Record<string, number> = {
  'Human (6 c/s)': 6,
  'Slow (10 c/s)': 10,
  'Relaxed (20 c/s)': 20,
  'Fast (45 c/s)': 45,
};

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Slowtype');
  context.subscriptions.push(log);

  const projectDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!projectDir) {
    log.appendLine('no workspace folder; slowtype inactive');
    return;
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'slowtype.fastForward';
  status.tooltip = 'Click to finish this file instantly';
  context.subscriptions.push(status);

  const config = () => {
    const c = vscode.workspace.getConfiguration('slowtype');
    return {
      charsPerSecond: c.get<number>('charsPerSecond', 10),
      expressiveness: c.get<number>('expressiveness', 1),
      maxAnimationMs: c.get<number>('maxAnimationSeconds', 420) * 1000,
    };
  };

  const animator = new Animator(config, {
    show(file) {
      status.text = `$(keyboard) typing ${file}`;
      status.show();
    },
    hide() {
      status.hide();
    },
  });

  const enabled = () => vscode.workspace.getConfiguration('slowtype').get<boolean>('enabled', true);

  // Snapshots taken before a Bash command runs, keyed by session so concurrent
  // sessions in the same project don't clobber each other.
  const snapshots = new Map<string, Snapshot>();

  const readFileOrNull = (p: string): string | null => {
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > 2_000_000) return null;
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };

  const server = new HookServer(
    projectDir,
    async (req) => {
      if (!enabled()) return;

      const key = req.session_id ?? 'default';

      if (req.tool_name === 'Bash') {
        const command: string = req.tool_input?.command ?? '';
        const cwd: string = req.cwd ?? projectDir;

        if (req.hook_event_name === 'PreToolUse') {
          const files = new Map<string, string | null>();
          for (const p of candidateWrites(command, cwd, projectDir)) {
            files.set(p, readFileOrNull(p));
          }
          snapshots.set(key, { files });
          log.appendLine(`bash pre: watching ${files.size} path(s)`);
          return; // nothing to animate yet; don't block the command
        }

        if (req.hook_event_name === 'PostToolUse') {
          const snap = snapshots.get(key);
          snapshots.delete(key);
          if (!snap) return;

          const changes = diffSnapshot(snap, readFileOrNull);
          log.appendLine(`bash post: ${changes.length} file(s) changed`);
          for (const c of changes) {
            await animator.replay(c);
          }
        }
        return;
      }

      // Write / Edit / MultiEdit: animate before the real write lands.
      if (req.hook_event_name === 'PostToolUse') return;
      await animator.run(req);
    },
    log
  );
  server.start();
  context.subscriptions.push(server);

  context.subscriptions.push(
    vscode.commands.registerCommand('slowtype.fastForward', () => animator.fastForward()),

    vscode.commands.registerCommand('slowtype.skipAll', () => {
      animator.skipAll();
      // Auto-resume: "skip" means "stop animating what's queued", not "turn the
      // feature off" — the next prompt should animate again.
      setTimeout(() => animator.resume(), 5000);
      vscode.window.setStatusBarMessage('Slowtype: skipping remaining writes', 3000);
    }),

    vscode.commands.registerCommand('slowtype.toggle', async () => {
      const c = vscode.workspace.getConfiguration('slowtype');
      const next = !c.get<boolean>('enabled', true);
      await c.update('enabled', next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`Slowtype ${next ? 'on' : 'off'}`, 2000);
    }),

    vscode.commands.registerCommand('slowtype.setSpeed', async () => {
      const pick = await vscode.window.showQuickPick(Object.keys(SPEEDS), {
        placeHolder: 'Typing speed',
      });
      if (!pick) return;
      await vscode.workspace
        .getConfiguration('slowtype')
        .update('charsPerSecond', SPEEDS[pick], vscode.ConfigurationTarget.Global);
    }),

    vscode.commands.registerCommand('slowtype.installHook', () =>
      installHook(context, projectDir)
    )
  );
}

export function deactivate() {}
