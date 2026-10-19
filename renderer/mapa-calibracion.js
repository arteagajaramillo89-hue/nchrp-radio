// Calibración del mapa: convierte las coordenadas de ER:LC (LocationX, LocationZ) a píxeles de mapa.png.
//   pixelX = s * LocationX + ox      pixelY = s * LocationZ + oy      (Z crece hacia el sur = hacia abajo)
// Se obtuvo con 5 puntos reales sobre mapa.png (801 x 636). Si algún día se cambia mapa.png por una imagen más
// grande de ancho W, multiplica s, ox y oy por W/801 y pon el ancho/alto nuevos.
window.NCHRP_MAPA = { imagen: 'mapa.png', ancho: 801, alto: 636, s: 0.14749486, ox: 9.13231674, oy: -30.15950808 };
