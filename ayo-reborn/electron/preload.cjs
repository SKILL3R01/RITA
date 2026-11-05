// Rita overlay preload — tiny context-isolated bridge.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('rita', {
  events: (cb) => {
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on('rita:event', listener)
    return () => ipcRenderer.off('rita:event', listener)
  },
  getInit: () => ipcRenderer.invoke('overlay:get-init'),
  hide: () => ipcRenderer.invoke('overlay:hide'),
  toggleMute: () => ipcRenderer.invoke('overlay:toggle-mute'),
  listenNow: () => ipcRenderer.invoke('overlay:listen-now'),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsApply: (patch) => ipcRenderer.invoke('settings:apply', patch),
  settingsTestVoice: (patch) => ipcRenderer.invoke('settings:test-voice', patch),
  settingsPullModel: (patch) => ipcRenderer.invoke('settings:pull-model', patch),
  settingsRestart: () => ipcRenderer.invoke('settings:restart'),
  settingsCloneRecord: () => ipcRenderer.invoke('settings:clone-record'),
  settingsCloneGenerate: () => ipcRenderer.invoke('settings:clone-generate'),
  dashboardGet: () => ipcRenderer.invoke('dashboard:get'),
  dashboardOpen: () => ipcRenderer.invoke('dashboard:open'),
  memoryFactDelete: (id) => ipcRenderer.invoke('memory:fact-delete', id),
  memoryFollowupDelete: (id) => ipcRenderer.invoke('memory:followup-delete', id),
  memoryApproveRevoke: (key) => ipcRenderer.invoke('memory:approve-revoke', key),
  ollamaStatus: () => ipcRenderer.invoke('ollama:status'),
  ollamaInstallWinget: () => ipcRenderer.invoke('ollama:install-winget'),
})
