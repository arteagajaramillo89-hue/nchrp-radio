// Puente seguro entre la ventana y el proceso principal (la ventana no tiene acceso a Node).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nchrp', {
  config: () => ipcRenderer.invoke('cfg:get'),
  guardarConfig: (c) => ipcRenderer.invoke('cfg:set', c),
  login: (placa, password) => ipcRenderer.invoke('login', placa, password),
  token: (canal) => ipcRenderer.invoke('token', canal),
  logout: () => ipcRenderer.invoke('logout'),
  abrirMapa: () => ipcRenderer.invoke('mapa:abrir'),
  mapaDatos: () => ipcRenderer.invoke('mapa:datos'),
  estadoDatos: () => ipcRenderer.invoke('estado:datos'),
  capturarTecla: (cual) => ipcRenderer.invoke('ptt:capture', cual),
  quitarSusurro: () => ipcRenderer.invoke('susurro:quitar'),
  alertar: () => ipcRenderer.invoke('alerta'),
  siempreVisible: (v) => ipcRenderer.invoke('ontop', v),
  olvide: () => ipcRenderer.invoke('olvide'),
  alPtt: (cb) => ipcRenderer.on('ptt', (_e, d) => cb(d)),
  alSusurro: (cb) => ipcRenderer.on('susurro', (_e, d) => cb(d)),
  alCapturar: (cb) => ipcRenderer.on('ptt:captured', (_e, d) => cb(d)),
  alActualizacion: (cb) => ipcRenderer.on('actualizacion', (_e, d) => cb(d)),
  estadoActualizacion: () => ipcRenderer.invoke('actu:estado'),
  instalarActualizacion: () => ipcRenderer.invoke('actu:instalar'),
  abrirDescargas: () => ipcRenderer.invoke('actu:descargas'),
});
