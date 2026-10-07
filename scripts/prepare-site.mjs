import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, '.runtime', 'site');
mkdirSync(resolve(output, 'assets'), { recursive: true });
copyFileSync(resolve(root, 'site', 'index.html'), resolve(output, 'index.html'));
copyFileSync(resolve(root, 'docs', 'images', 'today.jpg'), resolve(output, 'assets', 'today.jpg'));
copyFileSync(resolve(root, 'public', 'life-cockpit.svg'), resolve(output, 'assets', 'life-cockpit.svg'));
console.log('Static introduction page prepared in .runtime/site');
