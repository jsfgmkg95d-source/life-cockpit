if (process.argv.includes('--widget-companion')) {
  require('./widget-companion.cjs');
  return;
}

const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, powerMonitor, shell, ipcMain, screen } = require('electron');
const { appendFileSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { initialConfig } = require('./config.cjs');
const { loadIcon } = require('./icon.cjs');
const { ServiceController, nodeRuntime } = require('./service.cjs');
const { isSafeExternalUrl, sameOrigin } = require('./service-identity.cjs');
const { readWidgetState, saveWidgetState, widgetBounds, trustedWidgetSender, requestsWidget } = require('./widget-state.cjs');

app.setName('LifeCockpit');
app.setAppUserModelId('org.lifecockpit.desktop');
const settingsDirectory = process.env.PCOS_DESKTOP_USER_DATA ? resolve(process.env.PCOS_DESKTOP_USER_DATA) : join(app.getPath('appData'), 'LifeCockpit');
mkdirSync(settingsDirectory, { recursive: true });
app.setPath('userData', settingsDirectory);

let window = null;
let tray = null;
let controller = null;
let config = null;
let finishing = false;
let exitAllowed = false;
let hideNoticeShown = false;
let widgetWindow = null;
let widgetReady = null;
let widgetState = readWidgetState(settingsDirectory);
let widgetSaveTimer = null;
let launchView = requestsWidget(process.argv) ? 'widget' : 'main';
const lockedSessions = new WeakSet();
const icon = loadIcon(nativeImage, 256);
const webPreferences = { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, backgroundThrottling: false };

function log(message) {
  try {
    const directory = app.getPath('userData');
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, 'desktop.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch { /* A log failure must not affect the ledger. */ }
}

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function persistWidgetState() {
  clearTimeout(widgetSaveTimer);
  widgetSaveTimer = null;
  try { saveWidgetState(app.getPath('userData'), widgetState); }
  catch (error) { log(`小组件偏好未能保存：${error.message}`); }
}

function widgetWorkAreas() {
  const primary = screen.getPrimaryDisplay();
  return [primary.workArea, ...screen.getAllDisplays().filter(display => display.id !== primary.id).map(display => display.workArea)];
}

function rememberWidgetPosition() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const { x, y } = widgetWindow.getBounds();
  widgetState = { ...widgetState, x, y };
  clearTimeout(widgetSaveTimer);
  widgetSaveTimer = setTimeout(persistWidgetState, 250);
}

function hideWidget() {
  widgetState.visible = false;
  widgetWindow?.hide();
  persistWidgetState();
  updateMenus();
}

function setWidgetAlwaysOnTop(value) {
  if (typeof value !== 'boolean') throw new TypeError('置顶选项必须是布尔值');
  widgetState.alwaysOnTop = value;
  widgetWindow?.setAlwaysOnTop(value);
  persistWidgetState();
  updateMenus();
  return { alwaysOnTop: widgetState.alwaysOnTop };
}

async function showWidget(focus = true) {
  if (!controller?.connection) { launchView = 'widget'; return; }
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    widgetWindow = new BrowserWindow({
      ...widgetBounds(widgetState, widgetWorkAreas()), frame: false, resizable: false,
      maximizable: false, fullscreenable: false, show: false, skipTaskbar: false,
      alwaysOnTop: widgetState.alwaysOnTop, title: '人生驾驶舱 · 桌面小组件',
      icon, backgroundColor: '#111427', autoHideMenuBar: true, webPreferences: { ...webPreferences },
    });
    lockWindowNavigation(widgetWindow.webContents, controller.connection.url);
    widgetWindow.on('close', event => { if (!exitAllowed) { event.preventDefault(); hideWidget(); } });
    widgetWindow.on('move', rememberWidgetPosition);
    const createdWindow = widgetWindow;
    widgetWindow.on('closed', () => { if (widgetWindow === createdWindow) { widgetWindow = null; widgetReady = null; } });
    widgetWindow.webContents.on('render-process-gone', (_event, details) => log(`小组件页面进程已停止：${details.reason}`));
    const url = new URL(controller.connection.url);
    url.searchParams.set('view', 'widget');
    widgetReady = createdWindow.loadURL(url.href).catch(error => {
      if (!createdWindow.isDestroyed()) createdWindow.destroy();
      if (widgetWindow === createdWindow) { widgetWindow = null; widgetReady = null; }
      throw error;
    });
  }
  widgetState.visible = true;
  persistWidgetState();
  await widgetReady;
  if (!widgetState.visible || finishing || !widgetWindow || widgetWindow.isDestroyed()) return;
  if (widgetWindow.isMinimized()) widgetWindow.restore();
  if (focus) { widgetWindow.show(); widgetWindow.focus(); }
  else widgetWindow.showInactive();
  log(`小组件已显示：${widgetWindow.isVisible()}，${JSON.stringify(widgetWindow.getBounds())}`);
  updateMenus();
}

