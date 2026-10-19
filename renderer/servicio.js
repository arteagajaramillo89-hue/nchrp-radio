// Convierte la respuesta de /placas/estado en lo que se muestra junto al cuerpo (texto, estilo, ayuda).
// Devuelve null si no hay nada que mostrar.
(function () {
  'use strict';
  function describir(d) {
    if (!d || d.ok !== true) return null;
    switch (d.estado) {
      case 'servicio':
        return { texto: 'En servicio', clase: 'serv on', ayuda: d.callsign ? 'Callsign ' + String(d.callsign).slice(0, 20) : 'En ER:LC con tu equipo de emergencias' };
      case 'fuera':
        return { texto: 'Fuera de servicio', clase: 'serv off', ayuda: 'Estás en ER:LC pero no en un equipo de emergencias' };
      case 'desconectado':
        return { texto: 'Fuera de servicio', clase: 'serv off', ayuda: 'No estás conectado a ER:LC' };
      case 'sin_vinculo':
        return { texto: 'Roblox sin vincular', clase: 'serv off', ayuda: 'Tu cuenta de Roblox no está vinculada a tu DNI en el servidor' };
      default:
        return null; // 'desconocido' (ER:LC no responde): mejor no mostrar nada que mostrar algo falso
    }
  }
  window.NCHRP_SERVICIO = { describir, REFRESCO_MS: 15000 };
})();
