'use strict';
// NCHRP Radio — ventana (login, canales, voz con LiveKit, efecto de radio y pitidos).
const $ = (s) => document.querySelector(s);
const puente = window.nchrp;
const LK = window.LivekitClient;

let cfg = {};
let usuario = null;        // {nombre, placa, cuerpo:{id,nombre}, canales:[{id,nombre}]}
let canalActual = null;
let room = null;
let generacion = 0;        // sube con cada conexión nueva; sirve para ignorar respuestas viejas
let reintentos = 0, timerReintento = null;
let micListo = false;      // el micrófono quedó publicado (y silenciado)
let micAbierto = false;    // true mientras se está transmitiendo
let pttOcupado = false;
let teclaAbajo = false, ratonAbajo = false;
// Susurro: segunda conexión (sin escuchar) a otro canal, con su propio micrófono silenciado
// Salas secundarias: una conexión por canal extra, que sirve para ESCUCHAR y/o para SUSURRAR
const sec = new Map();      // canalId -> {id, room, conectada, escucha, susurro, micListo, cerrada, antes, hablando, nombres}
let secGen = 0, secReintentos = 0, secTimer = null;
const W = {                 // estado del susurro (se calcula a partir de la sala secundaria de destino)
  get entrada() { for (const e of sec.values()) if (e.susurro && e.conectada && !e.cerrada) return e; return null; },
  get room() { const e = this.entrada; return e ? e.room : null; },
  get listo() { const e = this.entrada; return !!(e && e.micListo); },
  get canal() { const e = this.entrada; return e ? e.id : ''; },
  abierto: false, ocupado: false,
};
let hablandoMain = [];      // nombres de quienes hablan en el canal principal
let susurroAbajo = false;
let ctx = null, master = null;
const cadenas = new Map(); // trackSid -> {nodos, mudo}
let hablandoAntes = new Set();
let hablandoIds = new Set(); // identidades que están hablando ahora mismo en el canal

// ───────── Logo: bandera de Chicago (franjas azules y cuatro estrellas rojas) ─────────
function estrella(cx, cy, r) {
  const p = (a) => (cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1);
  const tri = (a0) => [0, 1, 2].map((i) => p(a0 + (i * 2 * Math.PI) / 3)).join(' ');
  return '<polygon points="' + tri(-Math.PI / 2) + '"/><polygon points="' + tri(Math.PI / 2) + '"/>';
}
const LOGO = '<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg"><rect width="120" height="80" fill="#eaf3ff"/>' +
  '<rect y="14" width="120" height="10" fill="#41b6e6"/><rect y="56" width="120" height="10" fill="#41b6e6"/>' +
  '<g fill="#e5384f">' + [20, 47, 73, 100].map((x) => estrella(x, 40, 11)).join('') + '</g></svg>';
document.querySelectorAll('[data-logo]').forEach((e) => { e.innerHTML = LOGO; });

// ───────── Mensajes y vistas ─────────
function msg(sel, texto, tipo) { const m = $(sel); m.textContent = texto || ''; m.className = 'msg' + (tipo ? ' ' + tipo : ''); }
const msgLogin = (t, err) => msg('#msg-login', t, err ? 'err' : '');
const msgRadio = (t, err) => msg('#msg-radio', t, err ? 'err' : '');

function setEstado(texto, clase) {
  $('#estado-texto').textContent = texto;
  $('#punto').className = 'punto' + (clase ? ' ' + clase : '');
}

// ───────── Estado de servicio (En servicio / Fuera de servicio) ─────────
let servicioTimer = null, servicioGen = 0;
function pintarServicio(d) {
  const e = $('#servicio'), v = window.NCHRP_SERVICIO ? window.NCHRP_SERVICIO.describir(d) : null;
  if (!v) { e.hidden = true; return; }
  e.textContent = v.texto; e.className = v.clase; e.title = v.ayuda; e.hidden = false;
}
function detenerServicio() {
  servicioGen++; clearTimeout(servicioTimer); servicioTimer = null;
  const e = $('#servicio'); if (e) e.hidden = true;
}
function iniciarServicio() {
  detenerServicio();
  if (typeof puente.estadoDatos !== 'function' || !window.NCHRP_SERVICIO) return;
  const mia = servicioGen;
  const tick = async () => {
    let d = null;
    try { d = await puente.estadoDatos(); } catch (_) { d = null; }
    if (mia !== servicioGen) return; // se cerró la sesión mientras esperaba
    pintarServicio(d);
    if (d && (d.error === 'sesion' || d.error === 'placa')) return; // sesión vencida: la radio ya avisará al pedir el token
    servicioTimer = setTimeout(tick, window.NCHRP_SERVICIO.REFRESCO_MS);
  };
  tick();
}

async function mostrarLogin(mensaje, esError) {
  generacion++; clearTimeout(timerReintento); detenerServicio();
  await soltarSala();
  await cerrarTodasSec();
  usuario = null; canalActual = null; teclaAbajo = ratonAbajo = susurroAbajo = false;
  delete document.body.dataset.cuerpo;
  cerrarAjustes(); cancelarPanico(); $('#alertas').innerHTML = '';
  if (window.MapaPanel) window.MapaPanel.reiniciar();
  $('#vista-radio').hidden = true; $('#vista-login').hidden = false;
  $('#pass').value = ''; $('#entrar').disabled = false;
  msgLogin(mensaje || '', esError);
  ($('#placa').value ? $('#pass') : $('#placa')).focus();
}