function openWidgetFromMenu() { void showWidget().catch(error => log(`小组件未能打开：${error.message}`)); }

function registerWindowIpc(serviceUrl) {
  const handle = (channel, action) => ipcMain.handle(channel, (event, ...args) => {
    const contents = [window, widgetWindow].filter(value => value && !value.isDestroyed()).map(value => value.webContents);
    if (!trustedWidgetSender(event, contents, serviceUrl)) throw new Error('此页面不能管理驾驶舱窗口');
    return action(...args);
  });
  handle('life-cockpit:open-widget', () => showWidget());
  handle('life-cockpit:open-main', () => showWindow());
  handle('life-cockpit:hide-widget', () => hideWidget());
  handle('life-cockpit:set-widget-always-on-top', value => setWidgetAlwaysOnTop(value));
  handle('life-cockpit:get-widget-state', () => ({ alwaysOnTop: widgetState.alwaysOnTop }));
}

function openExternal(value) {
  if (isSafeExternalUrl(value)) void shell.openExternal(value).catch(error => log(`外部链接未打开：${error.message}`));
}

function menuTemplate() {
  return [
    { label: '显示驾驶舱', click: showWindow },
    { label: widgetState.visible ? '隐藏桌面小组件' : '显示桌面小组件', click: () => { if (widgetState.visible) hideWidget(); else openWidgetFromMenu(); } },
    { label: '小组件置顶', type: 'checkbox', checked: widgetState.alwaysOnTop, click: item => setWidgetAlwaysOnTop(item.checked) },
    { label: '打开账本文件夹', click: () => { if (config) void shell.openPath(config.dataDir).then(error => { if (error) log(error); }); } },
    { type: 'separator' },
    { label: finishing ? '正在保存并退出…' : '暂停并退出', enabled: !finishing, click: () => void pauseAndQuit() },
  ];
}

function updateMenus() {
  tray?.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '驾驶舱', submenu: menuTemplate() },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ label: '刷新页面', role: 'reload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ]));
  tray?.setToolTip(finishing ? '人生驾驶舱 · 正在保存并退出' : '人生驾驶舱 · 关闭窗口后继续计时');
}

async function pauseAndQuit() {
  if (finishing || exitAllowed) return;
  finishing = true;
  updateMenus();
  try {
    if (controller) {
      const child = controller.child;
      const ownServiceExited = controller.connection?.owned && child && (child.exitCode !== null || child.signalCode !== null);
      if (ownServiceExited) {
        await dialog.showMessageBox(window, { type: 'warning', title: '后台已经停止', message: '本地后台已异常退出，当前计时未能自动暂停。', detail: '关闭程序后，请在下次打开时核对并结束未完成的专注记录。已有账本文件会保留。', buttons: ['关闭程序'], noLink: true });
      } else {
        await controller.pauseActive();
        await controller.stopOwned();
      }
    }
    exitAllowed = true;
    persistWidgetState();
    tray?.destroy();
    app.quit();
  } catch (error) {
    log(`暂停并退出未完成：${error.message}`);
    finishing = false;
    updateMenus();
    showWindow();
    await dialog.showMessageBox(window, { type: 'error', title: '尚未退出', message: '计时或后台保存尚未确认完成。', detail: `${error.message}\n请核对当前专注记录后，再选择“暂停并退出”。`, buttons: ['返回驾驶舱'], noLink: true });
  }
}

function lockWindowNavigation(contents, serviceUrl) {
  const navigate = (event, value) => {
    if (sameOrigin(value, serviceUrl)) return;
    event.preventDefault();
    openExternal(value);
  };
  contents.on('will-navigate', navigate);
  contents.on('will-redirect', (event, value) => { if (!sameOrigin(value, serviceUrl)) event.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  contents.on('will-attach-webview', event => event.preventDefault());
  const session = contents.session;
  if (lockedSessions.has(session)) return;
  lockedSessions.add(session);
  session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  session.setPermissionCheckHandler(() => false);
  session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, respond) => respond({ cancel: !sameOrigin(details.url, serviceUrl) }));
  session.on('will-download', (event, item) => {
    if (!sameOrigin(item.getURL(), serviceUrl)) { event.preventDefault(); return; }
    // Electron shows its native Save dialog because no silent save path is assigned.
    item.setSaveDialogOptions({ title: '保存驾驶舱备份', defaultPath: item.getFilename() });
  });
}

