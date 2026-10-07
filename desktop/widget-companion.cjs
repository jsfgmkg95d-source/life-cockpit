// Transitional attach-only entry point: never owns, stops or pauses a backend.
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, shell, dialog } = require('electron');
const { appendFileSync, mkdirSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { loadIcon } = require('./icon.cjs');
const { requestJson } = require('./service.cjs');
const { matchesHealth, sameOrigin, isSafeExternalUrl } = require('./service-identity.cjs');
const { readWidgetState, saveWidgetState, widgetBounds, trustedWidgetSender } = require('./widget-state.cjs');
const { companionOptions } = require('./widget-companion-options.cjs');

const options = companionOptions(process.argv);
if (!statSync(options.mainExecutable).isFile()) throw new Error('找不到要打开的驾驶舱主程序');
const userData = join(options.settingsDir, 'widget-companion');
mkdirSync(userData, { recursive: true });
app.setName('人生驾驶舱小组件');
app.setAppUserModelId('org.lifecockpit.widget-companion');
app.setPath('userData', userData);
const icon = loadIcon(nativeImage, 256);
let state = readWidgetState(options.settingsDir);
let window = null, tray = null, positionTimer = null, healthTimer = null;
let exiting = false, checkingHealth = false, consecutiveFailures = 0, expectedHealth = null;

function log(message) {
  try { appendFileSync(join(userData, 'widget-companion.log'), `${new Date().toISOString()} ${message}\n`, 'utf8'); }
  catch { /* Logging cannot affect the shared ledger. */ }
}

function persist() {
  clearTimeout(positionTimer);
  positionTimer = null;
  try { saveWidgetState(options.settingsDir, state); }
  catch (error) { log(`偏好未能保存：${error.message}`); }
}

function workAreas() {
  const primary = screen.getPrimaryDisplay();
  return [primary.workArea, ...screen.getAllDisplays().filter(display => display.id !== primary.id).map(display => display.workArea)];
}

function showWidget() {
  if (!window || window.isDestroyed()) return;
  state.visible = true; persist();
  if (window.isMinimized()) window.restore();
  window.show(); window.focus(); updateMenu();
}

function hideWidget() { state.visible = false; window?.hide(); persist(); updateMenu(); }

function setAlwaysOnTop(value) {
  if (typeof value !== 'boolean') throw new TypeError('置顶选项必须是布尔值');
  state.alwaysOnTop = value; window?.setAlwaysOnTop(value); persist(); updateMenu();
  return { alwaysOnTop: state.alwaysOnTop };
}

async function openMain() {
  const error = await shell.openPath(options.mainExecutable);
  if (error) throw new Error(error);
}

function updateMenu() {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: state.visible ? '隐藏桌面小组件' : '显示桌面小组件', click: () => state.visible ? hideWidget() : showWidget() },
    { label: '小组件置顶', type: 'checkbox', checked: state.alwaysOnTop, click: item => setAlwaysOnTop(item.checked) },
    { label: '打开驾驶舱', click: () => { void openMain().catch(error => log(`主程序未能打开：${error.message}`)); } },
    { type: 'separator' },
    { label: '退出小组件', click: () => { state.visible = false; quitCompanion(); } },
  ]));
  tray?.setToolTip('人生驾驶舱 · 桌面小组件');
}

function quitCompanion() {
  if (exiting) return;
  exiting = true;
  clearInterval(healthTimer);
  persist();
  tray?.destroy();
  app.quit();
}

async function checkHealth() {
  const health = await requestJson(options.serviceUrl, '/api/health', { timeout: 1500 });
  if (!matchesHealth(health, expectedHealth ?? { dataId: options.dataId })) throw new Error('所连接服务或账本身份已改变');
  return health;
}

async function start() {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { expectedHealth = await checkHealth(); break; }
    catch (error) { lastError = error; if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!expectedHealth) throw lastError;
  log(`只读核对服务成功：${options.serviceUrl}，账本 ${options.dataId}，服务 ${expectedHealth.serviceId}`);
  window = new BrowserWindow({ ...widgetBounds(state, workAreas()), frame: false, resizable: false,
    maximizable: false, fullscreenable: false, show: false, skipTaskbar: false, alwaysOnTop: state.alwaysOnTop,
    title: '人生驾驶舱 · 桌面小组件', icon, backgroundColor: '#111427', autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, webviewTag: false, backgroundThrottling: false },
  });
  const contents = window.webContents;
  contents.on('will-navigate', (event, url) => { if (!sameOrigin(url, options.serviceUrl)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!sameOrigin(url, options.serviceUrl)) event.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url).catch(error => log(error.message));
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, respond) => respond({ cancel: !sameOrigin(details.url, options.serviceUrl) }));
  contents.session.on('will-download', event => event.preventDefault());
  window.on('close', event => { if (!exiting) { event.preventDefault(); hideWidget(); } });
  window.on('move', () => {
    const { x, y } = window.getBounds(); state = { ...state, x, y };
    clearTimeout(positionTimer); positionTimer = setTimeout(persist, 250);
  });
  const keepOnScreen = () => { if (!window.isDestroyed()) window.setBounds(widgetBounds(window.getBounds(), workAreas())); };
  screen.on('display-removed', keepOnScreen);
  screen.on('display-metrics-changed', keepOnScreen);
  for (const [channel, action] of Object.entries({
    'life-cockpit:open-widget': showWidget,
    'life-cockpit:open-main': openMain,
    'life-cockpit:hide-widget': hideWidget,
    'life-cockpit:set-widget-always-on-top': setAlwaysOnTop,
    'life-cockpit:get-widget-state': () => ({ alwaysOnTop: state.alwaysOnTop }),
  })) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!trustedWidgetSender(event, [contents], options.serviceUrl)) throw new Error('此页面不能管理驾驶舱小组件');
      return action(...args);
    });
  }
  tray = new Tray(loadIcon(nativeImage, 32));
  tray.on('click', showWidget);
  updateMenu();
  // A failed first load exits explicitly; a later launch creates a fresh window.
  await window.loadURL(options.serviceUrl + '/?view=widget');
  showWidget();
  healthTimer = setInterval(() => {
    if (checkingHealth || exiting) return;
    checkingHealth = true;
    void checkHealth().then(() => { consecutiveFailures = 0; }).catch(error => {
      consecutiveFailures += 1;
      log(`服务核对失败 ${consecutiveFailures}/3：${error.message}`);
      if (consecutiveFailures >= 3) {
        log('原服务已无法核对，仅退出小组件；可见偏好保留供新版主程序恢复。');
        quitCompanion();
      }
    }).finally(() => { checkingHealth = false; });
  }, 3000);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWidget);
  app.on('before-quit', () => { exiting = true; clearInterval(healthTimer); persist(); });
  app.on('window-all-closed', () => { /* The tray stays alive while this small window is hidden. */ });
  app.whenReady().then(start).catch(error => {
    log(`小组件未能连接：${error.message}`);
    dialog.showErrorBox('桌面小组件未能打开', `${error.message}\n主程序和正在进行的计时不受影响。`);
    quitCompanion();
  });
}