function mostrarRadio() {
  document.body.dataset.cuerpo = usuario.cuerpo.id;
  $('#nombre').textContent = usuario.nombre + ' (' + usuario.placa + ')';
  $('#chip').textContent = usuario.cuerpo.nombre;
  $('#c-nombre').textContent = usuario.nombre; $('#c-placa').textContent = usuario.placa; $('#c-cuerpo').textContent = usuario.cuerpo.nombre;
  $('#vista-login').hidden = true; $('#vista-radio').hidden = false;
  msgRadio('');
  pintarCanales(); pintarSusurroAjustes(); setEstado('Desconectado', ''); habilitarPtt(false);
  if (cfg.permisoTeclas === false) msgRadio('Falta el permiso de Accesibilidad para la tecla global (mira Configuración > Voz).', true);
  iniciarServicio();
}

function nombreCanal(id) { const c = usuario && usuario.canales.find((x) => x.id === id); return c ? c.nombre : id; }

const IC = {
  canal: '<svg viewBox="0 0 24 24"><path d="M4 9v6h3.5l5 4V5l-5 4H4zm12.5-1.2a5.2 5.2 0 0 1 0 8.4l-1-1.4a3.5 3.5 0 0 0 0-5.6l1-1.4z"/></svg>',
  oir: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h2v-8H5v-1a7 7 0 0 1 14 0v1h-2v8h2a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z"/></svg>',
  persona: '<svg viewBox="0 0 24 24"><path d="M12 12a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4zm0 2.1c-3.6 0-7.2 1.8-7.2 4.3v1.9h14.4v-1.9c0-2.5-3.6-4.3-7.2-4.3z"/></svg>',
};

function filaPersona(p, yo, habla) {
  const f = document.createElement('div');
  f.className = 'persona' + (yo ? ' yo' : '') + (habla ? ' habla' : '');
  const i2 = document.createElement('span'); i2.className = 'ic'; i2.innerHTML = IC.persona;
  const n2 = document.createElement('span'); n2.className = 'nom'; n2.textContent = (p.name || p.identity) + (yo ? ' (tú)' : '');
  f.append(i2, n2); return f;
}
const porNombre = (x, y) => String(x.name || x.identity).localeCompare(String(y.name || y.identity));

function pintarCanales() {
  const cont = $('#canales'); cont.innerHTML = '';
  if (!usuario) return;
  const escuchando = new Set(cfg.escuchaCanales || []);
  for (const c of usuario.canales) {
    const activo = c.id === canalActual;
    const e = sec.get(c.id);
    const oyendo = !activo && !!e && e.escucha;
    const destino = !!cfg.susurroTecla && c.id === cfg.susurroCanal && !activo;
    const caja = document.createElement('div'); caja.className = 'fila-canal';
    const fila = document.createElement('button');
    fila.type = 'button'; fila.dataset.canal = c.id;
    fila.className = 'canal' + (activo ? ' activo' : '') + (oyendo ? ' oyendo' : '') + (W.abierto && W.canal === c.id ? ' susurrando' : '');
    const ic = document.createElement('span'); ic.className = 'ic'; ic.innerHTML = IC.canal;
    const nom = document.createElement('span'); nom.className = 'nom'; nom.textContent = c.nombre;
    fila.append(ic, nom);
    const cuantos = activo && room ? 1 + room.remoteParticipants.size : (oyendo && e.conectada ? 1 + e.room.remoteParticipants.size : null);
    if (cuantos) { const n = document.createElement('span'); n.className = 'cuenta'; n.textContent = String(cuantos); fila.append(n); }
    if (destino) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'susurro'; fila.append(t); }
    fila.onclick = () => { if (c.id === canalActual && room) return; reintentos = 0; conectar(c.id); };
    const oir = document.createElement('button');
    oir.type = 'button'; oir.dataset.oir = c.id;
    const on = activo || escuchando.has(c.id);
    oir.className = 'oir' + (on ? ' on' : ''); oir.disabled = activo; oir.innerHTML = IC.oir;
    oir.title = activo ? 'Canal principal: siempre lo escuchas' : on ? 'Dejar de escuchar este canal' : 'Escuchar este canal además del principal';
    oir.setAttribute('aria-pressed', String(on));
    oir.onclick = () => alternarEscucha(c.id);
    caja.append(fila, oir); cont.appendChild(caja);
    if (activo && room) {
      const lista = document.createElement('div'); lista.className = 'hijos';
      const yo = room.localParticipant;
      const otros = [...room.remoteParticipants.values()].sort(porNombre);
      lista.appendChild(filaPersona(yo, true, micAbierto));
      for (const p of otros) lista.appendChild(filaPersona(p, false, hablandoIds.has(p.identity)));
      cont.appendChild(lista);
    } else if (oyendo && e.conectada) {
      const otros = [...e.room.remoteParticipants.values()].sort(porNombre);
      if (otros.length) {
        const lista = document.createElement('div'); lista.className = 'hijos';
        for (const p of otros) lista.appendChild(filaPersona(p, false, e.hablando.has(p.identity)));
        cont.appendChild(lista);
      }
    }
  }
}

function pintarPresentes() { pintarCanales(); }

// ───────── Audio: volumen, pitidos y efecto de radio ─────────
function aplicarVolumen() { if (master) master.gain.value = ((cfg.volumen == null ? 80 : cfg.volumen) / 100) * 1.5; }

