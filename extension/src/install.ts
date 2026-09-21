import * as vscode from 'vscode';
import * as path from 'node:path';

const HOOK_ENTRY_MARKER = 'slowtype-hook.mjs';

/**
 * Merges the PreToolUse hook into the workspace's .claude/settings.json without
 * disturbing hooks the user already has. Re-running is idempotent.
 */
export async function installHook(
  context: vscode.ExtensionContext,
  projectDir: string
): Promise<void> {
  // The hook is bundled inside the extension (see the `bundle` npm script) so
  // this resolves correctly both from source and from an installed .vsix.
  const hookPath = context.asAbsolutePath(path.join('hook', 'slowtype-hook.mjs'));
  const settingsUri = vscode.Uri.file(path.join(projectDir, '.claude', 'settings.json'));

  const settings = await readJson(settingsUri);

  const entry = {
    type: 'command',
    command: `node ${JSON.stringify(hookPath)}`,
    timeout: 600,
  };

  // Write/Edit/MultiEdit only need the pre phase — we animate the pending change
  // and then let the real write land. Bash needs both: snapshot before, replay
  // the diff after, because we can't know what a command will produce.
  const wanted: Array<[string, string]> = [
    ['PreToolUse', 'Write|Edit|MultiEdit|Bash'],
    ['PostToolUse', 'Bash'],
  ];

  settings.hooks ??= {};

  for (const [event, matcher] of wanted) {
    settings.hooks[event] ??= [];

    const ours = settings.hooks[event].find((m: any) =>
      (m?.hooks ?? []).some(
        (h: any) => typeof h?.command === 'string' && h.command.includes(HOOK_ENTRY_MARKER)
      )
    );

    if (ours) {
      ours.matcher = matcher;
      ours.hooks = [entry];
    } else {
      settings.hooks[event].push({ matcher, hooks: [entry] });
    }
  }

  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(settingsUri, '..'));
  await vscode.workspace.fs.writeFile(
    settingsUri,
    Buffer.from(JSON.stringify(settings, null, 2) + '\n', 'utf8')
  );

  vscode.window.showInformationMessage(
    'Slowtype: hook installed. Restart Claude Code to pick it up.'
  );
}

async function readJson(uri: vscode.Uri): Promise<any> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString('utf8').trim();
    return text ? JSON.parse(text) : {};
  } catch {
    return {}; // missing or unreadable: start fresh rather than fail the install
  }
}
