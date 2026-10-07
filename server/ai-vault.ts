import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface KeyVault { has(): boolean; read(): Promise<string | null>; save(value: string | null): Promise<void> }
export class WindowsKeyVault implements KeyVault {
  path: string; exists = false;
  constructor(path: string, exists: boolean) { this.path = path; this.exists = exists; }
  has() { return this.exists || !!process.env.OPENAI_API_KEY; }
  private crypt(value: string, decrypt: boolean): Promise<string> {
    if (process.platform !== 'win32') throw new Error('KEY_STORAGE_UNAVAILABLE');
    // Secrets go over stdin, never argv, environment, logs or PowerShell history.
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r));`;
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('KEY_STORAGE_UNAVAILABLE')); }, 10_000);
      child.stdout.on('data', part => { output += part; }); child.once('error', () => { clearTimeout(timer); reject(new Error('KEY_STORAGE_UNAVAILABLE')); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error('KEY_STORAGE_UNAVAILABLE')); }); child.stdin.on('error', () => {}); child.stdin.end(value);
    });
  }
  async read() { if (this.exists) return Buffer.from(await this.crypt(await readFile(this.path, 'utf8'), true), 'base64').toString('utf8'); return process.env.OPENAI_API_KEY || null; }
  async save(value: string | null) {
    if (value === null) { await rm(this.path, { force: true }); this.exists = false; return; }
    const encrypted = await this.crypt(Buffer.from(value).toString('base64'), false);
    await mkdir(dirname(this.path), { recursive: true }); await writeFile(this.path + '.tmp', encrypted, { mode: 0o600 }); await rename(this.path + '.tmp', this.path); this.exists = true;
  }
}