function asegurarAudio() {
  if (!ctx) { ctx = new AudioContext(); master = ctx.createGain(); master.connect(ctx.destination); aplicarVolumen(); }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

function pitido(freq, dur) {
  if (!ctx || !master) return;
  dur = dur || 0.09;
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.03);
}

function curvaRadio() {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = Math.tanh(x * 2.2) / Math.tanh(2.2); }
  return c;
}

function conectarAudioRemoto(track, sid, grupo) {
  asegurarAudio(); quitarAudioRemoto(sid);
  const ms = new MediaStream([track.mediaStreamTrack]);
  const mudo = new Audio(); mudo.muted = true; mudo.srcObject = ms; mudo.play().catch(() => {}); // Chrome solo entrega el stream a WebAudio si está en un elemento
  const src = ctx.createMediaStreamSource(ms);
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 380;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
  const pk = ctx.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = 1600; pk.Q.value = 0.9; pk.gain.value = 5;
  const sh = ctx.createWaveShaper(); sh.curve = curvaRadio(); sh.oversample = '2x';
  const cp = ctx.createDynamicsCompressor(); cp.threshold.value = -28; cp.ratio.value = 8;
  const gn = ctx.createGain(); gn.gain.value = 1.4;
  src.connect(hp); hp.connect(lp); lp.connect(pk); pk.connect(sh); sh.connect(cp); cp.connect(gn); gn.connect(master);
  cadenas.set(sid, { nodos: [src, hp, lp, pk, sh, cp, gn], mudo, grupo: grupo || 'main' });
}

function quitarAudioRemoto(sid) {
  const c = cadenas.get(sid); if (!c) return;
  for (const n of c.nodos) { try { n.disconnect(); } catch (_) {} }
  c.mudo.srcObject = null; cadenas.delete(sid);
}
function limpiarAudio(grupo) {
  grupo = grupo || 'main';
  for (const [sid, c] of [...cadenas.entries()]) if (c.grupo === grupo) quitarAudioRemoto(sid);
  if (grupo === 'main') hablandoAntes = new Set();
}

// ───────── Conexión a la sala ─────────
const optsMic = () => Object.assign({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }, cfg.mic ? { deviceId: cfg.mic } : {});

async function soltarSala() {
  const r = room; room = null;
  micListo = false; micAbierto = false;
  limpiarAudio();
  if (r) { try { await r.disconnect(); } catch (_) {} }
  hablandoMain = []; hablandoIds = new Set(); pintarHablando();
  habilitarPtt(false);
}

function programarReintento() {
  reintentos++;
  if (reintentos > 6) { setEstado('Sin conexión', ''); msgRadio('Se perdió la conexión con la radio. Elige el canal otra vez para reconectar.', true); return; }
  clearTimeout(timerReintento);
  timerReintento = setTimeout(() => conectar(canalActual, true), Math.min(2000 * reintentos, 10000));
}

async function conectar(canalId, esReintento) {
  const mia = ++generacion;
  clearTimeout(timerReintento);
  asegurarAudio();
  await soltarSala();
  await cerrarSec(canalId);          // dos conexiones del mismo canal con la misma placa se expulsarían entre sí
  canalActual = canalId; pintarCanales();
  setEstado(esReintento ? 'Reconectando…' : 'Conectando…', 'esp');
  msgRadio('');
  const t = await puente.token(canalId);
  if (mia !== generacion) return;
  if (!t.ok) {
    setEstado('Desconectado', '');
    if (t.error === 'sesion' || t.error === 'placa') return mostrarLogin(t.mensaje, true);
    if (t.error === 'red') { msgRadio(t.mensaje, true); return programarReintento(); }
    return msgRadio(t.mensaje, true);
  }
  const r = new LK.Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  room = r; enlazar(r);
  try {
    await r.connect(t.url, t.token);
  } catch (e) {
    if (mia !== generacion) return;
    room = null; try { r.disconnect(); } catch (_) {}
    setEstado('Sin conexión', '');
    msgRadio('No se pudo conectar el audio de la radio. Si pasa siempre, avisa a un administrador.', true);
    return programarReintento();
  }
  if (mia !== generacion) { try { r.disconnect(); } catch (_) {} return; }
  reintentos = 0;
  setEstado('Conectado · ' + nombreCanal(canalId), 'on');
  pintarPresentes();
  try {
    await r.localParticipant.setMicrophoneEnabled(true, optsMic());   // publica el micrófono…
    if (mia !== generacion) return;
    await r.localParticipant.setMicrophoneEnabled(false);              // …y lo deja silenciado hasta pulsar la tecla
    micListo = true; micAbierto = false;
    llenarMics();
  } catch (e) {
    micListo = false;
    msgRadio('No se pudo usar el micrófono. Revisa los permisos de Windows (Privacidad > Micrófono). Puedes escuchar pero no hablar.', true);
  }
  if (mia !== generacion) return;
  habilitarPtt(true);
  if (teclaAbajo || ratonAbajo) ptt();
  sincronizarSalas();
}

function enlazar(r) {
  const E = LK.RoomEvent;
  r.on(E.TrackSubscribed, (track, pub) => { if (track.kind === LK.Track.Kind.Audio) conectarAudioRemoto(track, pub.trackSid); });
  r.on(E.TrackUnsubscribed, (track, pub) => quitarAudioRemoto(pub.trackSid));
  r.on(E.ParticipantConnected, () => { if (room === r) pintarPresentes(); });
  r.on(E.ParticipantDisconnected, () => { if (room === r) pintarPresentes(); });
  r.on(E.ActiveSpeakersChanged, (hablan) => alHablar(r, hablan));
  r.on(E.DataReceived, (payload, participante, _kind, topic) => { if (room === r) alRecibirDatos(canalActual, payload, participante, topic); });
  r.on(E.Disconnected, () => {
    if (room !== r) return;                       // lo cerramos nosotros a propósito
    room = null; micListo = false; micAbierto = false; limpiarAudio();
    habilitarPtt(false); setEstado('Reconectando…', 'esp');
    hablandoMain = []; hablandoIds = new Set(); pintarHablando();
    programarReintento();
  });
}

