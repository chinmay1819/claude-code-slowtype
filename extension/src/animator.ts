import * as vscode from 'vscode';
import { changedSpan, Span } from './diff';
import { Typist, estimateMs, PacingOptions } from './pacing';
import { targetTextFor, ToolName } from './preview';

export interface Request {
  tool_name: ToolName;
  tool_input: any;
}

/** A change that has ALREADY happened on disk, to be replayed retroactively. */
export interface Replay {
  filePath: string;
  /** Content before the change, or null if the file was created. */
  before: string | null;
  /** Content now on disk. */
  after: string;
}

export interface Session {
  /** Ask the current animation to finish immediately. */
  fastForward(): void;
}

/**
 * Animates a pending file change into a real editor, then restores the document
 * to exactly the state it was in beforehand.
 *
 * The restore is the important half. Claude Code performs the genuine write
 * moments later, so if we left our animated text behind, Edit would fail to
 * find its `old_string` and Write would trip the read-before-overwrite check.
 * By reverting, Claude Code remains the only thing that ever mutates the file.
 */
export class Animator {
  private skipping = false;
  private current: { cancel: () => void } | null = null;

  constructor(
    private readonly opts: () => PacingOptions & { maxAnimationMs: number },
    private readonly status: {
      show(file: string): void;
      hide(): void;
    }
  ) {}

  fastForward() {
    this.current?.cancel();
  }

  /** Suppress animation for everything still queued in this agent turn. */
  skipAll() {
    this.skipping = true;
    this.fastForward();
  }

  resume() {
    this.skipping = false;
  }

  async run(req: Request): Promise<void> {
    if (this.skipping) return;

    const filePath: string = req.tool_input?.file_path;
    if (!filePath) return;

    const uri = vscode.Uri.file(filePath);
    const existed = await exists(uri);

    // A file Claude is about to create doesn't exist yet, so there is nothing to
    // open. Create it empty, animate into it, then delete it again — leaving the
    // filesystem exactly as we found it for the real Write.
    if (!existed) {
      await vscode.workspace.fs.writeFile(uri, new Uint8Array());
    }

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      if (!existed) await safeDelete(uri);
      return;
    }

    // If the user has unsaved edits in this file, stay out of the way entirely.
    // Reverting at the end would destroy their work.
    if (doc.isDirty) return;

    const original = doc.getText();
    const target = targetTextFor(req.tool_name, req.tool_input, original);
    if (target === null) {
      if (!existed) await safeDelete(uri);
      return;
    }

    const span = changedSpan(original, target);
    if (!span) {
      if (!existed) await safeDelete(uri);
      return;
    }

    const pacing = this.opts();
    if (estimateMs(span.insert, pacing) > pacing.maxAnimationMs) {
      // Too big to sit through. Showing the file is still useful context.
      await vscode.window.showTextDocument(doc, { preview: false });
      if (!existed) await safeDelete(uri);
      return;
    }

    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    this.status.show(vscode.workspace.asRelativePath(uri));

    try {
      await this.type(editor, span, pacing);
    } finally {
      this.status.hide();
      // Restore. Order matters: discard the dirty buffer first, then remove the
      // file if we were the ones who created it.
      await revert(editor);
      if (!existed) await safeDelete(uri);
    }
  }

  /**
   * Replays a change that has already landed on disk (a Bash write).
   *
   * Unlike `run`, this never touches the filesystem: it rewinds the *buffer* to
   * the pre-change content, types forward to what disk already holds, then
   * reverts. The file on disk is identical throughout.
   */
  async replay(change: Replay): Promise<void> {
    if (this.skipping) return;

    const uri = vscode.Uri.file(change.filePath);

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      return;
    }
    if (doc.isDirty) return; // user has unsaved work here; leave it alone

    const before = change.before ?? '';
    const span = changedSpan(before, change.after);
    if (!span) return;

    const pacing = this.opts();
    if (estimateMs(span.insert, pacing) > pacing.maxAnimationMs) return;

    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    // Rewind the buffer to the pre-change state. Dirty, unsaved — disk keeps the
    // real content, and the revert in `finally` restores the buffer to it.
    const whole = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length)
    );
    const rewound = await editor.edit((b) => b.replace(whole, before), NO_UNDO_STOP);
    if (!rewound) return;

    this.status.show(vscode.workspace.asRelativePath(uri));
    try {
      await this.type(editor, span, pacing);
    } finally {
      this.status.hide();
      await revert(editor);
    }
  }

  /** Emit `span.insert` into the editor a few characters at a time. */
  private async type(
    editor: vscode.TextEditor,
    span: Span,
    pacing: PacingOptions
  ): Promise<void> {
    const doc = editor.document;
    const text = span.insert;

    // Clear the region being replaced up front, so the viewer sees the old code
    // disappear and the new code arrive in its place — the way a person deletes
    // a block before retyping it.
    const region = new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end));
    await editor.edit((b) => b.delete(region), NO_UNDO_STOP);

    let cancelled = false;
    this.current = { cancel: () => { cancelled = true; } };

    const typist = new Typist(text, pacing);

    try {
      while (!typist.done) {
        if (cancelled) break;

        const from = typist.position;
        const { chunk, delayMs } = typist.next();
        const piece = text.slice(from, from + chunk);
        const at = doc.positionAt(span.start + from);

        const ok = await editor.edit((b) => b.insert(at, piece), NO_UNDO_STOP);
        if (!ok) break; // document changed underneath us; stop rather than corrupt

        const caret = doc.positionAt(span.start + from + chunk);
        editor.selection = new vscode.Selection(caret, caret);
        editor.revealRange(
          new vscode.Range(caret, caret),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport
        );

        await sleep(delayMs);
      }

      if (typist.position < text.length) {
        // Fast-forward (or an aborted run): drop the remainder in one edit so the
        // viewer still sees the complete result before we revert.
        const at = doc.positionAt(span.start + typist.position);
        await editor.edit((b) => b.insert(at, text.slice(typist.position)), NO_UNDO_STOP);
      }
    } finally {
      this.current = null;
    }
  }
}

const NO_UNDO_STOP = { undoStopBefore: false, undoStopAfter: false };

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function safeDelete(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { useTrash: false });
  } catch {
    /* the real Write will overwrite it anyway */
  }
}

async function revert(editor: vscode.TextEditor): Promise<void> {
  try {
    await vscode.window.showTextDocument(editor.document, { preview: false });
    await vscode.commands.executeCommand('workbench.action.files.revert');
  } catch {
    /* best effort */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
