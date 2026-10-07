import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function buildDestination(root, argv = []) {
  if (argv.length && (argv.length !== 2 || argv[0] !== '--output' || !argv[1] || argv[1].startsWith('--'))) {
    throw new Error('Usage: node desktop/build.mjs [--output <new-directory>]');
  }
  const destination = resolve(root, argv[1] || 'release/windows');
  // Never merge a release with an old bundle: deleted artwork or local files could survive.
  if (existsSync(destination)) throw new Error(`Release directory already exists: ${destination}. Choose a new --output directory.`);
  return destination;
}
