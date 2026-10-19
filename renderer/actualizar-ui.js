// Franja de aviso de actualizaciones (arriba de la ventana). Los datos llegan desde main.js.
(function () {
  'use strict';
  function describir(d) {
    if (!d || typeof d !== 'object') return null;
    const v = d.version ? ' ' + String(d.version).slice(0, 20) : '';
    if (d.estado === 'descargando') {
      const p = Number.isFinite(d.porcentaje) ? Math.max(0, Math.min(100, Math.round(d.porcentaje))) : 0;
      return { texto: 'Descargando la versión' + v + '… ' + p + '%', boton: '', accion: '' };
    }
    if (d.estado === 'lista') return { texto: 'La versión' + v + ' está lista.', boton: 'Reiniciar y actualizar', accion: 'instalar' };
    if (d.estado === 'aviso') return { texto: 'Hay una versión nueva' + (v ? ' (' + v.trim() + ')' : '') + '.', boton: 'Descargar', accion: 'descargas' };
    return null;
  }
  window.NCHRP_ACTU = { describir };

  const p = window.nchrp, caja = document.getElementById('actualizacion');
  if (!p || !caja || typeof p.alActualizacion !== 'function') return;
  const txt = document.getElementById('actu-texto'), btn = document.getElementById('actu-boton');
  let accion = '';
  function pintar(d) {
    const v = describir(d);
    if (!v) { caja.hidden = true; document.body.classList.remove('hay-actu'); return; }
    txt.textContent = v.texto; accion = v.accion;
    btn.hidden = !v.boton; btn.textContent = v.boton;
    caja.hidden = false; document.body.classList.add('hay-actu');
  }
  btn.onclick = () => {
    if (accion === 'instalar') { btn.disabled = true; btn.textContent = 'Reiniciando…'; p.instalarActualizacion(); }
    else if (accion === 'descargas') p.abrirDescargas();
  };
  p.alActualizacion(pintar);
  if (typeof p.estadoActualizacion === 'function') p.estadoActualizacion().then(pintar).catch(() => {});
})();
