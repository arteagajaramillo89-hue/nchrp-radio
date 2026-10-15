// Puente seguro entre la ventana y el proceso principal (la ventana no tiene acceso a Node).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nchrp', {
  config: () => ipcRenderer.invoke('cfg:get'),
  guardarConfig: (c) => ipcRenderer.invoke('cfg:set', c),
  login: (placa, password) => ipcRenderer.invoke('login', placa, password),
  token: (canal) => ipcRenderer.invoke('token', canal),
  logout: () => ipcRenderer.invoke('logout'),
  capturarTecla: () => ipcRenderer.invoke('ptt:capture'),
  siempreVisible: (v) => ipcRenderer.invoke('ontop', v),
  olvide: () => ipcRenderer.invoke('olvide'),
  alPtt: (cb) => ipcRenderer.on('ptt', (_e, d) => cb(d)),
  alCapturar: (cb) => ipcRenderer.on('ptt:captured', (_e, d) => cb(d)),
});
