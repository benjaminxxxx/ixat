// Nombres estándar para los lugares: "Tipo Nombre" (Hostal Sarita, Grifo Rossi…).
// El tipo se reconoce por la primera palabra del nombre o de cómo lo escriben en el chat.
// Si no se reconoce, se deja el nombre tal cual (solo se corrigen mayúsculas y tildes).
import { norm } from './processor.js';

// Palabras del chat → tipo. El orden decide si un lugar tiene varias (ej. "casino hotel" es Casino).
const TYPES = [
  ['Grifo', ['grifo']],
  ['Casino', ['casino', 'tragamonedas']],
  ['Hostal', ['hostal', 'hotel', 'hospedaje']],
  ['Grass', ['grass', 'gras']],
  ['Pollería', ['polleria']],
  ['Panadería', ['panaderia']],
  ['Chifa', ['chifa']],
  ['Restaurante', ['restaurante', 'restaurant']],
  ['Taller', ['taller']],
  ['Paradero', ['paradero']],
  ['Banco', ['banco']],
  ['Caja', ['caja']],
  ['Librería', ['libreria']],
  ['Notaría', ['notaria']],
  ['Galería', ['galeria']],
  ['Parque', ['parque']],
  ['Local', ['local']],
  ['Depósito', ['deposito']],
];

// Nombres que no salen de la regla.
const FIXED = {
  'banco la nacion': 'Banco de la Nación',
  'caja aqp': 'Caja Arequipa',
};

const ACCENTS = {
  vina: 'Viña', belen: 'Belén', nacion: 'Nación', faraon: 'Faraón', pacifico: 'Pacífico', victor: 'Víctor', raul: 'Raúl',
  america: 'América', quimica: 'Química', yanez: 'Yañez', colibri: 'Colibrí', chavin: 'Chavín', saul: 'Saúl',
  munequitas: 'Muñequitas', pio: 'Pío', martin: 'Martín', paraiso: 'Paraíso', jovito: 'Jovito', pikoton: 'Pikotón', jabon: 'Jabón', almacen: 'Almacén', sebastian: 'Sebastián', ferreteria: 'Ferretería',
};
const SMALL = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'en']);
const ARTICLES = new Set(['el', 'la', 'los', 'las']);

const startsWithType = n => {
  const first = n.split(' ')[0];
  for (const [label, words] of TYPES) if (words.includes(first)) return label;
  return null;
};
const stripType = n => n.split(' ').slice(1).join(' ');

// "la patrona" / "patrona" son el mismo lugar.
const baseKey = n => n.split(' ').filter((w, i) => !(i === 0 && ARTICLES.has(w))).join(' ');

// Mayúsculas y tildes: "2 de enero", "Viña".
function pretty(n, afterType = false) {
  const ws = n.split(' ').filter(Boolean);
  return ws.map((w, i) => {
    if (ACCENTS[w]) return ACCENTS[w];
    // 'de', 'del', 'y' en minúscula; 'la', 'el' solo después de 'de' (Parque de la Amistad, Rancho El Monte).
    if ((i > 0 || afterType) && SMALL.has(w) && (!ARTICLES.has(w) || ws[i - 1] === 'de')) return w;
    return w[0].toUpperCase() + w.slice(1);
  }).join(' ');
}

// Devuelve { type, base, name, key } para un lugar.
export function standardize(z) {
  const n = norm(z.name);
  if (FIXED[n]) return { type: null, base: n, name: FIXED[n], key: '|' + norm(FIXED[n]) };
  let type = startsWithType(n), base = type ? stripType(n) : n;
  if (!type) {
    // El tipo sale de cómo lo escriben ("hotel meflo"). Si el nombre es una sigla (Gtv), se usa el nombre completo del chat.
    const typed = (z.aliases || []).map(norm).filter(a => startsWithType(a) && stripType(a));
    for (const [label] of TYPES) {
      const own = typed.filter(a => startsWithType(a) === label);
      if (!own.length) continue;
      type = label;
      const rests = own.map(stripType);
      if (!rests.some(r => baseKey(r) === baseKey(n)) && n.length <= 4) base = rests.sort((a, b) => b.length - a.length)[0];
      break;
    }
  }
  if (!base) { type = null; base = n; }
  const name = (type ? type + ' ' : '') + pretty(base, !!type);
  return { type, base, name, key: (type || '') + '|' + baseKey(base) };
}

// Plan para ordenar todos los lugares: renombres y fusiones de duplicados.
// Cada grupo con la misma clave se queda en uno solo (el más antiguo), juntando sus textos del chat.
export function planNames(zones) {
  const groups = new Map();
  for (const z of zones) {
    if (z.kind !== 'lugar') continue;
    const s = standardize(z);
    if (!groups.has(s.key)) groups.set(s.key, []);
    groups.get(s.key).push({ z, s });
  }
  const plan = [];
  for (const members of groups.values()) {
    members.sort((a, b) => a.z.id - b.z.id);
    const keep = members[0].z;
    // El nombre más completo del grupo (ej. "El Faro" antes que "Faro").
    const name = members.map(m => m.s.name).sort((a, b) => b.length - a.length)[0];
    const seen = new Set();
    const aliases = [];
    for (const { z } of members) for (const a of [...(norm(z.name) === norm(name) ? [] : [z.name]), ...z.aliases]) {
      const k = norm(a);
      if (k && !seen.has(k)) { seen.add(k); aliases.push(k); }
    }
    const withPoint = members.find(m => m.z.lat != null)?.z;
    const lat = keep.lat ?? withPoint?.lat ?? null, lng = keep.lng ?? withPoint?.lng ?? null;
    const removed = members.slice(1).map(m => m.z);
    const changed = name !== keep.name || removed.length || aliases.join() !== keep.aliases.map(norm).join();
    if (changed) plan.push({ keep: { ...keep, name, aliases, lat, lng }, from: keep.name, removed });
  }
  return plan;
}

// Al cambiar el nombre, el anterior se guarda como texto del chat para que siga reconociéndose.
export function keepOldName(z, oldName) {
  const o = norm(oldName || '');
  if (!o || o === norm(z.name) || z.aliases.some(a => norm(a) === o)) return z;
  return { ...z, aliases: [...z.aliases, o] };
}
