const { contextBridge, ipcRenderer } = require('electron');

// A sandboxed preload only exposes this small window-management allowlist.
contextBridge.exposeInMainWorld('lifeCockpitDesktop', Object.freeze({
  openWidget: () => ipcRenderer.invoke('life-cockpit:open-widget'),
  openMain: () => ipcRenderer.invoke('life-cockpit:open-main'),
  hideWidget: () => ipcRenderer.invoke('life-cockpit:hide-widget'),
  setWidgetAlwaysOnTop: value => {
    if (typeof value !== 'boolean') return Promise.reject(new TypeError('置顶选项必须是布尔值'));
    return ipcRenderer.invoke('life-cockpit:set-widget-always-on-top', value);
  },
  getWidgetState: () => ipcRenderer.invoke('life-cockpit:get-widget-state'),
}));
