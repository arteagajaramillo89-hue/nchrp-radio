// Panel del mapa (dentro de la ventana principal, a la derecha del riel y de los canales).
// Muestra en tiempo real Policía (azul), Bomberos (rojo) y EMS (blanco). Si alguien manda un SOS, el panel se abre solo,
// se centra en esa persona y su punto parpadea en amarillo / color de su equipo.
// Los datos llegan por window.nchrp.mapaDatos() (los pide main.js al servidor; esta página nunca ve la sesión).
(function () {
  'use strict';
  const CAL = window.NCHRP_MAPA;
  const COLOR = { pd: '#41b6e6', cfd: '#ff3b4e', ems: '#ffffff', isp: '#e8c85a' };
  const NOMBRE = { pd: 'Policía', cfd: 'Bomberos', ems: 'EMS', isp: 'ISP' };
  const AMARILLO = '#ffd21f';
  const REFRESCO_MS = 5000, REFRESCO_SOS_MS = 3000; // el servidor deja 30 consultas por minuto
  const VIDA_SOS_MS = 180000, MAX_SOS = 3;
  const $ = (s) => document.querySelector(s);
  const panel = $('#panel-mapa'), lienzo = $('#lienzo'), ctx = lienzo.getContext('2d'), tip = $('#tip'), aviso = $('#aviso-mapa'), hora = $('#hora-mapa'), tarjetas = $('#sos-mapa');
  const raf = (f) => (window.requestAnimationFrame ? window.requestAnimationFrame(f) : setTimeout(f, 50));
  const norm = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

  const img = new Image();
  let cargada = false, abierto = false, parar = false, enVuelo = false, timer = null, bucleActivo = false;
  let unidades = [], ultimo = 0, hover = null, anim = null;
  const filtro = { pd: true, cfd: true, ems: true, isp: true };
  let sosLista = []; // { id, placa, nombre, canal, desde, u }
  const V = { k: 1, tx: 0, ty: 0, fit: 1, w: 0, h: 0, dpr: 1 }; // pantalla = imagen * k + t   (imagen = medida de referencia de la calibración)

  const aPixel = (x, z) => ({ x: CAL.s * x + CAL.ox, y: CAL.s * z + CAL.oy });
  const aPantalla = (p) => ({ x: p.x * V.k + V.tx, y: p.y * V.k + V.ty });

  function medir() {
    const caja = $('#caja-mapa') || lienzo, r = lienzo.getBoundingClientRect();
    V.w = Math.max(1, Math.round(r.width || caja.clientWidth || 700));
    V.h = Math.max(1, Math.round(r.height || caja.clientHeight || 600));
    V.dpr = window.devicePixelRatio || 1;
    lienzo.width = Math.round(V.w * V.dpr); lienzo.height = Math.round(V.h * V.dpr);
    V.fit = Math.min(V.w / CAL.ancho, V.h / CAL.alto);
  }
  function centrar() { V.k = V.fit; V.tx = (V.w - CAL.ancho * V.k) / 2; V.ty = (V.h - CAL.alto * V.k) / 2; }
  function limitar() {
    V.k = Math.max(V.fit * 0.8, Math.min(V.fit * 12, V.k));
    const mw = CAL.ancho * V.k, mh = CAL.alto * V.k, m = 80;
    V.tx = Math.max(m - mw, Math.min(V.w - m, V.tx));
    V.ty = Math.max(m - mh, Math.min(V.h - m, V.ty));
  }
  function zoomEn(px, py, factor) {
    anim = null;
    const antes = { x: (px - V.tx) / V.k, y: (py - V.ty) / V.k };
    V.k *= factor; limitar();
    V.tx = px - antes.x * V.k; V.ty = py - antes.y * V.k;
    limitar(); dibujar();
  }
  // Mueve la vista (suave) para dejar el punto de imagen p en el centro con el zoom k
  function irA(p, k) {
    k = Math.max(V.fit * 0.8, Math.min(V.fit * 12, k));
    const hasta = { k, tx: V.w / 2 - p.x * k, ty: V.h / 2 - p.y * k };
    if (!window.requestAnimationFrame) { Object.assign(V, hasta); limitar(); dibujar(); return; }
    anim = { t0: Date.now(), dur: 650, desde: { k: V.k, tx: V.tx, ty: V.ty }, hasta };
    arrancarBucle();
  }

  const radio = () => Math.max(6, Math.min(11, 5 + V.k * 1.6));
  const visible = (u) => filtro[u.c] !== false;
  function buscar(sx, sy) {
    let mejor = null, d2 = Math.pow(radio() + 6, 2);
    for (const u of unidades) {
      if (!visible(u)) continue;
      const p = aPantalla(aPixel(u.x, u.z)), d = (p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy);
      if (d <= d2) { d2 = d; mejor = u; }
    }
    return mejor;
  }

  // ¿Qué unidad es la persona que mandó el SOS? Primero por placa (exacto), si no por nombre.
  function unidadDe(s) {
    if (s.placa) { const a = unidades.find((u) => u.p && u.p === s.placa); if (a) return a; }
    const n = norm(s.nombre);
    return n ? unidades.find((u) => norm(u.n) === n) || null : null;
  }

  function dibujar() {
    ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
    ctx.clearRect(0, 0, V.w, V.h);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    if (cargada) ctx.drawImage(img, V.tx, V.ty, CAL.ancho * V.k, CAL.alto * V.k);
    const r = radio(), nombres = ($('#ver-nombres') || {}).checked || V.k > V.fit * 2.2;
    ctx.font = '600 12px "Segoe UI",sans-serif'; ctx.textBaseline = 'middle';
    const enSos = new Set(sosLista.map((s) => s.u).filter(Boolean));
    for (const u of unidades) {
      if (!visible(u) || enSos.has(u)) continue;
      const p = aPantalla(aPixel(u.x, u.z));
      if (p.x < -20 || p.y < -20 || p.x > V.w + 20 || p.y > V.h + 20) continue;
      const esHover = hover === u;
      ctx.beginPath(); ctx.arc(p.x, p.y, r + (esHover ? 3 : 0), 0, Math.PI * 2);
      ctx.fillStyle = COLOR[u.c] || '#ffffff'; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#07102a'; ctx.stroke();
      if (u.c === 'ems') { ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.38, 0, Math.PI * 2); ctx.fillStyle = '#ff3b4e'; ctx.fill(); }
      if (nombres || esHover) etiqueta(p, r, u.cs ? `${u.cs} · ${u.n}` : u.n, '#eaf3ff', 'rgba(5,11,26,.82)');
    }
    // SOS encima de todo: anillo que se expande + punto que alterna amarillo / color del equipo
    const t = Date.now(), fase = (t % 900) / 900, encendido = fase < 0.5;
    for (const s of sosLista) {
      if (!s.u) continue;
      const p = aPantalla(aPixel(s.u.x, s.u.z)), eq = COLOR[s.u.c] || '#ffffff', R = r + 5;
      ctx.beginPath(); ctx.arc(p.x, p.y, R + fase * 34, 0, Math.PI * 2);
      ctx.lineWidth = 3; ctx.strokeStyle = encendido ? AMARILLO : eq; ctx.globalAlpha = Math.max(0, 1 - fase); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
      ctx.fillStyle = encendido ? AMARILLO : eq; ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = encendido ? eq : AMARILLO; ctx.stroke();
      etiqueta(p, R, 'SOS · ' + s.nombre, '#1a1200', AMARILLO);
    }
  }
  function etiqueta(p, r, t, colorTexto, fondo) {
    const x = p.x + r + 6, w = ctx.measureText(t).width;
    ctx.fillStyle = fondo; ctx.fillRect(x - 4, p.y - 10, w + 8, 20);
    ctx.fillStyle = colorTexto; ctx.fillText(t, x, p.y);
  }

  // Bucle de animación: solo corre mientras hace falta (SOS parpadeando o la vista moviéndose)
  function hayAnimacion() { return abierto && (anim || sosLista.some((s) => s.u)); }
  function arrancarBucle() {
    if (bucleActivo) return;
    bucleActivo = true;
    const paso = () => {
      if (anim) {
        const e = Math.min(1, (Date.now() - anim.t0) / anim.dur), f = 1 - Math.pow(1 - e, 3);
        V.k = anim.desde.k + (anim.hasta.k - anim.desde.k) * f;
        V.tx = anim.desde.tx + (anim.hasta.tx - anim.desde.tx) * f; V.ty = anim.desde.ty + (anim.hasta.ty - anim.desde.ty) * f;
        if (e >= 1) anim = null;
        limitar();
      }
      dibujar();
      if (hayAnimacion()) raf(paso); else bucleActivo = false;
    };
    raf(paso);
  }

  function pintarLeyenda() {
    const n = { pd: 0, cfd: 0, ems: 0, isp: 0 };
    for (const u of unidades) if (n[u.c] !== undefined) n[u.c]++;
    for (const c of Object.keys(n)) { const e = $('#n-' + c); if (e) e.textContent = String(n[c]); }
    const isp = $('#chip-isp'); if (isp) isp.hidden = n.isp === 0;
  }
  function ponerHora() {
    hora.textContent = ultimo ? 'Actualizado hace ' + Math.max(0, Math.round((Date.now() - ultimo) / 1000)) + ' s' : '';
    const antes = sosLista.length;
    sosLista = sosLista.filter((s) => Date.now() - s.desde < VIDA_SOS_MS);
    if (sosLista.length !== antes) pintarTarjetas();
  }

  // Tarjetas SOS (arriba a la izquierda del mapa): quién, dónde, y botones para ir o cerrar
  function pintarTarjetas() {
    tarjetas.textContent = '';
    for (const s of sosLista) {
      const c = document.createElement('div'); c.className = 'sos-tarjeta'; c.setAttribute('role', 'alert');
      const tx = document.createElement('div'); tx.className = 'tx';
      const t = document.createElement('b'); t.textContent = 'SOS · SOLICITA AYUDA';
      const n = document.createElement('span'); n.className = 'n'; n.textContent = s.nombre;
      const d = document.createElement('span'); d.className = 'd';
      d.textContent = s.u ? [s.u.calle, s.u.postal ? 'Postal ' + s.u.postal : '', NOMBRE[s.u.c] || ''].filter(Boolean).join(' · ') : 'Ubicación no disponible (¿está en ER:LC?)';
      tx.append(t, n, d);
      const ir = document.createElement('button'); ir.type = 'button'; ir.textContent = 'Ver';
      ir.onclick = () => { if (s.u) irA(aPixel(s.u.x, s.u.z), V.fit * 3.2); };
      const x = document.createElement('button'); x.type = 'button'; x.textContent = 'Cerrar';
      x.onclick = () => { sosLista = sosLista.filter((q) => q !== s); pintarTarjetas(); dibujar(); };
      c.append(tx, ir, x); tarjetas.appendChild(c);
    }
  }
  // Tras cada lectura: reubica a quien pidió ayuda; la primera vez que se le encuentra, la vista va hacia él
  function ubicarSos() {
    let nuevo = null;
    for (const s of sosLista) {
      const u = unidadDe(s);
      if (u && !s.u) nuevo = s;
      if (u) s.u = u; // si deja de salir en la lista, se conserva su último punto conocido
    }
    pintarTarjetas();
    if (nuevo && nuevo.u) irA(aPixel(nuevo.u.x, nuevo.u.z), Math.max(V.k, V.fit * 3.2));
    if (hayAnimacion()) arrancarBucle();
  }

  // Lleva la vista al SOS más reciente que ya tenga posición. Devuelve false si no hay ninguno.
  function enfocarSos() {
    for (let i = sosLista.length - 1; i >= 0; i--) if (sosLista[i].u) { irA(aPixel(sosLista[i].u.x, sosLista[i].u.z), Math.max(V.k, V.fit * 3.2)); return true; }
    return false;
  }

  async function actualizar() {
    timer = null;
    if (parar || !abierto || enVuelo) return;
    enVuelo = true;
    let d;
    try { d = await window.nchrp.mapaDatos(); } catch (_) { d = { ok: false, error: 'red' }; }
    enVuelo = false;
    if (d && d.ok && Array.isArray(d.unidades)) {
      unidades = d.unidades.filter((u) => u && Number.isFinite(u.x) && Number.isFinite(u.z)).map((u) => ({
        n: String(u.n || 'Unidad').slice(0, 60), c: String(u.c || ''), cs: u.cs ? String(u.cs).slice(0, 20) : null,
        p: u.p ? String(u.p).slice(0, 8) : null,
        x: u.x, z: u.z, calle: u.calle ? String(u.calle).slice(0, 60) : '', postal: u.postal ? String(u.postal).slice(0, 10) : '',
      }));
      ultimo = Date.now(); hover = null; pintarLeyenda(); ubicarSos(); dibujar();
      aviso.className = 'aviso-mapa'; aviso.textContent = unidades.length ? '' : 'No hay unidades en servicio ahora mismo.';
    } else if (d && (d.error === 'sesion' || d.error === 'placa')) {
      parar = true; aviso.className = 'aviso-mapa err';
      aviso.textContent = 'Tu sesión venció. Inicia sesión otra vez en la radio.';
      return;
    } else {
      aviso.className = 'aviso-mapa err'; aviso.textContent = 'No se pudo leer el servidor de ER:LC. Reintentando…';
    }
    programar();
  }
  function programar() {
    if (timer || parar || !abierto) return;
    timer = setTimeout(actualizar, sosLista.length ? REFRESCO_SOS_MS : REFRESCO_MS);
  }
  function pedirYa() { if (timer) { clearTimeout(timer); timer = null; } actualizar(); }

  // ── Abrir / cerrar el panel (la ventana se ensancha hacia la derecha) ──
  const vista = () => $('#vista-radio');
  function marcarBoton() { const b = $('#abrir-mapa'); if (b) { b.classList[abierto ? 'add' : 'remove']('activo'); b.setAttribute && b.setAttribute('aria-pressed', abierto ? 'true' : 'false'); } }
  function abrir() {
    if (abierto) return;
    abierto = true; parar = false; panel.hidden = false;
    const v = vista(); if (v) v.classList.add('con-mapa');
    marcarBoton();
    try { window.nchrp.ventanaMapa(true); } catch (_) {}
    aviso.className = 'aviso-mapa'; if (!unidades.length) aviso.textContent = 'Cargando unidades…';
    // la ventana tarda un instante en ensancharse: se mide cuando ya tiene su tamaño final
    setTimeout(() => { if (!abierto) return; medir(); if (!enfocarSos()) centrar(); limitar(); dibujar(); }, 150);
    medir(); centrar(); dibujar();
    pedirYa();
    if (hayAnimacion()) arrancarBucle();
  }
  function cerrar() {
    if (!abierto) return;
    abierto = false; anim = null; panel.hidden = true;
    const v = vista(); if (v) v.classList.remove('con-mapa');
    if (timer) { clearTimeout(timer); timer = null; }
    marcarBoton(); tip.hidden = true;
    try { window.nchrp.ventanaMapa(false); } catch (_) {}
  }
  function alternar() { if (abierto) cerrar(); else abrir(); }

  // SOS recibido: se registra, se abre el panel (si el usuario lo quiere) y se pide la ubicación ya.
  function sos(info) {
    if (!info || !info.nombre) return;
    const s = { id: String(info.id || info.nombre), placa: info.placa ? String(info.placa) : '', nombre: String(info.nombre).slice(0, 60), canal: String(info.canal || ''), desde: Date.now(), u: null };
    sosLista = sosLista.filter((q) => q.id !== s.id); sosLista.push(s);
    while (sosLista.length > MAX_SOS) sosLista.shift();
    s.u = unidadDe(s); // si ya se tenía su posición de la última lectura
    pintarTarjetas();
    if (info.abrir !== false) { if (!abierto) abrir(); else pedirYa(); }
    if (abierto && s.u) irA(aPixel(s.u.x, s.u.z), Math.max(V.k, V.fit * 3.2));
    if (abierto && hayAnimacion()) arrancarBucle();
  }
  // Al cerrar sesión: se cierra el panel (la ventana recupera su ancho) y se olvida todo lo anterior
  function reiniciar() { cerrar(); sosLista = []; unidades = []; ultimo = 0; hover = null; parar = false; pintarTarjetas(); pintarLeyenda(); }
  function verSos() { if (!abierto) abrir(); else enfocarSos(); }

  // ── Interacción ──
  let arr = null;
  lienzo.addEventListener('pointerdown', (e) => { anim = null; arr = { x: e.clientX, y: e.clientY, tx: V.tx, ty: V.ty }; lienzo.classList.add('arrastrando'); try { lienzo.setPointerCapture(e.pointerId); } catch (_) {} });
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
  $('#centrar').onclick = () => { anim = null; centrar(); dibujar(); };
  $('#ver-nombres').onchange = dibujar;
  $('#cerrar-mapa').onclick = cerrar;
  $('#abrir-mapa').onclick = alternar;
  document.querySelectorAll && document.querySelectorAll('.mchip').forEach((b) => {
    b.onclick = () => { const c = b.dataset.c; filtro[c] = !filtro[c]; b.setAttribute('aria-pressed', filtro[c] ? 'true' : 'false'); hover = null; dibujar(); };
  });
  window.addEventListener('resize', () => { if (!abierto) return; const antes = V.fit; medir(); if (Math.abs(V.k - antes) < 1e-6) centrar(); limitar(); dibujar(); });
  setInterval(ponerHora, 1000);

  img.onload = () => { cargada = true; dibujar(); };
  img.onerror = () => { aviso.className = 'aviso-mapa err'; aviso.textContent = 'No se pudo cargar la imagen del mapa.'; };
  img.src = CAL.imagen;

  window.MapaPanel = { abrir, cerrar, alternar, sos, verSos, reiniciar, aPixel, aPantalla, buscar, V, unidades: () => unidades, sosActivos: () => sosLista, estaAbierto: () => abierto, centrar, medir, unidadDe };
})();
