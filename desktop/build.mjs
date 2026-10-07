import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildDestination } from './build-path.mjs';

const require = createRequire(import.meta.url);
const { iconPng, iconIco } = require('./icon.cjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = buildDestination(root, process.argv.slice(2));
const electronRoot = dirname(require.resolve('electron/package.json'));
const electronDist = join(electronRoot, 'dist');
const electronVersion = JSON.parse(readFileSync(join(electronRoot, 'package.json'), 'utf8')).version;
const project = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const nodeExecutable = resolve(process.env.PCOS_DESKTOP_NODE_PATH || process.execPath);
const nodeVersion = execFileSync(nodeExecutable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
const nodeArchitecture = execFileSync(nodeExecutable, ['-p', 'process.arch'], { encoding: 'utf8', windowsHide: true }).trim();
const nodeParts = /^v(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion);

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前便携版构建需要 Windows x64。');
if (!nodeParts || Number(nodeParts[1]) !== 24 || Number(nodeParts[2]) < 16 || nodeArchitecture !== 'x64') throw new Error('请使用 Windows x64 Node 24.16 或更新的 24.x 构建桌面版。');
if (electronVersion !== '44.4.5' || !existsSync(join(electronDist, 'electron.exe'))) throw new Error('需要完整安装 Electron 44.4.5 的 Windows 运行文件。');
if (!existsSync(join(root, 'dist', 'index.html'))) throw new Error('请先构建网页界面，再构建桌面版。');

// Every bundle uses a new destination. No old bundle, private ledger or local file is merged.
mkdirSync(destination, { recursive: true });
for (const name of readdirSync(electronDist)) {
  if (name === 'electron.exe') continue;
  cpSync(join(electronDist, name), join(destination, name), { recursive: true, force: true });
}
const executable = join(destination, '人生驾驶舱.exe');
copyFileSync(join(electronDist, 'electron.exe'), executable);
const applicationPng = iconPng(256);
const applicationIco = iconIco();
writeFileSync(join(destination, 'icon.ico'), applicationIco);
const windowsPowerShell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
execFileSync(windowsPowerShell, [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'desktop', 'set-executable-icon.ps1'),
  '-ExecutablePath', executable, '-IconPath', join(destination, 'icon.ico'),
], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
const appRoot = join(destination, 'resources', 'app');
const backendRoot = join(destination, 'resources', 'backend');
const runtimeRoot = join(destination, 'resources', 'runtime');
mkdirSync(appRoot, { recursive: true });
mkdirSync(backendRoot, { recursive: true });
mkdirSync(runtimeRoot, { recursive: true });
for (const name of ['main.cjs', 'preload.cjs', 'widget-state.cjs', 'widget-companion.cjs', 'widget-companion-options.cjs', 'launch-widget.cjs', 'config.cjs', 'service.cjs', 'service-identity.cjs', 'icon.cjs']) copyFileSync(join(root, 'desktop', name), join(appRoot, name));
writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: project.name + '-desktop', productName: '人生驾驶舱', version: project.version, main: 'main.cjs', private: true }, null, 2) + '\n', 'utf8');
// All desktop surfaces use the same original compass artwork generated from code.
writeFileSync(join(appRoot, 'icon.png'), applicationPng);
for (const name of ['server', 'shared', 'dist']) cpSync(join(root, name), join(backendRoot, name), {
  recursive: true, force: true,
  filter: source => !['data', 'backups', 'node_modules'].includes(source.split(/[\\/]/).at(-1)),
});
writeFileSync(join(backendRoot, 'package.json'), JSON.stringify({ name: project.name + '-backend', version: project.version, type: 'module', private: true }, null, 2) + '\n', 'utf8');
copyFileSync(nodeExecutable, join(runtimeRoot, 'node.exe'));
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  if (!existsSync(join(root, name))) throw new Error(`Required public release license is missing: ${name}`);
  copyFileSync(join(root, name), join(destination, name === 'LICENSE' ? 'LICENSE.life-cockpit.txt' : name));
}
if (!existsSync(join(destination, 'LICENSE')) || !existsSync(join(destination, 'LICENSES.chromium.html'))) throw new Error('Electron and Chromium licenses must be retained in the release.');
const widgetVbs = [
  'Option Explicit',
  'Dim files, base, nodePath, launcherPath, command',
  'Set files = CreateObject("Scripting.FileSystemObject")',
  'base = files.GetParentFolderName(WScript.ScriptFullName)',
  'nodePath = files.BuildPath(base, "resources\\runtime\\node.exe")',
  'launcherPath = files.BuildPath(base, "resources\\app\\launch-widget.cjs")',
  'If Not files.FileExists(nodePath) Or Not files.FileExists(launcherPath) Then',
  '  MsgBox "请保留完整的人生驾驶舱程序文件夹。", 48, "桌面小组件"',
  '  WScript.Quit 1',
  'End If',
  'command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & launcherPath & Chr(34)',
  'CreateObject("WScript.Shell").Run command, 0, False',
  '',
].join('\r\n');
writeFileSync(join(destination, '打开桌面小组件.vbs'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(widgetVbs, 'utf16le')]));

