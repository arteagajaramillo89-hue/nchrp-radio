// Calibración del mapa: convierte las coordenadas de ER:LC (LocationX, LocationZ) a píxeles de mapa.png.
//   pixelX = s * LocationX + ox      pixelY = s * LocationZ + oy      (Z crece hacia el sur = hacia abajo)
// Se obtuvo con 5 puntos reales sobre un mapa de 801 x 636. Estos valores son SIEMPRE de esa medida de referencia:
// mapa.png puede ser una imagen más grande (mismo encuadre, misma proporción) y el mapa se ajusta solo, sin tocar nada aquí.
window.NCHRP_MAPA = { imagen: 'mapa.png', ancho: 801, alto: 636, s: 0.14749486, ox: 9.13231674, oy: -30.15950808 };
