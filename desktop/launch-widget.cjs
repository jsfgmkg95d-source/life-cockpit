// Run with the bundled Node runtime. This entry only chooses a window launcher.
const { spawn } = require('node:child_process');
const { openSync, readSync, closeSync, fstatSync, statSync } = require('node:fs');
const { isAbsolute, join, resolve } = require('node:path');
const { readConfig } = require('./config.cjs');
const { dataIdentity, isLoopbackUrl, matchesHealth } = require('./service-identity.cjs');
const { requestJson } = require('./service.cjs');

function launchOptions(argv, appRoot = __dirname, appData = process.env.APPDATA) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!['--main-executable', '--settings-dir'].includes(key) || values[key] !== undefined || typeof argv[index + 1] !== 'string' || argv[index + 1].startsWith('--')) throw new Error('小组件入口参数无效');
    values[key] = argv[index + 1];
  }
  const mainExecutable = values['--main-executable'] ?? resolve(appRoot, '..', '..', '人生驾驶舱.exe');
  const settingsDir = values['--settings-dir'] ?? (appData && join(appData, 'LifeCockpit'));
  if (!isAbsolute(mainExecutable) || !/\.exe$/i.test(mainExecutable) || !settingsDir || !isAbsolute(settingsDir)) throw new Error('主程序与设置目录必须使用绝对路径');
  return { mainExecutable: resolve(mainExecutable), settingsDir: resolve(settingsDir) };
}

function lastMainWindow(logText) {
  const matches = [...logText.matchAll(/桌面窗口已加载：([^\s]+)([^\r\n]*)/gu)];
  const match = matches.at(-1);
  if (!match || !isLoopbackUrl(match[1])) return null;
  const url = new URL(match[1]);
  if (url.pathname !== '/' || url.search || url.hash) return null;
  return { url: url.origin, widgetApi: /(?:^|\s)widget-api=1(?:\s|$)/u.test(match[2]) };
}

function readLastMainWindow(settingsDir) {
  let file;
  try {
    file = openSync(join(settingsDir, 'desktop.log'), 'r');
    const size = fstatSync(file).size;
    const buffer = Buffer.alloc(Math.min(size, 128 * 1024));
    const read = readSync(file, buffer, 0, buffer.length, size - buffer.length);
    return lastMainWindow(buffer.subarray(0, read).toString('utf8'));
  } catch { return null; }
  finally { if (file !== undefined) closeSync(file); }
}

function launchArguments(options, lastWindow, health, dataId) {
  if (!lastWindow || lastWindow.widgetApi || !isLoopbackUrl(lastWindow.url) || !matchesHealth(health, { dataId })) return ['--widget'];
  return ['--widget-companion', '--service-url', new URL(lastWindow.url).origin, '--data-id', dataId,
    '--main-executable', options.mainExecutable, '--settings-dir', options.settingsDir];
}

async function launchWidget(argv = process.argv.slice(2)) {
  const options = launchOptions(argv);
  if (!statSync(options.mainExecutable).isFile()) throw new Error('找不到人生驾驶舱主程序，请保留完整程序目录');
  let args = ['--widget'];
  try {
    const config = readConfig(options.settingsDir);
    const lastWindow = readLastMainWindow(options.settingsDir);
    if (config && lastWindow) {
      const dataId = dataIdentity(config.dataDir);
      const health = await requestJson(lastWindow.url, '/api/health', { timeout: 1200 });
      args = launchArguments(options, lastWindow, health, dataId);
    }
  } catch { /* Unknown/stopped service: let the ordinary app validate its own setup. */ }
  // No shell interpolation, backend spawning, timer request or credential read.
  // This is the requested interactive window; only the Node launcher console is hidden.
  const child = spawn(options.mainExecutable, args, { detached: true, windowsHide: false, stdio: 'ignore' });
  child.once('error', error => { console.error(`小组件入口未能打开：${error.message}`); process.exitCode = 1; });
  child.unref();
}

module.exports = { launchOptions, lastMainWindow, launchArguments, readLastMainWindow, launchWidget };
if (require.main === module) void launchWidget().catch(error => { console.error(error.message); process.exitCode = 1; });
