// NCHRP Radio — proceso principal de Electron.
// Aquí viven: la sesión (el token nunca llega al navegador), la tecla global de hablar y la configuración.
const { app, BrowserWindow, ipcMain, shell, session, Menu, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const { post } = require('./api');

const URL_OLVIDE = 'https://newchicago.xyz/recuperar.html';
const MAC = process.platform === 'darwin';
const CODIGO_TECLA_DEFECTO = MAC ? 3640 : 3613; // Windows: Ctrl derecho · Mac: Opción derecha (el Mac no tiene Ctrl derecho)

// ── Configuración (se guarda en la carpeta de datos del usuario; NUNCA la contraseña) ──
let cfg = { placa: '', pttCode: CODIGO_TECLA_DEFECTO, susurroCode: 0, susurroCanal: '', escuchaCanales: [], volumen: 80, mic: '', siempreVisible: false };
let archivoCfg = '';
function cargarCfg() {
  archivoCfg = path.join(app.getPath('userData'), 'config.json');
  try { cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(archivoCfg, 'utf8'))); } catch (_) {}
}
function guardarCfg() {
  try { fs.writeFileSync(archivoCfg, JSON.stringify(cfg)); } catch (e) { console.error('No se pudo guardar la configuración:', e.message); }
}

// ── Tecla global (uiohook-napi). Si no carga, la app sigue funcionando con el botón del ratón ──
let uio = null;
const nombresTecla = {};
try {
  const m = require('uiohook-napi');
  uio = m.uIOhook;
  for (const [n, c] of Object.entries(m.UiohookKey)) if (!(c in nombresTecla)) nombresTecla[c] = n;
} catch (e) { console.error('Tecla global no disponible:', e.message); uio = null; }

const ES = { CtrlRight: 'Ctrl derecho', Ctrl: 'Ctrl izquierdo', AltRight: 'Alt derecho (Alt Gr)', Alt: 'Alt izquierdo', ShiftRight: 'Mayús derecho', Shift: 'Mayús izquierdo', CapsLock: 'Bloq Mayús', Space: 'Espacio', Backquote: 'Tecla º', Backslash: 'Tecla \\', Tab: 'Tab', Enter: 'Enter', Backspace: 'Retroceso', Escape: 'Esc', Insert: 'Insert', Delete: 'Supr', Home: 'Inicio', End: 'Fin', PageUp: 'Re Pág', PageDown: 'Av Pág', ScrollLock: 'Bloq Despl', PrintScreen: 'Impr Pant', Meta: 'Windows', MetaRight: 'Windows derecho', NumLock: 'Bloq Num' };
if (MAC) Object.assign(ES, { Ctrl: 'Control izquierdo', CtrlRight: 'Control derecho', Alt: 'Opción izquierda', AltRight: 'Opción derecha', Meta: 'Comando izquierdo', MetaRight: 'Comando derecho' });
function nombreTecla(c) {
  const n = nombresTecla[c];
  if (!n) return 'Tecla ' + c;
  return ES[n] || n.replace(/^Numpad/, 'Num ').replace(/^Arrow/, 'Flecha ');
}

function safeTrusted() { try { return systemPreferences.isTrustedAccessibilityClient(false); } catch (_) { return true; } }

let win = null;
const enviar = (canal, datos) => { if (win && !win.isDestroyed()) win.webContents.send(canal, datos); };

