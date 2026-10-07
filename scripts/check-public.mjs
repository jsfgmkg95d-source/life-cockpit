import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const excluded = new Set(['.git', 'node_modules', 'dist', 'data', 'backups', '.runtime', 'output', 'tmp', 'release', 'test-results']);
function walk(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return excluded.has(entry.name) ? [] : walk(join(directory, entry.name), `${name}/`);
    return [name];
  });
}
let files;
try { files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); }
catch { files = walk(root); }
if (!files.length) files = walk(root);
const checks = [
  ['private user path', /[A-Z]:[\\/]+Users[\\/]+(?!Public\b)[^\s"'<>]+/i],
  ['private workspace path', /[A-Z]:[\\/]+AI_Workspace[\\/]+/i],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['access token', /\b(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{24,}\b/],
  ['API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{36,}\b/],
];
const privateIndex = process.argv.indexOf('--private-pattern-file');
if (privateIndex >= 0) {
  const privatePatterns = JSON.parse(readFileSync(process.argv[privateIndex + 1], 'utf8'));
  for (const pattern of privatePatterns) checks.push(['private release pattern', new RegExp(pattern, 'iu')]);
}
const binaryExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff2', '.mp4']);
const findings = [];
for (const name of files) {
  if (name.split('/').some(part => excluded.has(part)) || /(?:\.sqlite(?:-wal|-shm)?|\.db|\.log|\.env(?:\..*)?|\.tsbuildinfo)$/i.test(name)) {
    findings.push({ file: name, rule: 'runtime or sensitive file' }); continue;
  }
  const file = join(root, name);
  if (lstatSync(file).isSymbolicLink()) { findings.push({ file: name, rule: 'symbolic link' }); continue; }
  if (binaryExtensions.has(extname(name))) continue;
  const content = readFileSync(file, 'utf8');
  for (const [rule, expression] of checks) if (expression.test(content)) findings.push({ file: name, rule });
}
// Report locations only; never print a matching credential or private value.
console.log(JSON.stringify({ checkedFiles: files.length, findings }, null, 2));
if (findings.length) process.exitCode = 1;
