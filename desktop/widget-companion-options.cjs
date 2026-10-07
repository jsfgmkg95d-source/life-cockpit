const { isAbsolute, resolve } = require('node:path');
const { isLoopbackUrl } = require('./service-identity.cjs');

function companionOptions(argv) {
  const names = ['service-url', 'data-id', 'main-executable', 'settings-dir'];
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = typeof argv[index] === 'string' ? argv[index].replace(/^--/, '') : '';
    if (!names.includes(name) || argv[index] !== '--' + name) continue;
    if (parsed[name] !== undefined || typeof argv[index + 1] !== 'string' || argv[index + 1].startsWith('--')) throw new Error('小组件启动参数无效');
    parsed[name] = argv[++index];
  }
  if (!isLoopbackUrl(parsed['service-url']) || !/^[a-f0-9]{16}$/.test(parsed['data-id'] ?? '')) throw new Error('需要明确的本机服务地址与账本身份');
  const service = new URL(parsed['service-url']);
  if (service.pathname !== '/' || service.search || service.hash) throw new Error('本机服务地址必须是原始服务地址');
  if (!isAbsolute(parsed['main-executable'] ?? '') || !/\.exe$/i.test(parsed['main-executable']) || !isAbsolute(parsed['settings-dir'] ?? '')) throw new Error('需要明确的主程序和设置目录绝对路径');
  return { serviceUrl: service.origin, dataId: parsed['data-id'],
    mainExecutable: resolve(parsed['main-executable']), settingsDir: resolve(parsed['settings-dir']) };
}

module.exports = { companionOptions };