let pttAbajo = false, susAbajo = false, capturando = null; // capturando: null | 'ptt' | 'susurro'
function iniciarTecla() {
  if (!uio) return;
  uio.on('keydown', (e) => {
    if (capturando) {
      const cual = capturando; capturando = null;
      const otra = cual === 'ptt' ? cfg.susurroCode : cfg.pttCode;
      if (otra && e.keycode === otra) {
        // Esa tecla ya la usa la otra función: no se cambia nada
        if (e.keycode === cfg.pttCode) pttAbajo = true; else susAbajo = true;
        enviar('ptt:captured', { cual, error: 'igual', nombre: nombreTecla(e.keycode) });
        return;
      }
      if (cual === 'ptt') { cfg.pttCode = e.keycode; pttAbajo = true; } else { cfg.susurroCode = e.keycode; susAbajo = true; }
      guardarCfg(); // se ignora hasta que la suelte, para no empezar a transmitir sin querer
      enviar('ptt:captured', { cual, code: e.keycode, nombre: nombreTecla(e.keycode) });
      return;
    }
    if (e.keycode === cfg.pttCode && !pttAbajo) { pttAbajo = true; enviar('ptt', { abajo: true }); }
    if (cfg.susurroCode && e.keycode === cfg.susurroCode && !susAbajo) { susAbajo = true; enviar('susurro', { abajo: true }); }
  });
  uio.on('keyup', (e) => {
    if (e.keycode === cfg.pttCode && pttAbajo) { pttAbajo = false; enviar('ptt', { abajo: false }); }
    if (cfg.susurroCode && e.keycode === cfg.susurroCode && susAbajo) { susAbajo = false; enviar('susurro', { abajo: false }); }
  });
  try { uio.start(); } catch (e) { console.error('No se pudo iniciar la tecla global:', e.message); uio = null; }
}

// ── Sesión del servidor ──
let sesion = null;
let mapWin = null; // ventana del mapa de unidades (ER:LC)