function alHablar(r, hablan) {
  if (room !== r) return;
  hablandoIds = new Set(hablan.map((p) => p.identity));
  pintarCanales();
  const otros = hablan.filter((p) => !p.isLocal);
  const ahora = new Set(otros.map((p) => p.identity));
  const antes = hablandoAntes; hablandoAntes = ahora;
  if (antes.size === 0 && ahora.size > 0) pitido(1100);        // alguien empieza a hablar
  else if (antes.size > 0 && ahora.size === 0) pitido(750);    // terminó la transmisión
  hablandoMain = otros.map((p) => p.name || p.identity);
  pintarHablando();
}

function pintarHablando() {
  const partes = [];
  if (hablandoMain.length) partes.push(hablandoMain.join(', '));
  for (const e of sec.values()) if (e.escucha && e.nombres.length) partes.push(e.nombres.join(', ') + ' (' + nombreCanal(e.id) + ')');
  $('#hablando').textContent = partes.length ? '🎙 ' + partes.join(' · ') : '';
}

// ───────── Pulsar para hablar ─────────
function pintarPtt() {
  const b = $('#ptt');
  b.classList.toggle('tx', micAbierto || W.abierto);
  $('#ptt-t').textContent = W.abierto ? 'SUSURRO' : micAbierto ? 'EN EL AIRE' : 'HABLAR';
  let sub = 'Conéctate a un canal';
  if (W.abierto) sub = 'Hablando en ' + nombreCanal(W.canal);
  else if (micAbierto) sub = 'Suelta para terminar';
  else if (room && micListo) sub = cfg.teclaGlobal ? 'Mantén ' + cfg.tecla : 'Mantén pulsado el botón';
  else if (room) sub = 'Micrófono no disponible';
  $('#ptt-sub').textContent = sub;
  pintarCanales(); pintarPanico();
}
function habilitarPtt(v) { $('#ptt').disabled = !v; pintarPtt(); }

// Mientras se susurra (y el susurro está listo), el canal principal no transmite
function quierePtt() { return (teclaAbajo || ratonAbajo) && !(susurroAbajo && W.listo); }

async function ptt() {
  if (pttOcupado) return;
  pttOcupado = true;
  try {
    while (room && micListo && micAbierto !== quierePtt()) {
      const r = room, quiere = quierePtt();
      if (quiere) pitido(1400);
      await r.localParticipant.setMicrophoneEnabled(quiere, quiere ? optsMic() : undefined);
      micAbierto = quiere;
      if (!quiere) pitido(900);
      pintarPtt();
    }
  } catch (e) {
    micAbierto = false;
    msgRadio('No se pudo activar el micrófono.', true);
  } finally { pttOcupado = false; pintarPtt(); }
}

puente.alPtt((d) => { teclaAbajo = !!d.abajo; ptt(); });
puente.alSusurro((d) => { susurroAbajo = !!d.abajo; ptt(); susurro(); });
const btnPtt = $('#ptt');
btnPtt.addEventListener('pointerdown', (e) => { if (btnPtt.disabled) return; btnPtt.setPointerCapture(e.pointerId); ratonAbajo = true; ptt(); });
['pointerup', 'pointercancel'].forEach((ev) => btnPtt.addEventListener(ev, () => { ratonAbajo = false; ptt(); }));


// ───────── Canales secundarios: escuchar varios canales y susurrar ─────────
async function susurro() {
  if (W.ocupado) return;
  W.ocupado = true;
  try {
    while (W.listo && W.abierto !== susurroAbajo) {
      const e = W.entrada, quiere = susurroAbajo;
      if (quiere) pitido(1700);
      await e.room.localParticipant.setMicrophoneEnabled(quiere, quiere ? optsMic() : undefined);
      W.abierto = quiere;
      if (!quiere) pitido(1100);
      pintarPtt();
    }
  } catch (e) {
    W.abierto = false;
    msgRadio('No se pudo activar el susurro.', true);
  } finally { W.ocupado = false; pintarPtt(); }
}

async function cerrarSec(id) {
  const e = sec.get(id); if (!e) return;
  if (e.susurro) W.abierto = false;
  e.cerrada = true; sec.delete(id);
  limpiarAudio(id);
  if (e.room) { try { await e.room.disconnect(); } catch (_) {} }
  pintarCanales(); pintarHablando();
}

async function cerrarTodasSec() {
  secGen++; clearTimeout(secTimer); secReintentos = 0;
  for (const id of [...sec.keys()]) await cerrarSec(id);
  W.abierto = false;
}

function programarSec() {
  secReintentos++;
  if (secReintentos > 4) return;
  clearTimeout(secTimer);
  secTimer = setTimeout(() => sincronizarSalas(), Math.min(3000 * secReintentos, 15000));
}

