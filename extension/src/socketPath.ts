import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Must stay byte-identical to `shared/protocol.mjs`'s implementation — the hook
 * and the extension find each other by independently deriving the same path.
 */
export function socketPathFor(projectDir: string): string {
  const hash = createHash('sha1').update(projectDir).digest('hex').slice(0, 12);
  return join(tmpdir(), `slowtype-${hash}.sock`);
}
