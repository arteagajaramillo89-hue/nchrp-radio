// Cliente del servidor de New Chicago RP (corre en el proceso principal, sin navegador).
const API = process.env.NCHRP_API || 'https://api.newchicago.xyz';

async function post(ruta, cuerpo) {
  let r;
  try {
    r = await fetch(API + ruta, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(15000),
    });
  } catch (_) {
    return { ok: false, error: 'red', mensaje: 'No se pudo conectar con el servidor. Revisa tu internet.' };
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) {
    return { ok: false, error: d.error || 'http', mensaje: d.mensaje || 'No se pudo completar la acción. Inténtalo de nuevo.' };
  }
  return d;
}

module.exports = { post, API };