const localLicense = [join(dirname(nodeExecutable), 'LICENSE'), join(dirname(nodeExecutable), 'LICENSE.txt')].find(existsSync);
let nodeLicense;
if (localLicense) nodeLicense = readFileSync(localLicense, 'utf8');
else {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${nodeVersion}/LICENSE`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`无法取得 ${nodeVersion} 的 Node 许可证，请保留构建目录并重试。`);
  nodeLicense = await response.text();
}
if (!nodeLicense.includes('Node.js') || !nodeLicense.includes('Permission is hereby granted')) throw new Error('Node 许可证内容无效，未宣告构建完成。');
writeFileSync(join(runtimeRoot, 'LICENSE'), nodeLicense, 'utf8');

const manifest = {
  app: '人生驾驶舱', version: project.version, builtAt: new Date().toISOString(), platform: 'win32-x64',
  electron: electronVersion, node: nodeVersion, executable: '人生驾驶舱.exe',
  ledgerBundled: false, nodeSha256: createHash('sha256').update(readFileSync(join(runtimeRoot, 'node.exe'))).digest('hex'),
};
writeFileSync(join(destination, 'build-info.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
writeFileSync(join(destination, '使用说明.txt'), [
  `人生驾驶舱 ${project.version} · Windows 便携版`, '',
  '双击“人生驾驶舱.exe”即可打开，无需单独安装 Node。请保留整个 windows 文件夹，不能只移动 exe。',
  '首次运行选择“建立新账本”，随后可建立自己的工作台或体验示例。也可手动打开已有账本文件夹。此程序包不包含账本、备份或密钥。',
  '桌面设置保存在当前用户的 AppData/Roaming/LifeCockpit/desktop-settings.json；新账本默认保存在同目录下的 data 文件夹。',
  '关闭窗口会收起到系统托盘，正在进行的专注继续计时。右键托盘选择“暂停并退出”，会先保存并暂停当前专注。',
  '双击“打开桌面小组件.vbs”即可打开；右键托盘可显示或隐藏小组件、切换置顶。小组件位置与可见偏好会自动保存，关闭小组件不会暂停计时。',
  '进入睡眠时会按睡眠前的时刻暂停专注；恢复后如暂停未能确认会提示核对。突发断电或后台异常后，也请核对未完成计时。',
  '更新时解压到新的程序文件夹，退出旧版本后再打开新版本。相同 Windows 账户会继续使用已保存的账本设置。请始终保留所选账本目录、相邻 backups 目录以及账本内密钥文件。',
  'Life Cockpit、Node、Electron 和 Chromium 许可证分别位于 LICENSE.life-cockpit.txt、resources/runtime/LICENSE、LICENSE 和 LICENSES.chromium.html。其他资源许可见 THIRD_PARTY_NOTICES.md。',
  '',
].join('\r\n'), 'utf8');
const forbidden = ['data', 'backups', 'node_modules'].filter(name => existsSync(join(backendRoot, name)));
if (forbidden.length) throw new Error(`构建目录中出现了不应打包的目录：${forbidden.join('、')}。请人工核对。`);
console.log(JSON.stringify({ executable, appVersion: project.version, electronVersion, nodeVersion, sizeBytes: statSync(executable).size, ledgerBundled: false }, null, 2));
