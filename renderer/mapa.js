// Ventana del mapa: muestra en tiempo real Policía (azul), Bomberos (rojo) y EMS (blanco).
// Los datos llegan por window.nchrp.mapaDatos() (lo pide main.js al servidor; esta ventana nunca ve la sesión).
(function () {
  'use strict';
  const CAL = window.NCHRP_MAPA;
  const COLOR = { pd: '#41b6e6', cfd: '#ff3b4e', ems: '#ffffff', isp: '#e8c85a' };
  const NOMBRE = { pd: 'Policía', cfd: 'Bomberos', ems: 'EMS', isp: 'ISP' };
  const REFRESCO_MS = 5000;
  const $ = (s) => document.querySelector(s);
  const lienzo = $('#lienzo'), ctx = lienzo.getContext('2d'), tip = $('#tip'), aviso = $('#aviso'), hora = $('#hora');

  const img = new Image();
  let cargada = false;
  let unidades = [], ultimo = 0, parar = false, hover = null;
  const V = { k: 1, tx: 0, ty: 0, fit: 1, w: 0, h: 0, dpr: 1 }; // pantalla = imagen * k + t

  // Coordenadas de ER:LC -> píxel de la imagen
  const aPixel = (x, z) => ({ x: CAL.s * x + CAL.ox, y: CAL.s * z + CAL.oy });
  const aPantalla = (p) => ({ x: p.x * V.k + V.tx, y: p.y * V.k + V.ty });

  function medir() {
    const r = lienzo.getBoundingClientRect();
    V.w = Math.max(1, Math.round(r.width || lienzo.clientWidth || 800));
    V.h = Math.max(1, Math.round(r.height || lienzo.clientHeight || 600));
    V.dpr = window.devicePixelRatio || 1;
    lienzo.width = Math.round(V.w * V.dpr); lienzo.height = Math.round(V.h * V.dpr);
    V.fit = Math.min(V.w / CAL.ancho, V.h / CAL.alto);
  }
  function centrar() {
    V.k = V.fit; V.tx = (V.w - CAL.ancho * V.k) / 2; V.ty = (V.h - CAL.alto * V.k) / 2;
  }
  function limitar() {
    V.k = Math.max(V.fit * 0.8, Math.min(V.fit * 10, V.k));
    const mw = CAL.ancho * V.k, mh = CAL.alto * V.k, m = 80; // deja ver algo del mapa siempre
    V.tx = Math.max(m - mw, Math.min(V.w - m, V.tx));
    V.ty = Math.max(m - mh, Math.min(V.h - m, V.ty));
  }
  function zoomEn(px, py, factor) {
    const antes = { x: (px - V.tx) / V.k, y: (py - V.ty) / V.k };
    V.k *= factor;
    limitar();
    V.tx = px - antes.x * V.k; V.ty = py - antes.y * V.k;
    limitar(); dibujar();
  }

  function radio() { return Math.max(6, Math.min(11, 5 + V.k * 1.6)); }
  function buscar(sx, sy) {
    let mejor = null, d2 = Math.pow(radio() + 6, 2);
    for (const u of unidades) {
      const p = aPantalla(aPixel(u.x, u.z)), d = (p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy);
      if (d <= d2) { d2 = d; mejor = u; }
    }
    return mejor;
  }

  function dibujar() {
    ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
    ctx.clearRect(0, 0, V.w, V.h);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    if (cargada) ctx.drawImage(img, V.tx, V.ty, CAL.ancho * V.k, CAL.alto * V.k);
    const r = radio(), nombres = $('#ver-nombres').checked || V.k > V.fit * 2.2;
    ctx.font = '600 12px "Segoe UI",sans-serif'; ctx.textBaseline = 'middle';
    for (const u of unidades) {
      const p = aPantalla(aPixel(u.x, u.z));
      if (p.x < -20 || p.y < -20 || p.x > V.w + 20 || p.y > V.h + 20) continue;
      const esHover = hover === u;
      ctx.beginPath(); ctx.arc(p.x, p.y, r + (esHover ? 3 : 0), 0, Math.PI * 2);
      ctx.fillStyle = COLOR[u.c] || '#ffffff'; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#07102a'; ctx.stroke();
      if (u.c === 'ems') { ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.38, 0, Math.PI * 2); ctx.fillStyle = '#ff3b4e'; ctx.fill(); }
      if (nombres || esHover) {
        const t = u.cs ? `${u.cs} · ${u.n}` : u.n, x = p.x + r + 5, w = ctx.measureText(t).width;
        ctx.fillStyle = 'rgba(5,11,26,.82)'; ctx.fillRect(x - 4, p.y - 10, w + 8, 20);
        ctx.fillStyle = '#eaf3ff'; ctx.fillText(t, x, p.y);
      }
    }
  }

  function leyenda() {
    const n = { pd: 0, cfd: 0, ems: 0, isp: 0 };
    for (const u of unidades) if (n[u.c] !== undefined) n[u.c]++;
    for (const c of Object.keys(n)) { const e = $('#n-' + c); if (e) e.textContent = String(n[c]); }
    $('#chip-isp').hidden = n.isp === 0;
  }
  function ponerHora() {
    hora.textContent = ultimo ? 'Actualizado hace ' + Math.max(0, Math.round((Date.now() - ultimo) / 1000)) + ' s' : '';
  }

  async function actualizar() {
    if (parar) return;
    if (!document.hidden) {
      let d;
      try { d = await window.nchrp.mapaDatos(); } catch (_) { d = { ok: false, error: 'red' }; }
      if (d && d.ok && Array.isArray(d.unidades)) {
        unidades = d.unidades.filter((u) => u && Number.isFinite(u.x) && Number.isFinite(u.z)).map((u) => ({
          n: String(u.n || 'Unidad').slice(0, 60), c: String(u.c || ''), cs: u.cs ? String(u.cs).slice(0, 20) : null,
          x: u.x, z: u.z, calle: u.calle ? String(u.calle).slice(0, 60) : '', postal: u.postal ? String(u.postal).slice(0, 10) : '',
        }));
        ultimo = Date.now(); hover = null; leyenda(); dibujar();
        aviso.className = 'aviso'; aviso.textContent = unidades.length ? '' : 'No hay unidades en servicio ahora mismo.';
      } else if (d && (d.error === 'sesion' || d.error === 'placa')) {
        parar = true; aviso.className = 'aviso err';
        aviso.textContent = 'Tu sesión venció. Inicia sesión otra vez en la radio y vuelve a abrir el mapa.';
        return;
      } else {
        aviso.className = 'aviso err';
        aviso.textContent = 'No se pudo leer el servidor de ER:LC. Reintentando…';
      }
    }
    setTimeout(actualizar, REFRESCO_MS);
  }

  // ── Interacción ──
  let arr = null;
  lienzo.addEventListener('pointerdown', (e) => { arr = { x: e.clientX, y: e.clientY, tx: V.tx, ty: V.ty }; lienzo.classList.add('arrastrando'); try { lienzo.setPointerCapture(e.pointerId); } catch (_) {} });
  lienzo.addEventListener('pointermove', (e) => {
    const r = lienzo.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (arr) { V.tx = arr.tx + (e.clientX - arr.x); V.ty = arr.ty + (e.clientY - arr.y); limitar(); tip.hidden = true; dibujar(); return; }
    const u = buscar(sx, sy);
    if (u !== hover) { hover = u; dibujar(); }
    if (!u) { tip.hidden = true; return; }
    tip.textContent = '';
    const a = document.createElement('b'); a.textContent = (u.cs ? u.cs + ' · ' : '') + u.n;
    const b = document.createElement('span'); b.textContent = NOMBRE[u.c] || u.c;
    const c = document.createElement('span'); c.textContent = [u.calle, u.postal ? 'Postal ' + u.postal : ''].filter(Boolean).join(' · ');
    tip.append(a, b, c); tip.hidden = false;
    tip.style.left = Math.min(sx + 14, V.w - 270) + 'px'; tip.style.top = Math.min(sy + 14, V.h - 90) + 'px';
  });
  const soltar = () => { arr = null; lienzo.classList.remove('arrastrando'); };
  lienzo.addEventListener('pointerup', soltar); lienzo.addEventListener('pointercancel', soltar);
  lienzo.addEventListener('pointerleave', () => { tip.hidden = true; if (hover) { hover = null; dibujar(); } });
  lienzo.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = lienzo.getBoundingClientRect();
    zoomEn(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.18 : 1 / 1.18);
  }, { passive: false });
  $('#mas').onclick = () => zoomEn(V.w / 2, V.h / 2, 1.3);
  $('#menos').onclick = () => zoomEn(V.w / 2, V.h / 2, 1 / 1.3);
  $('#centrar').onclick = () => { centrar(); dibujar(); };
  $('#ver-nombres').onchange = dibujar;
  window.addEventListener('resize', () => { const antes = V.fit; medir(); if (Math.abs(V.k - antes) < 1e-6) centrar(); limitar(); dibujar(); });
  setInterval(ponerHora, 1000);

  img.onload = () => { cargada = true; dibujar(); };
  img.onerror = () => { aviso.className = 'aviso err'; aviso.textContent = 'No se pudo cargar la imagen del mapa.'; };
  medir(); centrar(); dibujar();
  img.src = CAL.imagen;
  actualizar();

  window.MapaNCHRP = { aPixel, aPantalla, buscar, V, unidades: () => unidades, centrar, medir };
})();
