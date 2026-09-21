/**
 * Minimal diffing: we only need to know which contiguous span changed, so that
 * an overwrite of an existing file animates just the new part instead of
 * retyping a file the viewer is already looking at.
 *
 * A full LCS diff would find multiple separate hunks, but a single trimmed span
 * is both cheaper and better viewing: the cursor stays in one region rather
 * than hopping around the file.
 */
export interface Span {
  /** Offset into the old text where the replaced region begins. */
  start: number;
  /** Offset into the old text where the replaced region ends. */
  end: number;
  /** Text to type in place of old[start..end). */
  insert: string;
}

export function changedSpan(oldText: string, newText: string): Span | null {
  if (oldText === newText) return null;

  const max = Math.min(oldText.length, newText.length);

  let prefix = 0;
  while (prefix < max && oldText[prefix] === newText[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }

  // Snap the start back to a line boundary. Beginning mid-line looks like a
  // rendering glitch; beginning at the start of the changed line reads as a
  // person rewriting that line.
  const start = oldText.lastIndexOf('\n', prefix - 1) + 1;

  return {
    start,
    end: oldText.length - suffix,
    insert: newText.slice(start, newText.length - suffix),
  };
}