// Deja las conexiones secundarias como deben estar según los ajustes (canales que escuchas + canal de susurro)
async function sincronizarSalas() {
  pintarAvisoSusurro();
  if (!usuario) return;
  const valido = (id) => !!id && id !== canalActual && usuario.canales.some((c) => c.id === id);
  const escuchar = new Set((cfg.escuchaCanales || []).filter(valido));
  const dest = valido(cfg.susurroCanal) ? cfg.susurroCanal : '';
  const necesarios = new Set([...escuchar]); if (dest) necesarios.add(dest);
  for (const id of [...sec.keys()]) if (!necesarios.has(id)) await cerrarSec(id);
  for (const id of necesarios) {
    let e = sec.get(id);
    const nuevo = !e;
    if (nuevo) {
      e = { id, room: null, conectada: false, escucha: false, susurro: false, micListo: false, cerrada: false, antes: new Set(), hablando: new Set(), nombres: [] };
      sec.set(id, e);
    }
    e.escucha = escuchar.has(id); e.susurro = id === dest;
    if (nuevo) conectarSec(e).catch(() => {}); else aplicarFlags(e).catch(() => {});
  }
  pintarCanales(); pintarPtt(); pintarHablando();
}

async function conectarSec(e) {
  const mia = e.gen = ++secGen;
  const t = await puente.token(e.id);
  if (e.cerrada || mia !== e.gen) return;
  if (!t.ok) {
    sec.delete(e.id); e.cerrada = true; pintarCanales();
    if (t.error === 'sesion' || t.error === 'placa') return mostrarLogin(t.mensaje, true);
    return programarSec();
  }
  const r = new LK.Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  e.room = r;
  const E = LK.RoomEvent;
  r.on(E.TrackPublished, (pub) => { if (e.escucha && pub.kind === LK.Track.Kind.Audio) { try { pub.setSubscribed(true); } catch (_) {} } });
  r.on(E.TrackSubscribed, (track, pub) => {
    if (track.kind !== LK.Track.Kind.Audio) return;
    if (!e.escucha) { try { pub.setSubscribed(false); } catch (_) {} return; }
    conectarAudioRemoto(track, pub.trackSid, e.id);
  });
  r.on(E.TrackUnsubscribed, (track, pub) => quitarAudioRemoto(pub.trackSid));
  r.on(E.ParticipantConnected, () => { if (sec.get(e.id) === e) pintarCanales(); });
  r.on(E.ParticipantDisconnected, () => { if (sec.get(e.id) === e) pintarCanales(); });
  r.on(E.ActiveSpeakersChanged, (hablan) => alHablarSec(e, hablan));
  r.on(E.DataReceived, (payload, participante, _kind, topic) => { if (e.escucha && sec.get(e.id) === e) alRecibirDatos(e.id, payload, participante, topic); });
  r.on(E.Disconnected, () => {
    if (e.cerrada) return;                        // lo cerramos nosotros a propósito
    e.cerrada = true; limpiarAudio(e.id);
    if (sec.get(e.id) === e) sec.delete(e.id);
    if (e.susurro) W.abierto = false;
    pintarCanales(); pintarPtt(); pintarHablando(); ptt(); programarSec();
  });
  try {
    await r.connect(t.url, t.token, { autoSubscribe: false });   // la suscripción al audio se activa solo si escuchas ese canal
  } catch (_) {
    if (e.cerrada || mia !== e.gen) return;
    e.cerrada = true; if (sec.get(e.id) === e) sec.delete(e.id);
    try { r.disconnect(); } catch (_) {}
    pintarCanales();
    return programarSec();
  }
  if (e.cerrada || mia !== e.gen) { try { r.disconnect(); } catch (_) {} return; }
  e.conectada = true; secReintentos = 0;
  await aplicarFlags(e);
  pintarCanales(); pintarPtt();
  if (susurroAbajo) { ptt(); susurro(); }
}

// Aplica a una sala ya conectada lo que toca: escuchar (suscribir audio) y/o susurrar (micrófono listo)
async function aplicarFlags(e) {
  if (!e.conectada || e.cerrada) return;
  for (const p of e.room.remoteParticipants.values()) {
    const pubs = p.trackPublications || p.tracks;
    if (!pubs) continue;
    for (const pub of pubs.values()) if (pub.kind === LK.Track.Kind.Audio) { try { pub.setSubscribed(e.escucha); } catch (_) {} }
  }
  if (!e.escucha) limpiarAudio(e.id);
  if (e.susurro && !e.micListo && !e.publicando) {
    e.publicando = true;
    try {
      await e.room.localParticipant.setMicrophoneEnabled(true, optsMic());
      if (!e.cerrada) await e.room.localParticipant.setMicrophoneEnabled(false);
      if (!e.cerrada) e.micListo = true;
    } catch (_) {
      msgRadio('No se pudo preparar el micrófono para el susurro.', true);
    }
    e.publicando = false;
  }
  pintarPtt();
  if (susurroAbajo) { ptt(); susurro(); }
}

function alHablarSec(e, hablan) {
  if (sec.get(e.id) !== e) return;
  e.hablando = new Set(hablan.map((p) => p.identity));
  const otros = hablan.filter((p) => !p.isLocal);
  e.nombres = otros.map((p) => p.name || p.identity);
  if (e.escucha) {
    const ahora = new Set(otros.map((p) => p.identity)), antes = e.antes; e.antes = ahora;
    if (antes.size === 0 && ahora.size > 0) pitido(1000);
    else if (antes.size > 0 && ahora.size === 0) pitido(650);
  }
  pintarCanales(); pintarHablando();
}

