// Paths resolve against the project root, not the working directory.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function fromRoot(...segments) {
  return path.join(ROOT, ...segments);
}
