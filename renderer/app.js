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
let ctx = null, master = null;
const cadenas = new Map(); // trackSid -> {nodos, mudo}
let hablandoAntes = new Set();

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

async function mostrarLogin(mensaje, esError) {
  generacion++; clearTimeout(timerReintento);
  await soltarSala();
  usuario = null; canalActual = null; teclaAbajo = ratonAbajo = false;
  delete document.body.dataset.cuerpo;
  $('#vista-radio').hidden = true; $('#vista-login').hidden = false;
  $('#pass').value = ''; $('#entrar').disabled = false;
  msgLogin(mensaje || '', esError);
  ($('#placa').value ? $('#pass') : $('#placa')).focus();
}

function mostrarRadio() {
  document.body.dataset.cuerpo = usuario.cuerpo.id;
  $('#nombre').textContent = usuario.nombre + ' (' + usuario.placa + ')';
  $('#chip').textContent = usuario.cuerpo.nombre;
  $('#vista-login').hidden = true; $('#vista-radio').hidden = false;
  msgRadio('');
  pintarCanales(); setEstado('Desconectado', ''); habilitarPtt(false);
}

function nombreCanal(id) { const c = usuario && usuario.canales.find((x) => x.id === id); return c ? c.nombre : id; }

function pintarCanales() {
  const cont = $('#canales'); cont.innerHTML = '';
  for (const c of usuario.canales) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'canal' + (c.id === canalActual ? ' activo' : ''); b.textContent = c.nombre;
    b.onclick = () => { reintentos = 0; conectar(c.id); };
    cont.appendChild(b);
  }
}

function pintarPresentes() {
  if (!room) { $('#presentes').textContent = ''; return; }
  const todos = [room.localParticipant, ...room.remoteParticipants.values()];
  const nombres = todos.map((p) => p.name || p.identity);
  $('#presentes').textContent = 'En el canal (' + todos.length + '): ' + nombres.slice(0, 6).join(', ') + (nombres.length > 6 ? '…' : '');
}

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

function conectarAudioRemoto(track, sid) {
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
  cadenas.set(sid, { nodos: [src, hp, lp, pk, sh, cp, gn], mudo });
}

function quitarAudioRemoto(sid) {
  const c = cadenas.get(sid); if (!c) return;
  for (const n of c.nodos) { try { n.disconnect(); } catch (_) {} }
  c.mudo.srcObject = null; cadenas.delete(sid);
}
function limpiarAudio() { for (const sid of [...cadenas.keys()]) quitarAudioRemoto(sid); hablandoAntes = new Set(); }

// ───────── Conexión a la sala ─────────
const optsMic = () => Object.assign({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }, cfg.mic ? { deviceId: cfg.mic } : {});

async function soltarSala() {
  const r = room; room = null;
  micListo = false; micAbierto = false;
  limpiarAudio();
  if (r) { try { await r.disconnect(); } catch (_) {} }
  $('#hablando').textContent = ''; $('#presentes').textContent = '';
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
}

function enlazar(r) {
  const E = LK.RoomEvent;
  r.on(E.TrackSubscribed, (track, pub) => { if (track.kind === LK.Track.Kind.Audio) conectarAudioRemoto(track, pub.trackSid); });
  r.on(E.TrackUnsubscribed, (track, pub) => quitarAudioRemoto(pub.trackSid));
  r.on(E.ParticipantConnected, () => { if (room === r) pintarPresentes(); });
  r.on(E.ParticipantDisconnected, () => { if (room === r) pintarPresentes(); });
  r.on(E.ActiveSpeakersChanged, (hablan) => alHablar(r, hablan));
  r.on(E.Disconnected, () => {
    if (room !== r) return;                       // lo cerramos nosotros a propósito
    room = null; micListo = false; micAbierto = false; limpiarAudio();
    habilitarPtt(false); setEstado('Reconectando…', 'esp');
    $('#hablando').textContent = ''; $('#presentes').textContent = '';
    programarReintento();
  });
}

function alHablar(r, hablan) {
  if (room !== r) return;
  const otros = hablan.filter((p) => !p.isLocal);
  const ahora = new Set(otros.map((p) => p.identity));
  const antes = hablandoAntes; hablandoAntes = ahora;
  if (antes.size === 0 && ahora.size > 0) pitido(1100);        // alguien empieza a hablar
  else if (antes.size > 0 && ahora.size === 0) pitido(750);    // terminó la transmisión
  $('#hablando').textContent = otros.length ? '🎙 ' + otros.map((p) => p.name || p.identity).join(', ') : '';
}

// ───────── Pulsar para hablar ─────────
function pintarPtt() {
  const b = $('#ptt');
  b.classList.toggle('tx', micAbierto);
  $('#ptt-t').textContent = micAbierto ? 'EN EL AIRE' : 'HABLAR';
  let sub = 'Conéctate a un canal';
  if (micAbierto) sub = 'Suelta para terminar';
  else if (room && micListo) sub = cfg.teclaGlobal ? 'Mantén ' + cfg.tecla : 'Mantén pulsado el botón';
  else if (room) sub = 'Micrófono no disponible';
  $('#ptt-sub').textContent = sub;
}
function habilitarPtt(v) { $('#ptt').disabled = !v; pintarPtt(); }

async function ptt() {
  if (pttOcupado) return;
  pttOcupado = true;
  try {
    while (room && micListo && micAbierto !== (teclaAbajo || ratonAbajo)) {
      const r = room, quiere = teclaAbajo || ratonAbajo;
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
const btnPtt = $('#ptt');
btnPtt.addEventListener('pointerdown', (e) => { if (btnPtt.disabled) return; btnPtt.setPointerCapture(e.pointerId); ratonAbajo = true; ptt(); });
['pointerup', 'pointercancel'].forEach((ev) => btnPtt.addEventListener(ev, () => { ratonAbajo = false; ptt(); }));

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
$('#cambiar-tecla').onclick = async () => {
  const ok = await puente.capturarTecla();
  if (!ok) { msgRadio('La tecla global no está disponible en este equipo.', true); return; }
  $('#tecla').textContent = 'Pulsa la tecla que quieras…'; $('#cambiar-tecla').disabled = true;
};
puente.alCapturar((d) => { cfg.tecla = d.nombre; $('#tecla').textContent = d.nombre; $('#cambiar-tecla').disabled = false; teclaAbajo = false; pintarPtt(); });

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
  $('#version').textContent = 'NCHRP Radio v' + cfg.version;
  $('#vol').value = cfg.volumen; $('#ontop').checked = !!cfg.siempreVisible;
  $('#tecla').textContent = cfg.tecla; $('#aviso-tecla').hidden = !!cfg.teclaGlobal;
  ($('#placa').value ? $('#pass') : $('#placa')).focus();
})();