function alternarEscucha(id) {
  const lista = new Set(cfg.escuchaCanales || []);
  if (lista.has(id)) lista.delete(id);
  else {
    if (lista.size >= 4) { msgRadio('Puedes escuchar hasta 4 canales extra a la vez.', true); return; }
    lista.add(id);
  }
  cfg.escuchaCanales = [...lista];
  puente.guardarConfig({ escuchaCanales: cfg.escuchaCanales });
  secReintentos = 0; sincronizarSalas();
}

// ───────── Pánico: aviso de emergencia por la misma sala (mensajes de datos de LiveKit) ─────────
let panicoHasta = 0, panicoTimer = null, panicoReloj = null;
const ultimoPanico = new Map();   // identidad -> última vez que mandó un aviso (freno anti-spam)
const COOLDOWN_PANICO = 10000, ESPERA_PANICO = 1500;

// Alarma de SOS. Si existe sonidos/panico.mp3 (.ogg/.wav) se usa ese audio (p. ej. el del pánico de ER:LC);
// si no, suena un tono de emergencia de radio: 3 ráfagas de pulsos rápidos (~3,5 s).
// Va por su propio volumen para oírse aunque la radio esté baja, con un mínimo.
const audioPanico = document.createElement('audio');
let audioPanicoOk = false;
audioPanico.preload = 'auto';
for (const ext of ['mp3', 'ogg', 'wav']) { const f = document.createElement('source'); f.src = 'sonidos/panico.' + ext; audioPanico.appendChild(f); }
audioPanico.addEventListener('canplay', () => { audioPanicoOk = true; });
function volumenAlarma() { return Math.min(0.5, Math.max(0.22, ((cfg.volumen == null ? 80 : cfg.volumen) / 100) * 0.45)); }
function tonoEmergencia() {
  asegurarAudio(); if (!ctx || !master) return;
  const vol = volumenAlarma(), t0 = ctx.currentTime, sal = ctx.createGain();
  sal.gain.value = 1; sal.connect(ctx.destination);
  for (let r = 0; r < 3; r++) for (let i = 0; i < 6; i++) {
    const o = ctx.createOscillator(), g = ctx.createGain(), t = t0 + r * 1.2 + i * 0.14;
    o.type = 'square'; o.frequency.value = 1750;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.setValueAtTime(vol, t + 0.075);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g); g.connect(sal); o.start(t); o.stop(t + 0.1);
  }
}
function sirena() {
  if (audioPanicoOk) {
    try {
      audioPanico.currentTime = 0; audioPanico.volume = Math.max(0.6, Math.min(1, (cfg.volumen == null ? 80 : cfg.volumen) / 100));
      const p = audioPanico.play(); if (p && p.catch) p.catch(tonoEmergencia);
      return;
    } catch (_) {}
  }
  tonoEmergencia();
}

function pintarPanico() {
  const b = $('#panico'), resta = Math.ceil((panicoHasta - Date.now()) / 1000);
  const enfriando = resta > 0;
  b.disabled = !room || enfriando;
  $('#panico-t').textContent = enfriando ? String(resta) : 'SOS';
  if (enfriando && !panicoReloj) panicoReloj = setInterval(() => { pintarPanico(); if (Date.now() >= panicoHasta) { clearInterval(panicoReloj); panicoReloj = null; } }, 500);
}

async function enviarPanico() {
  if (!room || Date.now() < panicoHasta) return;
  const r = room, canal = nombreCanal(canalActual);
  const otros = r.remoteParticipants ? r.remoteParticipants.size : 0;
  try {
    await r.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ t: 'panico', v: 1 })), { reliable: true, topic: 'panico' });
  } catch (e) {
    msgRadio('No se pudo enviar el aviso de pánico (' + String((e && e.message) || 'error').slice(0, 80) + '). Inténtalo otra vez.', true); return;
  }
  panicoHasta = Date.now() + COOLDOWN_PANICO; pintarPanico();
  mostrarAlerta((usuario && usuario.nombre ? usuario.nombre : 'Tú') + (usuario && usuario.placa ? ' (' + usuario.placa + ')' : ''), canal, false, true,
    { id: 'placa-' + (usuario && usuario.placa), placa: usuario && usuario.placa, nombre: usuario && usuario.nombre });
  if (otros > 0) msgRadio('Aviso de pánico enviado al canal ' + canal + ' (' + otros + (otros === 1 ? ' persona conectada' : ' personas conectadas') + ').');
  else msgRadio('Aviso enviado al canal ' + canal + ', pero no hay nadie más conectado ahí ahora mismo.', true);
}

function empezarPanico() {
  if ($('#panico').disabled || panicoTimer) return;
  $('#panico').classList.add('cargando');
  panicoTimer = setTimeout(() => { panicoTimer = null; $('#panico').classList.remove('cargando'); enviarPanico(); }, ESPERA_PANICO);
}
function cancelarPanico() { clearTimeout(panicoTimer); panicoTimer = null; $('#panico').classList.remove('cargando'); }
{
  const b = $('#panico');
  b.addEventListener('pointerdown', (e) => { if (e.button === 0 || e.button === undefined) empezarPanico(); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, cancelarPanico);
  b.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); empezarPanico(); } });
  b.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') cancelarPanico(); });
  b.addEventListener('blur', cancelarPanico);
}

