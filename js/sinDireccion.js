// Pedidos sin dirección ("llamar al cliente", "quiero un taxi"): no son un lugar.
// Casi siempre son encargos de comida o tragos, que se compran en la Primera entre Víctor Raúl y Llamosas,
// así que para calcular quién llega primero salen de ese tramo.

export const SIN_DIRECCION_ID = 999000001;

const clean = t => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const FILL = new Set(['al', 'el', 'la', 'a', 'sl', 'con', 'por', 'se', 'edito', 'este', 'mensaje', 'whatsapp', 'watsap', 'wsp', 'celular', 'normal', 'escribir', 'numero']);

function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// Acepta errores de escritura ("llsmar", "llamaf") sin confundirse con "llamosas".
const isCallWord = w => /^comunic/.test(w) || w === 'llamada'
  || (w[0] === 'l' && w.length >= 4 && w.length <= 7 && distance(w, 'llamar') <= 2 && distance(w, 'llamosas') > 2);
const isClientWord = w => w.length >= 5 && distance(w, 'cliente') <= 2;

// true solo si el texto no trae ningún lugar: "llamar cliente" sí, "aguadita llamar por whatsapp" no.
export function isNoAddress(text) {
  const words = clean(text).split(' ').filter(Boolean);
  return words.some(isCallWord) && words.every(w => isCallWord(w) || isClientWord(w) || FILL.has(w));
}

const pointOf = z => {
  if (!z) return null;
  if (z.lat != null && z.lng != null) return [z.lat, z.lng];
  if (!z.polygon?.length) return null;
  return [0, 1].map(k => z.polygon.reduce((a, p) => a + p[k], 0) / z.polygon.length);
};

// Origen de estos pedidos: el tramo entre los dos lugares (null si alguno todavía no tiene ubicación).
export function tramoOrigin(zones) {
  const a = pointOf(zones.find(z => clean(z.name) === 'victor raul'));
  const b = pointOf(zones.find(z => clean(z.name) === 'paradero llamosas'));
  if (!a || !b) return null;
  return { id: SIN_DIRECCION_ID, name: 'Sin dirección', kind: 'lugar', lat: (a[0] + b[0]) / 2, lng: (a[1] + b[1]) / 2, seg: [a, b] };
}

// Distancia por calle (km) de un punto al tramo.
export function kmToSegment(p, [a, b]) {
  const kx = 111.32 * Math.cos(a[0] * Math.PI / 180), ky = 111.32;
  const P = [(p[1] - a[1]) * kx, (p[0] - a[0]) * ky], B = [(b[1] - a[1]) * kx, (b[0] - a[0]) * ky];
  const t = Math.max(0, Math.min(1, (P[0] * B[0] + P[1] * B[1]) / (B[0] ** 2 + B[1] ** 2 || 1)));
  return Math.hypot(P[0] - t * B[0], P[1] - t * B[1]) * 1.3;
}