async function start() {
  config = await initialConfig({
    userDataDir: app.getPath('userData'),
    dataDirOverride: process.env.PCOS_DESKTOP_DATA_DIR,
    dialog,
  });
  if (!config) { exitAllowed = true; app.quit(); return; }
  const backendRoot = app.isPackaged ? join(process.resourcesPath, 'backend') : resolve(__dirname, '..');
  controller = new ServiceController({
    dataDir: config.dataDir, backendRoot, preferredPort: config.preferredPort,
    nodeExecutable: nodeRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, override: process.env.PCOS_DESKTOP_NODE_PATH }), log,
  });
  const connection = await controller.connect();
  log(`连接账本服务：${connection.owned ? '自有后台' : '复用已核对的本机服务'}，服务 ${connection.serviceId}。`);
  window = new BrowserWindow({
    width: 1220, height: 860, minWidth: 360, minHeight: 540, show: false,
    title: '人生驾驶舱', icon, backgroundColor: '#f6f5f1', autoHideMenuBar: true,
    webPreferences: { ...webPreferences },
  });
  lockWindowNavigation(window.webContents, connection.url);
  window.on('close', event => {
    if (exitAllowed) return;
    event.preventDefault();
    window.hide();
    if (!hideNoticeShown) {
      hideNoticeShown = true;
      tray.displayBalloon({ iconType: 'info', title: '驾驶舱仍在后台', content: '关闭窗口后，正在进行的专注会继续计时。右键托盘图标可“暂停并退出”。', noSound: true });
    }
  });
  window.webContents.on('render-process-gone', (_event, details) => log(`页面进程已停止：${details.reason}。可重新打开程序核对本地记录。`));
  tray = new Tray(loadIcon(nativeImage, 32));
  tray.on('double-click', showWindow);
  tray.on('click', showWindow);
  registerWindowIpc(connection.url);
  updateMenus();
  await window.loadURL(connection.url);
  log(`桌面窗口已加载：${window.webContents.getURL()} widget-api=1`);
  try {
    if (launchView === 'widget') await showWidget();
    else {
      showWindow();
      if (widgetState.visible) await showWidget(false);
    }
  } catch (error) {
    log(`启动小组件未完成，主窗口继续可用：${error.message}`);
    showWindow();
  }
  const keepWidgetOnScreen = () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    widgetWindow.setBounds(widgetBounds(widgetWindow.getBounds(), widgetWorkAreas()));
    rememberWidgetPosition();
  };
  screen.on('display-removed', keepWidgetOnScreen);
  screen.on('display-metrics-changed', keepWidgetOnScreen);
  let sleepPause = null;
  powerMonitor.on('suspend', () => {
    const stoppedAt = new Date().toISOString();
    const pending = { stoppedAt, outcome: null };
    sleepPause = pending;
    // Capture before sleep; the API preserves this cutoff even if processing resumes later.
    pending.promise = controller.pauseActive(stoppedAt).then(paused => {
      pending.outcome = { paused };
      return pending.outcome;
    }).catch(error => {
      log(`睡眠前暂停尚未确认：${error.message}`);
      pending.outcome = { error };
      return pending.outcome;
    });
  });
  powerMonitor.on('resume', () => {
    const pending = sleepPause;
    if (!pending || finishing) return;
    sleepPause = null;
    void pending.promise.then(async outcome => {
      if (outcome.error) {
        try { outcome = { paused: await controller.pauseActive(pending.stoppedAt) }; }
        catch (error) { outcome = { error }; }
      }
      if (outcome.error) {
        log(`睡眠恢复后暂停未完成：${outcome.error.message}`);
        showWindow();
        await dialog.showMessageBox(window, { type: 'warning', title: '核对睡眠期间的专注', message: '睡眠前的专注未能确认暂停。', detail: `${outcome.error.message}\n请核对这次专注，排除睡眠期间的时间后再保存实际投入。`, buttons: ['核对专注'], noLink: true });
      } else if (outcome.paused) {
        tray.displayBalloon({ iconType: 'info', title: '专注已在睡眠前暂停', content: '实际投入已保存，睡眠期间未计入本次专注。需要继续时，请重新开始。', noSound: true });
      }
    }).catch(error => log(`睡眠恢复提示未完成：${error.message}`));
  });
}

if (!app.requestSingleInstanceLock()) {
  exitAllowed = true;
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    launchView = requestsWidget(argv) ? 'widget' : 'main';
    if (launchView === 'widget') openWidgetFromMenu();
    else showWindow();
  });
  app.on('activate', showWindow);
  app.on('before-quit', event => {
    if (!exitAllowed) { event.preventDefault(); void pauseAndQuit(); }
  });
  app.on('window-all-closed', () => { /* The tray owns lifetime until explicit Pause and Exit. */ });
  app.whenReady().then(start).catch(async error => {
    log(`桌面启动未完成：${error.message}`);
    try { await controller?.stopOwned(); } catch (stopError) { log(stopError.message); }
    dialog.showErrorBox('人生驾驶舱未能打开', `${error.message}\n已有账本不会被覆盖。桌面设置和日志位于：${app.getPath('userData')}`);
    exitAllowed = true;
    app.quit();
  });
}