function registrarIpc() {
  ipcMain.handle('cfg:get', () => ({
    placa: cfg.placa, volumen: cfg.volumen, mic: cfg.mic, siempreVisible: cfg.siempreVisible,
    tecla: nombreTecla(cfg.pttCode), susurroTecla: cfg.susurroCode ? nombreTecla(cfg.susurroCode) : '', susurroCanal: cfg.susurroCanal, escuchaCanales: cfg.escuchaCanales,
    teclaGlobal: !!uio, permisoTeclas: MAC ? !!safeTrusted() : true, version: app.getVersion(),
  }));
  ipcMain.handle('cfg:set', (_e, c) => {
    c = c || {};
    if (Number.isFinite(c.volumen)) cfg.volumen = Math.max(0, Math.min(100, Math.round(c.volumen)));
    if (typeof c.mic === 'string') cfg.mic = c.mic.slice(0, 300);
    if (Array.isArray(c.escuchaCanales)) cfg.escuchaCanales = [...new Set(c.escuchaCanales.filter((x) => typeof x === 'string' && /^[a-z0-9_-]{1,20}$/.test(x)))].slice(0, 4);
    if (typeof c.susurroCanal === 'string' && /^[a-z0-9_-]{0,20}$/.test(c.susurroCanal)) cfg.susurroCanal = c.susurroCanal;
    guardarCfg();
    return true;
  });
  ipcMain.handle('login', async (_e, placa, password) => {
    placa = String(placa || '').trim(); password = String(password || '');
    if (!/^[1-9]\d{3}$/.test(placa) || !password || password.length > 64) return { ok: false, error: 'datos', mensaje: 'Escribe tu placa (4 números) y tu contraseña.' };
    const d = await post('/placas/login', { placa, password });
    if (!d.ok) return d;
    sesion = d.sesion; cfg.placa = placa; guardarCfg();
    return { ok: true, placa: d.placa, nombre: d.nombre, cuerpo: d.cuerpo, canales: d.canales, url: d.url };
  });
  ipcMain.handle('token', async (_e, canal) => {
    if (!sesion) return { ok: false, error: 'sesion', mensaje: 'La sesión venció. Inicia sesión otra vez.' };
    const d = await post('/placas/radio-token', { sesion, canal: String(canal || '') });
    if (!d.ok && (d.error === 'sesion' || d.error === 'placa')) sesion = null;
    return d;
  });
  ipcMain.handle('logout', () => { sesion = null; if (mapWin && !mapWin.isDestroyed()) mapWin.close(); return true; });
  ipcMain.handle('mapa:abrir', () => {
    if (!sesion) return false;
    if (mapWin && !mapWin.isDestroyed()) { if (mapWin.isMinimized()) mapWin.restore(); mapWin.focus(); return true; }
    mapWin = new BrowserWindow({
      width: 980, height: 760, minWidth: 520, minHeight: 420,
      backgroundColor: '#050b1a', title: 'NCHRP Radio · Mapa', autoHideMenuBar: true,
      icon: path.join(__dirname, 'build', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    if (cfg.siempreVisible) mapWin.setAlwaysOnTop(true, 'screen-saver');
    mapWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mapWin.webContents.on('will-navigate', (e) => e.preventDefault());
    mapWin.loadFile(path.join(__dirname, 'renderer', 'mapa.html'));
    mapWin.on('closed', () => { mapWin = null; });
    return true;
  });
  ipcMain.handle('estado:datos', async () => {
    if (!sesion) return { ok: false, error: 'sesion', mensaje: 'La sesión venció. Inicia sesión otra vez.' };
    const d = await post('/placas/estado', { sesion });
    if (!d.ok && (d.error === 'sesion' || d.error === 'placa')) sesion = null;
    return d;
  });
  ipcMain.handle('mapa:datos', async () => {
    if (!sesion) return { ok: false, error: 'sesion', mensaje: 'La sesión venció. Inicia sesión otra vez.' };
    const d = await post('/placas/mapa', { sesion });
    if (!d.ok && (d.error === 'sesion' || d.error === 'placa')) sesion = null;
    return d;
  });
  ipcMain.handle('ptt:capture', (_e, cual) => { if (!uio) return false; capturando = cual === 'susurro' ? 'susurro' : 'ptt'; return true; });
  ipcMain.handle('alerta', () => { if (win && !win.isDestroyed() && typeof win.flashFrame === 'function') win.flashFrame(true); return true; });
  ipcMain.handle('susurro:quitar', () => { cfg.susurroCode = 0; susAbajo = false; guardarCfg(); return true; });
  ipcMain.handle('ontop', (_e, v) => {
    cfg.siempreVisible = !!v; guardarCfg();
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!v, 'screen-saver');
    if (mapWin && !mapWin.isDestroyed()) mapWin.setAlwaysOnTop(!!v, 'screen-saver');
    return true;
  });
  ipcMain.handle('olvide', () => { shell.openExternal(URL_OLVIDE); return true; });
}

function crearVentana() {
  win = new BrowserWindow({
    width: 440, height: 780, minWidth: 400, minHeight: 620,
    backgroundColor: '#050b1a', title: 'NCHRP Radio', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false, // que el audio no se corte si la ventana queda detrás de Roblox
    },
  });
  if (cfg.siempreVisible) win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    // En Mac hace falta un menú mínimo: sin él no funcionan copiar/pegar (Cmd+C / Cmd+V) ni salir con Cmd+Q
    if (MAC) Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
    else Menu.setApplicationMenu(null);
    cargarCfg();
    // Solo se permite el micrófono; cualquier otro permiso se niega
    session.defaultSession.setPermissionRequestHandler((_wc, permiso, cb) => cb(permiso === 'media'));
    session.defaultSession.setPermissionCheckHandler((_wc, permiso) => permiso === 'media');
    if (MAC) {
      // Permisos de macOS: micrófono y Accesibilidad (la tecla global lo necesita). Muestran su aviso propio del sistema.
      try { systemPreferences.askForMediaAccess('microphone').catch(() => {}); } catch (_) {}
      try { systemPreferences.isTrustedAccessibilityClient(true); } catch (_) {}
    }
    registrarIpc();
    iniciarTecla();
    crearVentana();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { try { if (uio) uio.stop(); } catch (_) {} });
}
