// Bandeja de Zonas: lo que falta resolver y con qué se parece (errores de escritura, nombres al revés…).
import { norm } from './processor.js';
import { cap } from './util.js';
import { isNoAddress } from './sinDireccion.js';

// Palabras que no distinguen un lugar de otro.
const GENERIC = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'en', 'por', 'y', 'a', 'al', 'calle', 'av', 'avenida', 'jr', 'hotel', 'hostal', 'hospedaje', 'restaurante', 'rest', 'local', 'tienda', 'taller', 'grifo', 'bar', 'discoteca', 'ferreteria', 'polleria', 'deposito', 'altura', 'esquina']);
// "Espalda Camanyu" no es el mismo punto que "Camanyu".
const SIDE = new Set(['espalda', 'espaldas', 'costado', 'frente']);
const MIN_SCORE = 0.74;

const located = z => (z.kind === 'lugar' ? z.lat != null && z.lng != null : !!(z.polygon && z.polygon.length >= 3));
const words = t => norm(t).split(' ').filter(w => w && !GENERIC.has(w) && !SIDE.has(w));
const digits = t => (norm(t).match(/\d+/g) || []).join(',');
const side = t => norm(t).split(' ').filter(w => SIDE.has(w)).map(w => w.replace(/s$/, '')).sort().join(',');

function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// 0 a 1: qué tanto parecen el mismo lugar. "5 de agosto" y "6 de agosto" nunca coinciden.
export function similarity(x, y) {
  if (digits(x) !== digits(y) || side(x) !== side(y)) return 0;
  const a = words(x), b = words(y);
  if (!a.length || !b.length) return 0;
  const fa = [...a].sort().join(''), fb = [...b].sort().join('');
  if (fa === fb) return 1;
  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  if (small.join('').length >= 4 && small.every(w => big.includes(w))) return 0.9;
  return 1 - distance(a.join(''), b.join('')) / Math.max(a.join('').length, b.join('').length);
}

// Todo lo pendiente, primero lo que más aparece en el chat.
export function pendingItems(zones, unmatched, counts, ignored) {
  const known = new Set(zones.flatMap(z => [norm(z.name), ...z.aliases.map(norm)]));
  const texts = unmatched.filter(([p]) => !known.has(p) && !ignored.has(p) && !isNoAddress(p))
    .map(([p, n]) => ({ key: 't:' + p, type: 'texto', text: p, name: cap(p), n }));
  const missing = zones.filter(z => !located(z) && !isNoAddress(z.name))
    .map(z => ({ key: 'z:' + z.id, type: z.kind === 'lugar' ? 'punto' : 'dibujo', id: z.id, name: z.name, n: counts.get(z.id)?.direct || 0 }));
  return [...texts, ...missing].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

// Hasta 3 candidatos. Los textos también pueden agruparse con otro texto pendiente.
export function suggestions(item, zones, items) {
  const source = item.text || item.name;
  const out = [];
  for (const z of zones) {
    if (z.id === item.id) continue;
    const s = Math.max(...[z.name, ...z.aliases].map(t => similarity(source, t)));
    if (s >= MIN_SCORE) out.push({ key: 'z:' + z.id, name: z.name, score: s + (located(z) ? 0.02 : 0) });
  }
  if (item.type === 'texto') for (const o of items) {
    if (o.type !== 'texto' || o.key === item.key) continue;
    const s = similarity(source, o.text);
    if (s >= MIN_SCORE) out.push({ key: o.key, name: o.name, score: s - 0.01 });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 3);
}