// Lo que llega de otros: solo se confía en la IDENTIDAD que pone el servidor, nunca en el contenido del mensaje
function alRecibirDatos(canalId, payload, participante, topic) {
  if (topic !== 'panico' || !participante || participante.isLocal) return;
  let d; try { d = JSON.parse(new TextDecoder().decode(payload)); } catch (_) { return; }
  if (!d || d.t !== 'panico') return;
  const id = String(participante.identity || ''), ahora = Date.now();
  if ((ultimoPanico.get(id) || 0) > ahora - 5000) return;
  ultimoPanico.set(id, ahora);
  const placa = /^placa-(\d{1,6})$/.exec(id);
  const nombre = participante.name || (placa ? 'Placa ' + placa[1] : id);
  mostrarAlerta(nombre, nombreCanal(canalId), false, false, { id, placa: placa ? placa[1] : '', nombre });
}

const MAX_ALERTAS = 3, VIDA_ALERTA_MS = 120000;
function hora() { const f = new Date(); return String(f.getHours()).padStart(2, '0') + ':' + String(f.getMinutes()).padStart(2, '0'); }

// Letrero rojo parpadeante abajo (encima de los botones): quién pide ayuda y en qué canal. Se queda hasta "Entendido" (o 2 min).
function mostrarAlerta(quien, canal, prueba, propia, mapa) {
  const caja = $('#alertas');
  while (caja.children.length >= MAX_ALERTAS) caja.removeChild(caja.firstChild);
  const a = document.createElement('div'); a.className = 'alerta' + (prueba ? ' prueba' : ''); a.setAttribute('role', 'alert');
  a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 1 21h22L12 2zm1 15h-2v-2h2v2zm0-4h-2V9h2v4z"/></svg>';
  const c = document.createElement('div'); c.className = 'cuerpo';
  const t = document.createElement('b'); t.textContent = prueba ? 'PRUEBA DE PÁNICO' : propia ? 'TU AVISO DE PÁNICO' : 'PÁNICO · SOLICITA AYUDA';
  const q = document.createElement('span'); q.className = 'quien-pide'; q.textContent = quien;
  const w = document.createElement('span'); w.className = 'donde'; w.textContent = 'Canal ' + canal + ' · ' + hora();
  c.append(t, q, w);
  const x = document.createElement('button'); x.type = 'button'; x.textContent = 'Entendido';
  const quitar = () => { clearTimeout(tm); if (a.parentNode) a.parentNode.removeChild(a); };
  x.onclick = quitar;
  const tm = setTimeout(quitar, VIDA_ALERTA_MS);
  a.append(c);
  if (mapa && window.MapaPanel) {
    const v = document.createElement('button'); v.type = 'button'; v.textContent = 'Ver en mapa';
    v.onclick = () => window.MapaPanel.verSos();
    a.append(v);
  }
  a.append(x); caja.appendChild(a);
  sirena();
  // El mapa se abre solo y muestra dónde está quien pide ayuda (se puede desactivar en Ajustes > Ventana)
  if (mapa && window.MapaPanel) window.MapaPanel.sos(Object.assign({ canal, abrir: cfg.mapaSos !== false }, mapa));
  try { puente.alertar(); } catch (_) {}
}
$('#probar-alarma').onclick = () => { mostrarAlerta((usuario && usuario.nombre ? usuario.nombre : 'Tu nombre') + ' (prueba)', canalActual ? nombreCanal(canalActual) : 'Canal', true); };

