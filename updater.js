// Actualizaciones de NCHRP Radio.
//  · Windows: electron-updater baja la versión nueva desde los "Releases" de GitHub y la instala al cerrar la radio
//    o cuando el usuario pulsa "Reiniciar y actualizar". Nunca se reinicia sola (podría cortar una transmisión).
//  · Mac: sin firma de Apple (de pago) macOS no deja actualizar la app sola. Se avisa y se abre la página de descargas.
//  · Si electron-updater no carga, Windows también cae en el aviso con enlace.
// Solo actúa en la app instalada (app.isPackaged); con `npm start` no hace nada.
const REPO = 'arteagajaramillo89-hue/nchrp-radio';
const URL_DESCARGAS = 'https://newchicago.xyz/descargas.html'; // fija: la ventana nunca elige qué enlace se abre
const CADA_MS = 4 * 60 * 60 * 1000;

function partes(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function esMasNueva(candidata, actual) {
  const a = partes(candidata), b = partes(actual);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

function crear({ app, enviar, abrir, plataforma, fetchFn, cargarAutoUpdater, cadaMs }) {
  let ultimo = null, lista = false, autoUpdater = null, ultimoPorc = -1;
  const decir = (d) => { ultimo = d; try { enviar(d); } catch (_) {} };

  async function avisoPorGitHub() {
    try {
      const r = await fetchFn(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'NCHRP-Radio' }, signal: AbortSignal.timeout(15000),
      });
      if (!r || !r.ok) return;
      const d = await r.json();
      if (d && esMasNueva(d.tag_name, app.getVersion())) decir({ estado: 'aviso', version: String(d.tag_name).replace(/^v/, ''), url: URL_DESCARGAS });
    } catch (_) { /* sin internet: se intentará más tarde */ }
  }

  function conAutoUpdater() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.on('update-available', (i) => { ultimoPorc = -1; decir({ estado: 'descargando', version: i && i.version, porcentaje: 0 }); });
    autoUpdater.on('download-progress', (p) => {
      const n = Math.max(0, Math.min(100, Math.round((p && p.percent) || 0)));
      if (n !== ultimoPorc) { ultimoPorc = n; decir({ estado: 'descargando', version: ultimo && ultimo.version, porcentaje: n }); }
    });
    autoUpdater.on('update-downloaded', (i) => { lista = true; decir({ estado: 'lista', version: i && i.version }); });
    autoUpdater.on('error', (e) => { console.error('[Actualizador]', e && e.message); });
    const buscar = () => { Promise.resolve().then(() => autoUpdater.checkForUpdates()).catch(() => {}); };
    buscar();
    return buscar;
  }

  function iniciar() {
    if (!app.isPackaged) return 'omitido';
    let buscar;
    if (plataforma === 'win32') {
      try { autoUpdater = cargarAutoUpdater(); } catch (_) { autoUpdater = null; }
    }
    if (autoUpdater) buscar = conAutoUpdater();
    else { buscar = avisoPorGitHub; buscar(); }
    const t = setInterval(buscar, cadaMs || CADA_MS); if (t && t.unref) t.unref();
    return autoUpdater ? 'auto' : 'aviso';
  }

  function instalar() {
    if (!autoUpdater || !lista) return false;
    autoUpdater.quitAndInstall(false, true);
    return true;
  }
  function abrirDescargas() { abrir(URL_DESCARGAS); return true; }

  return { iniciar, instalar, abrirDescargas, estado: () => ultimo };
}

module.exports = { crear, esMasNueva, URL_DESCARGAS, REPO };
