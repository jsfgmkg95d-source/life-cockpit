const { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { isAbsolute, join, resolve } = require('node:path');

function validateConfig(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.dataDir !== 'string' || !isAbsolute(value.dataDir)) throw new Error('桌面设置中的账本目录无效。');
  const preferredPort = value.preferredPort ?? 4317;
  if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65535) throw new Error('桌面设置中的本机端口无效。');
  if (!existsSync(value.dataDir) || !statSync(value.dataDir).isDirectory()) throw new Error('账本目录已移动或暂时无法读取，请重新选择目录。');
  return { schemaVersion: 1, dataDir: realpathSync(value.dataDir), preferredPort };
}

function readConfig(userDataDir) {
  const file = join(userDataDir, 'desktop-settings.json');
  if (!existsSync(file)) return null;
  return validateConfig(JSON.parse(readFileSync(file, 'utf8')));
}

function saveConfig(userDataDir, value) {
  const config = validateConfig(value);
  mkdirSync(userDataDir, { recursive: true });
  const file = join(userDataDir, 'desktop-settings.json');
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
  return config;
}

function existingLedger(directory) {
  return typeof directory === 'string' && isAbsolute(directory) && existsSync(join(directory, 'personal-company.sqlite'));
}

async function initialConfig({ userDataDir, dataDirOverride, dialog }) {
  if (dataDirOverride) return saveConfig(userDataDir, { schemaVersion: 1, dataDir: resolve(dataDirOverride), preferredPort: 4317 });
  const stored = readConfig(userDataDir);
  if (stored) return stored;
  const choice = await dialog.showMessageBox({ type: 'question', title: '欢迎使用人生驾驶舱', message: '开始你的工作台', detail: '新账本保存在当前 Windows 用户的本地应用目录。已有记录时，也可以手动选择已有账本文件夹。', buttons: ['建立新账本', '打开已有账本', '取消'], defaultId: 0, cancelId: 2, noLink: true });
  if (choice.response === 2) return null;
  let directory;
  if (choice.response === 1) {
    const selected = await dialog.showOpenDialog({ title: '选择已有账本文件夹', properties: ['openDirectory'] });
    if (selected.canceled) return null;
    directory = selected.filePaths[0];
    if (!existingLedger(directory)) throw new Error('所选文件夹中没有 personal-company.sqlite，请选择包含账本文件的文件夹。');
  } else {
    directory = join(userDataDir, 'data');
    mkdirSync(directory, { recursive: true });
  }
  return saveConfig(userDataDir, { schemaVersion: 1, dataDir: directory, preferredPort: 4317 });
}

module.exports = { validateConfig, readConfig, saveConfig, existingLedger, initialConfig };