// ───────── Rueda de configuración (ventana con pestañas) ─────────
function irTab(n) {
  document.querySelectorAll('.tab').forEach((b) => { const a = b.dataset.tab === n; b.classList.toggle('activa', a); b.setAttribute('aria-selected', String(a)); });
  document.querySelectorAll('[data-pagina]').forEach((p) => { p.hidden = p.dataset.pagina !== n; });
}
function abrirAjustes() { $('#modal-ajustes').hidden = false; irTab('voz'); llenarMics(); $('#cerrar-ajustes').focus(); }
function cerrarAjustes() { $('#modal-ajustes').hidden = true; }
$('#abrir-ajustes').onclick = abrirAjustes;
$('#cerrar-ajustes').onclick = cerrarAjustes;
document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => irTab(b.dataset.tab); });
$('#modal-ajustes').addEventListener('pointerdown', (e) => { if (e.target === $('#modal-ajustes')) cerrarAjustes(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal-ajustes').hidden) cerrarAjustes(); });

// ───────── Ajustes ─────────
async function llenarMics() {
  try {
    const lista = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const sel = $('#mic'); sel.innerHTML = '';
    const base = document.createElement('option'); base.value = ''; base.textContent = 'Predeterminado'; sel.appendChild(base);
    for (const d of lista) { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || 'Micrófono'; sel.appendChild(o); }
    sel.value = cfg.mic || '';
    if (sel.value !== (cfg.mic || '')) sel.value = '';
  } catch (_) {}
}

$('#mic').onchange = async () => {
  cfg.mic = $('#mic').value; puente.guardarConfig({ mic: cfg.mic });
  if (room && micListo) { try { await room.switchActiveDevice('audioinput', cfg.mic || 'default'); } catch (_) { msgRadio('No se pudo cambiar el micrófono.', true); } }
};
$('#vol').oninput = () => { cfg.volumen = Number($('#vol').value); aplicarVolumen(); };
$('#vol').onchange = () => puente.guardarConfig({ volumen: cfg.volumen });
$('#ontop').onchange = () => puente.siempreVisible($('#ontop').checked);
$('#mapa-sos').onchange = () => { cfg.mapaSos = $('#mapa-sos').checked; puente.guardarConfig({ mapaSos: cfg.mapaSos }); };

function pintarAvisoSusurro() {
  const a = $('#aviso-susurro'); let t = '';
  if (cfg.susurroCanal && !cfg.susurroTecla) t = 'Elige también una tecla de susurro.';
  else if (!cfg.susurroCanal && cfg.susurroTecla) t = 'Elige en qué canal quieres susurrar.';
  else if (cfg.susurroCanal && cfg.susurroCanal === canalActual) t = 'Ya estás en ese canal: elige otro para susurrar.';
  a.textContent = t; a.hidden = !t;
}

function pintarSusurroAjustes() {
  const sel = $('#canal-s'); sel.innerHTML = '';
  const ninguno = document.createElement('option'); ninguno.value = ''; ninguno.textContent = 'Ninguno'; sel.appendChild(ninguno);
  for (const c of usuario.canales) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.nombre; sel.appendChild(o); }
  sel.value = cfg.susurroCanal || '';
  if (sel.value !== (cfg.susurroCanal || '')) sel.value = '';
  $('#tecla-s').textContent = cfg.susurroTecla || '—';
  pintarAvisoSusurro();
}

$('#canal-s').onchange = () => {
  cfg.susurroCanal = $('#canal-s').value; puente.guardarConfig({ susurroCanal: cfg.susurroCanal });
  secReintentos = 0; pintarAvisoSusurro(); sincronizarSalas();
};
$('#cambiar-tecla-s').onclick = async () => {
  const ok = await puente.capturarTecla('susurro');
  if (!ok) { msgRadio('La tecla global no está disponible en este equipo.', true); return; }
  $('#tecla-s').textContent = 'Pulsa la tecla…'; $('#cambiar-tecla-s').disabled = true; $('#cambiar-tecla').disabled = true;
};
$('#quitar-tecla-s').onclick = async () => {
  await puente.quitarSusurro();
  cfg.susurroTecla = ''; susurroAbajo = false; $('#tecla-s').textContent = '—';
  pintarAvisoSusurro(); ptt(); susurro();
};
$('#cambiar-tecla').onclick = async () => {
  const ok = await puente.capturarTecla('ptt');
  if (!ok) { msgRadio('La tecla global no está disponible en este equipo.', true); return; }
  $('#tecla').textContent = 'Pulsa la tecla que quieras…'; $('#cambiar-tecla').disabled = true; $('#cambiar-tecla-s').disabled = true;
};
puente.alCapturar((d) => {
  $('#cambiar-tecla').disabled = false; $('#cambiar-tecla-s').disabled = false;
  if (d.error) {
    $('#tecla').textContent = cfg.tecla; $('#tecla-s').textContent = cfg.susurroTecla || '—';
    msgRadio('Esa tecla ya se usa para ' + (d.cual === 'ptt' ? 'el susurro' : 'hablar') + '. Elige otra.', true);
    return;
  }
  if (d.cual === 'susurro') { cfg.susurroTecla = d.nombre; $('#tecla-s').textContent = d.nombre; susurroAbajo = false; ptt(); susurro(); }
  else { cfg.tecla = d.nombre; $('#tecla').textContent = d.nombre; teclaAbajo = false; }
  pintarPtt(); pintarAvisoSusurro();
});

// ───────── Login / salir ─────────
async function entrar() {
  const placa = $('#placa').value.trim(), pass = $('#pass').value;
  if (!/^[1-9]\d{3}$/.test(placa)) return msgLogin('La placa debe tener 4 números.', true);
  if (!pass) return msgLogin('Escribe tu contraseña.', true);
  $('#entrar').disabled = true; msgLogin('Entrando…');
  asegurarAudio();
  const d = await puente.login(placa, pass);
  $('#entrar').disabled = false;
  if (!d.ok) return msgLogin(d.mensaje || 'No se pudo iniciar sesión.', true);
  $('#pass').value = '';
  usuario = { nombre: d.nombre, placa: d.placa, cuerpo: d.cuerpo, canales: d.canales };
  mostrarRadio();
  reintentos = 0;
  conectar(d.canales[0].id);
}

$('#entrar').onclick = entrar;
$('#placa').oninput = () => { $('#placa').value = $('#placa').value.replace(/\D/g, ''); };
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#vista-login').hidden) entrar(); });
$('#olvide').onclick = (e) => { e.preventDefault(); puente.olvide(); };
$('#salir').onclick = async () => { await puente.logout(); mostrarLogin(''); };

(async () => {
  cfg = await puente.config();
  $('#placa').value = cfg.placa || '';
  $('#version').textContent = 'NCHRP Radio v' + cfg.version; $('#version2').textContent = 'NCHRP Radio v' + cfg.version;
  $('#vol').value = cfg.volumen; $('#ontop').checked = !!cfg.siempreVisible; $('#mapa-sos').checked = cfg.mapaSos !== false;
  $('#tecla').textContent = cfg.tecla; $('#tecla-s').textContent = cfg.susurroTecla || '—'; 
  if (!cfg.teclaGlobal) { $('#aviso-tecla').textContent = 'La tecla global no está disponible en este equipo. Usa el botón HABLAR con el ratón.'; $('#aviso-tecla').hidden = false; }
  else if (cfg.permisoTeclas === false) { $('#aviso-tecla').textContent = 'Falta un permiso del Mac: abre Ajustes del Sistema > Privacidad y seguridad, activa NCHRP Radio en Accesibilidad y en Monitorización de entrada, y vuelve a abrir la app.'; $('#aviso-tecla').hidden = false; }
  else $('#aviso-tecla').hidden = true;
  ($('#placa').value ? $('#pass') : $('#placa')).focus();
})();
