/**
 * Computes the full file text a pending tool call will produce, so we can
 * animate towards it. Deliberately free of any `vscode` import: this is the
 * correctness-critical half of the extension and it needs to be testable in
 * plain Node.
 *
 * These must mirror the real Write/Edit/MultiEdit semantics. Where we can't be
 * sure the real tool will succeed (an `old_string` that doesn't match), we
 * return null and skip the animation rather than show something that won't
 * happen — Claude Code will then report the failure itself, unobscured.
 */

export type ToolName = 'Write' | 'Edit' | 'MultiEdit';

export function targetTextFor(
  toolName: ToolName,
  input: any,
  original: string
): string | null {
  switch (toolName) {
    case 'Write':
      return typeof input?.content === 'string' ? input.content : null;

    case 'Edit':
      return applyEdit(original, input);

    case 'MultiEdit': {
      if (!Array.isArray(input?.edits) || input.edits.length === 0) return null;
      let text = original;
      for (const edit of input.edits) {
        const next = applyEdit(text, edit);
        if (next === null) return null;
        text = next;
      }
      return text;
    }

    default:
      return null;
  }
}

export function applyEdit(text: string, edit: any): string | null {
  const oldString = edit?.old_string;
  const newString = edit?.new_string;
  if (typeof oldString !== 'string' || typeof newString !== 'string') return null;
  if (oldString === '') return null;
  if (oldString === newString) return null;

  if (edit.replace_all) {
    if (!text.includes(oldString)) return null;
    return text.split(oldString).join(newString);
  }

  const at = text.indexOf(oldString);
  if (at === -1) return null;
  // The real Edit tool rejects a non-unique match rather than guessing.
  if (text.indexOf(oldString, at + oldString.length) !== -1) return null;

  return text.slice(0, at) + newString + text.slice(at + oldString.length);
}
