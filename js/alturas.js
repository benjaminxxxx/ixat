// Alturas de una calle marcada "no sugerir": "3ra a la altura de Loza Verde".
// No son lugares guardados: se calculan con el dibujo de la calle, y cualquier lugar registrado sirve de referencia.
// El punto queda en el centro de la calle, a la misma altura que la referencia.
// Si varios lugares quedan casi juntos, da nombre a la altura el más mencionado en el chat.

const M = 111320;
const MIN_ELONG = 2.5;  // largo/ancho mínimo para tratar la zona como calle
const MAX_REF_M = 240;  // qué tan lejos de la calle puede estar la referencia (unas dos cuadras a lo ancho)
const MIN_GAP_M = 60;   // separación mínima entre alturas
const MAX_REF_LEN = 250; // una zona más larga que esto no sirve de referencia (otra calle, un barrio)

const centerOf = z => {
  if (z.lat != null && z.lng != null) return [z.lat, z.lng];
  if (!z.polygon?.length) return null;
  return [0, 1].map(k => z.polygon.reduce((a, p) => a + p[k], 0) / z.polygon.length);
};

// Ejes de la zona: a = a lo largo, b = a lo ancho (en metros).
function axes(poly) {
  const lat0 = poly.reduce((a, p) => a + p[0], 0) / poly.length, lng0 = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  const kx = M * Math.cos(lat0 * Math.PI / 180);
  const q = poly.map(([la, ln]) => [(ln - lng0) * kx, (la - lat0) * M]);
  let xx = 0, yy = 0, xy = 0;
  for (const [x, y] of q) { xx += x * x; yy += y * y; xy += x * y; }
  const th = 0.5 * Math.atan2(2 * xy, xx - yy), ux = Math.cos(th), uy = Math.sin(th);
  const to = ([la, ln]) => { const x = (ln - lng0) * kx, y = (la - lat0) * M; return [x * ux + y * uy, -x * uy + y * ux]; };
  const from = (a, b) => { const x = a * ux - b * uy, y = a * uy + b * ux; return [lat0 + y / M, lng0 + x / kx]; };
  const pts = poly.map(to), as = pts.map(p => p[0]), bs = pts.map(p => p[1]);
  return { to, from, pts, minA: Math.min(...as), maxA: Math.max(...as), len: Math.max(...as) - Math.min(...as), wid: Math.max(...bs) - Math.min(...bs) };
}

// Centro de la calle a la altura a.
function middleAt(pts, a) {
  const hits = [];
  for (let i = 0; i < pts.length; i++) {
    const [a1, b1] = pts[i], [a2, b2] = pts[(i + 1) % pts.length];
    if ((a1 <= a) !== (a2 <= a)) hits.push(b1 + (a - a1) / (a2 - a1) * (b2 - b1));
  }
  return hits.length ? (Math.min(...hits) + Math.max(...hits)) / 2 : null;
}

const isRef = (z, street) => {
  if (z.id === street.id || +z.no_wait) return false;
  if (z.kind === 'lugar' || !z.polygon?.length) return true;
  return axes(z.polygon).len <= MAX_REF_LEN;
};

// Alturas de una calle. weight(id) = cuánto se menciona ese lugar en el chat.
export function alturasFor(street, zones, weight, parentOf = new Map()) {
  if (street.kind === 'lugar' || !street.polygon || street.polygon.length < 3) return [];
  const ax = axes(street.polygon);
  if (ax.len < MIN_ELONG * ax.wid) return [];
  const base = street.name.replace(/\s+calle$/i, '');
  const chosen = [];
  const refs = zones.filter(z => isRef(z, street) && centerOf(z))
    .sort((x, y) => weight(y.id) - weight(x.id) || x.id - y.id);
  for (const z of refs) {
    const [a, b] = ax.to(centerOf(z));
    if (a < ax.minA || a > ax.maxA || chosen.some(c => Math.abs(c.a - a) < MIN_GAP_M)) continue;
    const mid = middleAt(ax.pts, a);
    if (mid == null || Math.abs(b - mid) > MAX_REF_M) continue;
    const [lat, lng] = ax.from(a, mid);
    chosen.push({ a, id: 1e9 + street.id * 1e5 + z.id, name: `${base} a la altura de ${z.name}`, kind: 'lugar', altura: 1, parent: street.id, ref: z.id, lat: +lat.toFixed(7), lng: +lng.toFixed(7), members: [] });
  }
  chosen.sort((x, y) => x.a - y.a);
  // Los negocios de la calle aportan sus esperas reales a la altura más cercana.
  if (chosen.length) for (const z of zones) {
    if (z.kind !== 'lugar' || parentOf.get(z.id) !== street.id || z.lat == null) continue;
    const [a] = ax.to([z.lat, z.lng]);
    chosen.reduce((m, c) => (Math.abs(c.a - a) < Math.abs(m.a - a) ? c : m)).members.push(z.id);
  }
  return chosen.map(({ a, ...c }) => c);
}

// Todas las alturas y lo que deja de sugerirse: lo marcado y los negocios ya representados por una altura.
export function buildAlturas(zones, weight, parentOf) {
  const alturas = zones.filter(z => +z.no_wait).flatMap(z => alturasFor(z, zones, weight, parentOf));
  const hidden = new Set(zones.filter(z => +z.no_wait).map(z => z.id));
  for (const a of alturas) for (const id of a.members) hidden.add(id);
  return { alturas, hidden };
}
