// Procesador: mensajes crudos + zonas  →  análisis completo (snapshot).
// Es una función pura: con los mismos datos siempre da el mismo resultado.
// Si cambias la lógica, sube LOGIC_VERSION y vuelve a "Procesar todo".

import { occurrences, slots } from './events.js';

export const LOGIC_VERSION = 5;

export const CONFIG = {
  dispatchers: ['Transporte Los 5 De Oro', '+51 965 134 127'],
  // Un remitente con al menos estas confirmaciones también se considera operador.
  autoDispatcherMinConfirms: 40,
  me: { senders: ['Tú'], driver: 'benjamin' },
  fare: { day: 8, night: 10, nightFrom: 22, nightTo: 6 },
  shifts: [
    { id: 'manana', name: 'Mañana', start: 7, end: 19 },
    { id: 'noche', name: 'Noche', start: 19, end: 7 },
    { id: 'intermedio', name: 'Intermedio', start: 12, end: 0 },
  ],
  myShift: 'intermedio',
  confirmWindowMin: 15,     // una confirmación se asocia al pedido pendiente más antiguo de los últimos 15 min
  repeatCallMin: 30,        // mismo número dentro de 30 min = mismo pedido
  libreGapMin: 20,          // "libre" seguidos con menos de 20 min = misma espera
  pattern: {
    gapMin: 25,             // horas de llamada a menos de 25 min se agrupan en el mismo hábito
    minDays: 4,             // mínimo de días distintos para considerarlo hábito
    minConfidence: 0.35,    // % de días (de los que suele llamar) en que sí llamó
    leadMin: 10,            // avisar 10 min antes
    toleranceMin: 10,       // tolerancia de tardanza
    missesToDrop: 4,        // faltas seguidas para marcarlo "dejó de llamar"
    staleDays: 14,          // sin datos a esa hora en 14 días = "sin datos recientes"
    recentDays: 21,         // si no llamó en las últimas 3 semanas ya no se avisa (medido: 2-7% de acierto)
    probWeeks: 6,           // la probabilidad se mide con las últimas 6 semanas
    minProb: 0.6,           // probado: con 0.6 acierta ~40% (antes 20%); por debajo casi nunca
  },
  // Costo de moverse: GLP del Suzuki Alto (190 km con S/ 53.77) y velocidad promedio en Chala.
  fuel: { solesPerKm: 0.283, kmh: 25 },
};

// ---------- utilidades ----------
const STRIP_ACCENTS = /[̀-ͯ]/g;
export function norm(s) {
  return String(s).toLowerCase().normalize('NFD').replace(STRIP_ACCENTS, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function tsInfo(ts) {
  const y = +ts.slice(0, 4), mo = +ts.slice(5, 7), d = +ts.slice(8, 10);
  const h = +ts.slice(11, 13), mi = +ts.slice(14, 16), s = +ts.slice(17, 19);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  return { t: ms / 60000, date: ts.slice(0, 10), h, mod: h * 60 + mi, wd: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
}
export function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
function mode(arr) {
  const c = new Map();
  for (const x of arr) c.set(x, (c.get(x) || 0) + 1);
  let best = null, bn = 0;
  for (const [k, n] of [...c.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) if (n > bn) { best = k; bn = n; }
  return best;
}
function lev1(a, b) { // ¿distancia de edición <= 1?
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}
const hourInShift = (h, sh) => sh.start < sh.end ? h >= sh.start && h < sh.end : (h >= sh.start || h < sh.end);
const shiftHours = sh => { const r = []; for (let h = sh.start; ; h = (h + 1) % 24) { r.push(h); if ((h + 1) % 24 === sh.end) break; } return r; };
export const fareAt = h => (h >= CONFIG.fare.nightFrom || h < CONFIG.fare.nightTo ? CONFIG.fare.night : CONFIG.fare.day);

// ---------- zonas ----------
const EMPTY_PLACE_WORDS = new Set(['llamar', 'llmar', 'lamar', 'llamr', 'llamen', 'llama', 'cliente', 'clienta', 'al', 'a', 'por', 'favor', 'urgente', 'contacto', 'begin', 'vcard']);
// Texto del chat → zona o lugar. Gana la palabra clave más larga ("alto paraiso" antes que "paraiso"),
// y con el mismo largo, un lugar antes que una zona (es más preciso).
function makeZoneMatcher(zones) {
  const list = [];
  for (const z of zones) {
    for (const a of [z.name, ...(z.aliases || [])]) {
      const n = norm(a);
      if (n) list.push({ id: z.id, lugar: z.kind === 'lugar' ? 1 : 0, a: n, flat: n.replace(/ /g, ''), words: n.split(' ') });
    }
  }
  list.sort((x, y) => y.a.length - x.a.length || y.lugar - x.lugar || x.id - y.id);
  const near = (t, w) => t === w || (w.length >= 5 && t.length >= 4 && lev1(t, w));
  const cache = new Map();
  return place => {
    if (!place) return -1;
    if (cache.has(place)) return cache.get(place);
    const padded = ' ' + place + ' ';
    const flat = place.replace(/ /g, '');
    const toks = place.split(' ');
    let found = -1;
    for (const e of list) if (padded.includes(' ' + e.a + ' ')) { found = e.id; break; }
    if (found < 0) for (const e of list) if (e.flat.length >= 6 && flat.includes(e.flat)) { found = e.id; break; }
    if (found < 0) {
      // Con errores de tipeo: cada palabra de la clave debe parecerse a palabras seguidas del texto.
      outer: for (const e of list) {
        if (!e.words.some(w => w.length >= 5)) continue;
        for (let i = 0; i + e.words.length <= toks.length; i++) {
          if (e.words.every((w, j) => near(toks[i + j], w))) { found = e.id; break outer; }
        }
      }
    }
    cache.set(place, found);
    return found;
  };
}

// ---------- geometría ----------
function pointInPoly(lat, lng, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function polyArea(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j][1] + poly[i][1]) * (poly[j][0] - poly[i][0]);
  return Math.abs(s / 2);
}
// Zona (la más pequeña) que contiene un punto, o -1.
function makeContainer(zones) {
  const areas = zones.filter(z => z.kind !== 'lugar' && z.polygon && z.polygon.length >= 3)
    .map(z => ({ id: z.id, poly: z.polygon, area: polyArea(z.polygon) }))
    .sort((a, b) => a.area - b.area || a.id - b.id);
  return (lat, lng) => { const a = areas.find(x => pointInPoly(lat, lng, x.poly)); return a ? a.id : -1; };
}

// Para cada texto: zone = zona donde cae (o el lugar mismo si no está dentro de ninguna), spot = lugar exacto.
export function makeLocator(zones) {
  const match = makeZoneMatcher(zones);
  const container = makeContainer(zones);
  const byId = new Map(zones.map(z => [z.id, z]));
  const parent = new Map();
  for (const z of zones) if (z.kind === 'lugar') parent.set(z.id, z.lat != null && z.lng != null ? container(z.lat, z.lng) : -1);
  const locate = text => {
    const id = match(text);
    if (id < 0) return { zone: -1, spot: -1 };
    if (byId.get(id).kind !== 'lugar') return { zone: id, spot: -1 };
    const p = parent.get(id);
    return { zone: p >= 0 ? p : id, spot: id };
  };
  return { locate, parent, container };
}

// ---------- extracción ----------
const PHONE = /(?:\+?\s?51[\s-]?)?(9\d{2}[\s-]?\d{3}[\s-]?\d{3})(?!\d)/;
const CONFIRM = /\bc\w?nf\w?rmad\w*\b/;
const TITLES = new Set(['sr', 'snr', 'sen', 'senor', 'sra', 'ar', 'don', 'al', 'a', 'el', 'srr', 'se']);
const LIBRE_HEAD = /^(libre|libres|lb|lbr|livre|lbre|libr|lib|libte|lobre|librr)\b/;
const LIBRE_ANY = /\b(libre|livre|lbre)\b/;
const LIBRE_DROP = new Set(['libre', 'libres', 'lb', 'lbr', 'livre', 'lbre', 'libr', 'lib', 'libte', 'lobre', 'librr', 'x', 'por', 'en', 'ya', 'estoy', 'sigo', 'aun', 'de', 'nuevo']);

function confirmName(n) {
  const m = n.match(CONFIRM);
  if (!m) return null;
  const toks = n.slice(m.index + m[0].length).split(' ').filter(Boolean);
  for (const t of toks) {
    if (TITLES.has(t) || t.length < 3 || /\d/.test(t)) continue;
    return t;
  }
  return null;
}

export function processAll(rawMessages, zones, cfg = CONFIG, extra = {}) {
  const events = extra.events || [];
  // rawMessages: [[id, chat, ts, sender, text], ...]
  const msgs = rawMessages.map(([id, chat, ts, sender, text]) => ({ id, chat, ts, sender, text, n: norm(text), ...tsInfo(ts) }))
    .sort((a, b) => a.chat.localeCompare(b.chat) || a.t - b.t || a.id - b.id);

  // Operadores: lista fija + quien confirma mucho.
  const confirmsBy = new Map();
  for (const m of msgs) if (CONFIRM.test(m.n)) confirmsBy.set(m.sender, (confirmsBy.get(m.sender) || 0) + 1);
  const dispatchers = new Set(cfg.dispatchers);
  for (const [s, c] of [...confirmsBy.entries()].sort()) if (c >= cfg.autoDispatcherMinConfirms) dispatchers.add(s);

  const { locate, parent: spotParent } = makeLocator(zones);
  const calls = [];
  const libres = [];
  const pendingByChat = new Map();

  for (const m of msgs) {
    if (dispatchers.has(m.sender)) {
      const pend = pendingByChat.get(m.chat) || [];
      pendingByChat.set(m.chat, pend);
      while (pend.length && m.t - pend[0].t > cfg.confirmWindowMin) pend.shift();
      const ph = m.text.match(PHONE);
      if (ph) {
        const phone = ph[1].replace(/\D/g, '');
        let place = /vcard/i.test(m.text) ? '' : norm(m.text.replace(ph[0], ' '));
        if (place.split(' ').every(w => !w || EMPTY_PLACE_WORDS.has(w))) place = '';
        const same = pend.find(p => p.phone === phone);
        if (same) { if (!same.place && place) { same.place = place; Object.assign(same, locate(place)); } continue; }
        const c = { chat: m.chat, ts: m.ts, t: m.t, date: m.date, h: m.h, mod: m.mod, wd: m.wd, phone, place, ...locate(place), driver: null, confirmT: null, cancelled: false };
        calls.push(c);
        pend.push(c);
        continue;
      }
      const name = confirmName(m.n);
      if (name && pend.length) {
        const c = pend.shift();
        c.driver = name;
        c.confirmT = m.t;
        continue;
      }
      if (/^cancel/.test(m.n)) {
        for (let i = calls.length - 1; i >= 0 && m.t - calls[i].t <= cfg.confirmWindowMin; i--) {
          if (calls[i].chat === m.chat) { calls[i].cancelled = true; break; }
        }
      }
      continue;
    }
    // Taxistas reportándose libres.
    if (LIBRE_HEAD.test(m.n) || (LIBRE_ANY.test(m.n) && m.n.split(' ').length <= 4)) {
      if (/ocupad/.test(m.n)) continue;
      const place = m.n.split(' ').filter(w => !LIBRE_DROP.has(w)).join(' ');
      libres.push({ chat: m.chat, sender: m.sender, t: m.t, date: m.date, h: m.h, wd: m.wd, place, zone: locate(place).zone });
    }
  }

  // Unir pedidos repetidos del mismo número (re-publicados) dentro de repeatCallMin.
  calls.sort((a, b) => a.t - b.t || a.chat.localeCompare(b.chat));
  const lastByPhone = new Map();
  const merged = [];
  for (const c of calls) {
    const prev = lastByPhone.get(c.phone);
    if (prev && c.t - prev.t <= cfg.repeatCallMin && !(prev.driver && c.driver)) {
      if (!prev.driver && c.driver) { prev.driver = c.driver; prev.confirmT = c.confirmT; }
      if (!prev.place && c.place) { prev.place = c.place; prev.zone = c.zone; prev.spot = c.spot; }
      prev.cancelled = prev.cancelled && c.cancelled;
      continue;
    }
    lastByPhone.set(c.phone, c);
    merged.push(c);
  }
  const allCalls = merged;
  const services = allCalls.filter(c => c.driver && !c.cancelled);

  // Cobertura: horas (fecha+hora) donde el chat tenía actividad. Sirve para promediar sin contar huecos sin datos.
  const covered = new Set();
  for (const m of msgs) covered.add(m.date + '|' + m.h);
  const coveredDays = Array(24).fill(0);
  for (const k of covered) coveredDays[+k.split('|')[1]]++;
  const dates = [...new Set(msgs.map(m => m.date))].sort();
  const dataStart = dates[0] || null, dataEnd = dates[dates.length - 1] || null;
  const isCovered = (date, h) => covered.has(date + '|' + h);

  // ---------- quién es quién (remitente ↔ nombre en "Confirmado sr X") ----------
  const libresBySender = new Map();
  for (const l of libres) { if (!libresBySender.has(l.sender)) libresBySender.set(l.sender, []); libresBySender.get(l.sender).push(l); }
  const libresByChat = new Map();
  for (const l of libres) { if (!libresByChat.has(l.chat)) libresByChat.set(l.chat, []); libresByChat.get(l.chat).push(l); }
  for (const arr of libresByChat.values()) arr.sort((a, b) => a.t - b.t);
  const lowerBound = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t < t) lo = mid + 1; else hi = mid; } return lo; };
  const score = new Map();
  for (const s of services) {
    // Reportó libre en los 10 min previos y dejó de reportarse después (se fue al servicio).
    const arr = libresByChat.get(s.chat) || [];
    const before = new Set(), after = new Set();
    for (let i = lowerBound(arr, s.confirmT - 10); i < arr.length && arr[i].t <= s.confirmT + 8; i++) {
      (arr[i].t <= s.confirmT ? before : after).add(arr[i].sender);
    }
    for (const sender of before) {
      if (after.has(sender)) continue;
      const k = sender + '\u0000' + s.driver;
      score.set(k, (score.get(k) || 0) + 1);
    }
  }
  const senderName = new Map();
  for (const s of cfg.me.senders) senderName.set(s, cfg.me.driver);
  const bySender = new Map();
  for (const [k, n] of score) { const [s, d] = k.split('\u0000'); if (!bySender.has(s)) bySender.set(s, []); bySender.get(s).push([d, n]); }
  for (const [s, arr] of [...bySender.entries()].sort()) {
    if (senderName.has(s)) continue;
    arr.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const [d1, n1] = arr[0], n2 = arr[1] ? arr[1][1] : 0;
    if (n1 >= 3 && n1 >= 2 * n2) senderName.set(s, d1);
  }

  // ---------- esperas "libre" → éxito / tiempo de espera ----------
  const servicesByDriver = new Map();
  for (const s of services) { if (!servicesByDriver.has(s.driver)) servicesByDriver.set(s.driver, []); servicesByDriver.get(s.driver).push(s); }
  const episodes = [];
  for (const [sender, list] of [...libresBySender.entries()].sort()) {
    const name = senderName.get(sender) || null;
    const svc = name ? servicesByDriver.get(name) || [] : [];
    let ep = null;
    const close = () => {
      if (!ep) return;
      const won = svc.find(s => s.chat === ep.chat && s.confirmT >= ep.t0 && s.confirmT <= ep.tLast + 10);
      ep.won = !!won;
      ep.wait = won ? won.confirmT - ep.t0 : null;
      episodes.push(ep);
      ep = null;
    };
    for (const l of list) {
      if (ep && (l.chat !== ep.chat || l.t - ep.tLast > cfg.libreGapMin || svc.some(s => s.chat === ep.chat && s.confirmT > ep.t0 && s.confirmT < l.t))) close();
      if (!ep) ep = { sender, driver: name, chat: l.chat, t0: l.t, tLast: l.t, h: l.h, zones: [], places: [] };
      ep.tLast = l.t;
      if (l.zone >= 0) ep.zones.push(l.zone);
      if (l.place) ep.places.push(l.place);
    }
    close();
  }
  for (const e of episodes) { e.zone = e.zones.length ? mode(e.zones) : -1; e.place = e.places.length ? mode(e.places) : ''; delete e.zones; delete e.places; }

  // ---------- estadísticas por hora ----------
  const hourly = Array.from({ length: 24 }, (_, h) => ({ h, calls: 0, services: 0, driverSlots: 0, cov: coveredDays[h] }));
  const slotDrivers = new Map();
  for (const c of allCalls) hourly[c.h].calls++;
  for (const s of services) {
    hourly[s.h].services++;
    const k = s.date + '|' + s.h;
    if (!slotDrivers.has(k)) slotDrivers.set(k, new Set());
    slotDrivers.get(k).add(s.driver);
  }
  for (const [k, set] of slotDrivers) hourly[+k.split('|')[1]].driverSlots += set.size;
  for (const x of hourly) {
    const cov = x.cov || 1;
    x.callsPerDay = x.calls / cov;
    x.servicesPerDay = x.services / cov;
    x.driversPerDay = x.driverSlots / cov;
    x.perDriver = x.driversPerDay ? x.servicesPerDay / x.driversPerDay : 0;
    x.fare = fareAt(x.h);
    x.solesPerDriver = x.perDriver * x.fare;
    delete x.driverSlots;
  }

  // Calor día de la semana × hora (pedidos promedio).
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  const heatCov = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const c of allCalls) heat[c.wd][c.h]++;
  for (const k of covered) { const [d, h] = k.split('|'); heatCov[tsInfo(d + ' 00:00:00').wd][+h]++; }
  const heatmap = heat.map((row, wd) => row.map((n, h) => heatCov[wd][h] ? +(n / heatCov[wd][h]).toFixed(2) : null));
  const callsBySlot = new Map();
  for (const c of allCalls) { const k = c.date + '|' + c.h; callsBySlot.set(k, (callsBySlot.get(k) || 0) + 1); }

  // Mapa de demanda: pedidos por lugar exacto (o zona si no hay lugar) × día de la semana × hora.
  // Filas [id, día, hora, pedidos]; el promedio se saca dividiendo entre heatCov[día][hora].
  const spotCount = new Map();
  for (const c of allCalls) {
    const id = c.spot >= 0 ? c.spot : c.zone;
    if (id < 0) continue;
    const k = id + '|' + c.wd + '|' + c.h;
    spotCount.set(k, (spotCount.get(k) || 0) + 1);
  }
  const spotHeat = [...spotCount.entries()].map(([k, n]) => [...k.split('|').map(Number), n]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

  // ---------- turnos ----------
  // Las horas de madrugada de un turno que cruza la medianoche cuentan para el día en que empezó.
  const shiftDate = (date, h, sh) => (sh.start > sh.end && h < sh.end ? addDays(date, -1) : date);
  const shifts = cfg.shifts.map(sh => {
    const hours = shiftHours(sh);
    let callsDay = 0, servicesDay = 0, solesDay = 0;
    for (const h of hours) { callsDay += hourly[h].callsPerDay; servicesDay += hourly[h].servicesPerDay; solesDay += hourly[h].servicesPerDay * fareAt(h); }
    const perShiftDay = new Map();
    for (const s of services) if (hourInShift(s.h, sh)) {
      const k = shiftDate(s.date, s.h, sh);
      if (!perShiftDay.has(k)) perShiftDay.set(k, new Set());
      perShiftDay.get(k).add(s.driver);
    }
    // Solo días donde el turno tenía datos en al menos la mitad de sus horas.
    let drvSum = 0, nDays = 0;
    for (const [d, set] of perShiftDay) {
      let cov = 0;
      for (const h of hours) if (isCovered(sh.start > sh.end && h < sh.end ? addDays(d, 1) : d, h)) cov++;
      if (cov >= hours.length / 2) { drvSum += set.size; nDays++; }
    }
    const drivers = nDays ? drvSum / nDays : 0;
    return { id: sh.id, name: sh.name, start: sh.start, end: sh.end, callsDay, servicesDay, solesDay, drivers, solesPerDriver: drivers ? solesDay / drivers : 0, servicesPerDriver: drivers ? servicesDay / drivers : 0 };
  });

  // Siesta: las 2 horas seguidas con menos ganancia por taxista dentro de mi turno.
  const mySh = cfg.shifts.find(s => s.id === cfg.myShift);
  const myHours = shiftHours(mySh);
  let nap = null;
  for (let i = 0; i + 1 < myHours.length; i++) {
    const v = hourly[myHours[i]].solesPerDriver + hourly[myHours[i + 1]].solesPerDriver;
    if (!nap || v < nap.value) nap = { from: myHours[i], to: (myHours[i + 1] + 1) % 24, value: v / 2 };
  }

  // ---------- taxistas ----------
  const nameToSenders = new Map();
  for (const [s, d] of senderName) { if (!nameToSenders.has(d)) nameToSenders.set(d, []); nameToSenders.get(d).push(s); }
  const drivers = [...servicesByDriver.entries()].map(([name, list]) => {
    const eps = episodes.filter(e => e.driver === name);
    const won = eps.filter(e => e.won);
    const days = new Set(list.map(s => s.date)).size;
    return {
      name, services: list.length, days, perDay: days ? list.length / days : 0,
      soles: list.reduce((a, s) => a + fareAt(s.h), 0),
      waits: eps.length, wins: won.length, successRate: eps.length ? won.length / eps.length : null,
      medianWait: won.length ? Math.round(median(won.map(e => e.wait)) * 10) / 10 : null,
      senders: nameToSenders.get(name) || [],
      topZone: mode(list.filter(s => s.zone >= 0).map(s => s.zone)) ?? -1,
    };
  }).filter(d => d.services >= 10).sort((a, b) => b.services - a.services || a.name.localeCompare(b.name));

  // ---------- zonas × hora (pedidos y esperas) ----------
  const zoneHour = new Map(); // zone -> {calls[24], waits[24], wins[24], waitMins[24][]}
  const zh = z => { if (!zoneHour.has(z)) zoneHour.set(z, { calls: Array(24).fill(0), waits: Array(24).fill(0), wins: Array(24).fill(0), waitMins: Array.from({ length: 24 }, () => []) }); return zoneHour.get(z); };
  for (const c of allCalls) if (c.zone >= 0) zh(c.zone).calls[c.h]++;
  for (const e of episodes) if (e.zone >= 0) { const o = zh(e.zone); o.waits[e.h]++; if (e.won) { o.wins[e.h]++; o.waitMins[e.h].push(e.wait); } }
  const parking = Array.from({ length: 24 }, (_, h) => {
    const cov = coveredDays[h] || 1;
    const rows = [...zoneHour.entries()].map(([zone, o]) => ({
      zone, callsPerDay: o.calls[h] / cov, waits: o.waits[h],
      successRate: o.waits[h] >= 5 ? o.wins[h] / o.waits[h] : null,
      medianWait: o.waitMins[h].length >= 3 ? Math.round(median(o.waitMins[h]) * 10) / 10 : null,
    })).filter(r => r.callsPerDay > 0 || r.waits > 0);
    rows.sort((a, b) => b.callsPerDay - a.callsPerDay || a.zone - b.zone);
    return rows.slice(0, 6);
  });
  // Lo mismo, pero según el día de la semana (el sábado en la noche no es igual que el martes).
  // Con pocos días de datos a esa hora se usa el promedio de todos los días.
  const zoneWd = new Map();
  for (const c of allCalls) if (c.zone >= 0) {
    if (!zoneWd.has(c.zone)) zoneWd.set(c.zone, Array.from({ length: 7 }, () => Array(24).fill(0)));
    zoneWd.get(c.zone)[c.wd][c.h]++;
  }
  const parkingWd = Array.from({ length: 7 }, (_, wd) => Array.from({ length: 24 }, (_, h) => {
    const cov = heatCov[wd][h];
    if (cov < 3) return parking[h];
    const rows = [...zoneWd.entries()].map(([zone, m]) => {
      const o = zoneHour.get(zone);
      return {
        zone, callsPerDay: +(m[wd][h] / cov).toFixed(2), waits: o.waits[h],
        successRate: o.waits[h] >= 5 ? o.wins[h] / o.waits[h] : null,
        medianWait: o.waitMins[h].length >= 3 ? Math.round(median(o.waitMins[h]) * 10) / 10 : null,
      };
    }).filter(r => r.callsPerDay > 0);
    rows.sort((a, b) => b.callsPerDay - a.callsPerDay || a.zone - b.zone);
    return rows.slice(0, 6);
  }));

  // ---------- dónde esperar ----------
  // Servicios por hora de espera en cada zona: de los reportes "libre en X" hasta la confirmación.
  // Mide cuánto se tarda de verdad en conseguir servicio esperando ahí (no solo cuántos pedidos salen).
  // Con pocos datos, el valor se acerca al promedio. Probado con días pasados: esperar en las 3 zonas
  // mejor puntuadas dio ~28% más servicios por hora que el resto (y que Llamosas).
  const BANDS = [[0, 7], [7, 12], [12, 16], [16, 20], [20, 24]];
  const bandOf = h => BANDS.findIndex(([a, b]) => h >= a && h < b);
  const epHours = e => (e.won ? Math.max(e.wait, 0.5) : e.tLast - e.t0 + 5) / 60;
  const gW = Array(5).fill(0), gT = Array(5).fill(0);
  const zw = new Map();
  for (const e of episodes) {
    if (!e.driver || e.zone < 0) continue;
    const b = bandOf(e.h), t = epHours(e), w = e.won ? 1 : 0;
    gW[b] += w; gT[b] += t;
    if (!zw.has(e.zone)) zw.set(e.zone, { n: 0, w: 0, t: 0, bw: Array(5).fill(0), bt: Array(5).fill(0), bn: Array(5).fill(0) });
    const o = zw.get(e.zone);
    o.n++; o.w += w; o.t += t; o.bw[b] += w; o.bt[b] += t; o.bn[b]++;
  }
  const gRate = gW.reduce((a, x) => a + x, 0) / (gT.reduce((a, x) => a + x, 0) || 1);
  const waitSpots = [...zw.entries()].filter(([, o]) => o.n >= 100).map(([zone, o]) => {
    // Solo zonas con 100+ esperas (con menos, sale ruido); se acerca al promedio con 10 horas de peso.
    const rate = (o.w + 10 * gRate) / (o.t + 10);
    return { zone, n: o.n, rate: +rate.toFixed(2), bands: BANDS.map((_, b) => +((o.bw[b] + 3 * rate) / (o.bt[b] + 3)).toFixed(2)), bandN: o.bn };
  }).sort((a, b) => b.rate - a.rate || a.zone - b.zone);
  const waitInfo = { bands: BANDS, global: BANDS.map((_, b) => +(gW[b] / (gT[b] || 1)).toFixed(2)), rate: +gRate.toFixed(2) };

  // Lugares que no caen en ninguna zona (para que los asignes).
  const unmatched = new Map();
  for (const c of allCalls) if (c.zone < 0 && c.place) unmatched.set(c.place, (unmatched.get(c.place) || 0) + 1);
  for (const l of libres) if (l.zone < 0 && l.place) unmatched.set(l.place, (unmatched.get(l.place) || 0) + 1);
  const unmatchedPlaces = [...unmatched.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 300);
  const zoneCounts = {}, directCounts = {};
  for (const c of allCalls) {
    if (c.zone >= 0) zoneCounts[c.zone] = (zoneCounts[c.zone] || 0) + 1;
    const d = c.spot >= 0 ? c.spot : c.zone;
    if (d >= 0) directCounts[d] = (directCounts[d] || 0) + 1;
  }

  // ---------- clientes y hábitos ----------
  const byPhone = new Map();
  for (const c of allCalls) { if (!byPhone.has(c.phone)) byPhone.set(c.phone, []); byPhone.get(c.phone).push(c); }
  const patterns = [];
  const clients = [];
  const P = cfg.pattern;
  const coveredNear = (date, mod) => { const h = Math.floor(mod / 60); return isCovered(date, h) || isCovered(date, (h + 23) % 24) || isCovered(date, (h + 1) % 24); };

  for (const [phone, list] of [...byPhone.entries()].sort()) {
    const svc = list.filter(c => c.driver && !c.cancelled);
    const days = new Set(list.map(c => c.date));
    const client = {
      phone, calls: list.length, services: svc.length, days: days.size,
      first: list[0].date, last: list[list.length - 1].date,
      zone: mode(list.filter(c => c.zone >= 0).map(c => c.zone)) ?? -1,
      spot: mode(list.filter(c => c.spot >= 0).map(c => c.spot)) ?? -1,
      place: mode(list.filter(c => c.place).map(c => c.place)) || '',
      mine: svc.filter(c => c.driver === cfg.me.driver).length,
      topDrivers: Object.entries(svc.reduce((o, c) => (o[c.driver] = (o[c.driver] || 0) + 1, o), {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3),
      patterns: [],
    };
    if (list.length >= 2) clients.push(client);
    if (days.size < P.minDays) continue;

    // Una llamada por día por franja: ordenar por minuto del día y cortar el círculo en el hueco más grande.
    const occ = list.map(c => ({ date: c.date, mod: c.mod, wd: c.wd, zone: c.zone, spot: c.spot, place: c.place })).sort((a, b) => a.mod - b.mod || a.date.localeCompare(b.date));
    let cut = 0, bigGap = -1;
    for (let i = 0; i < occ.length; i++) {
      const next = i + 1 < occ.length ? occ[i + 1].mod : occ[0].mod + 1440;
      if (next - occ[i].mod > bigGap) { bigGap = next - occ[i].mod; cut = i + 1; }
    }
    const ring = [...occ.slice(cut), ...occ.slice(0, cut).map(o => ({ ...o, mod: o.mod + 1440 }))];
    if (cut >= occ.length) ring.splice(0, ring.length, ...occ);
    const groups = [];
    for (const o of ring) {
      const g = groups[groups.length - 1];
      if (g && o.mod - g[g.length - 1].mod <= P.gapMin) g.push(o); else groups.push([o]);
    }

    for (const g of groups) {
      const perDate = new Map();
      for (const o of g) if (!perDate.has(o.date)) perDate.set(o.date, o);
      const hits = [...perDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      if (hits.length < P.minDays) continue;
      const mods = hits.map(o => o.mod).sort((a, b) => a - b);
      const med = Math.round(median(mods));
      const p10 = quantile(mods, 0.1), p90 = quantile(mods, 0.9);
      const modOfDay = ((med % 1440) + 1440) % 1440;
      const first = hits[0].date, last = hits[hits.length - 1].date;

      // Días en que podía haber llamado (había datos a esa hora) entre la primera y la última vez.
      const eligible = Array(7).fill(0), got = Array(7).fill(0);
      for (const o of hits) got[o.wd]++;
      for (let d = first; d <= last; d = addDays(d, 1)) if (coveredNear(d, modOfDay)) eligible[tsInfo(d + ' 00:00:00').wd]++;
      const wds = [];
      for (let w = 0; w < 7; w++) if (got[w] >= 2 && eligible[w] && got[w] / eligible[w] >= 0.4) wds.push(w);
      if (!wds.length) continue;
      const gotSel = wds.reduce((a, w) => a + got[w], 0), eligSel = wds.reduce((a, w) => a + Math.max(eligible[w], got[w]), 0);
      const confidence = gotSel / eligSel;
      if (confidence < P.minConfidence) continue;

      // ¿Sigue llamando? Contar días esperados (con datos) después de la última llamada.
      let misses = 0, lastChecked = last;
      for (let d = addDays(last, 1); dataEnd && d <= dataEnd; d = addDays(d, 1)) {
        if (!coveredNear(d, modOfDay) || !wds.includes(tsInfo(d + ' 00:00:00').wd)) continue;
        misses++;
        lastChecked = d;
      }
      const needMisses = Math.max(P.missesToDrop, Math.ceil(2 / confidence));
      let status = 'activo';
      if (misses >= needMisses) status = 'inactivo';
      // Sin datos del chat a esa hora en las últimas semanas: no se puede confirmar que siga llamando.
      else if (dataEnd && addDays(lastChecked, P.staleDays) < dataEnd) status = 'sin_datos';

      // Si no llamó en las últimas semanas, ya no es un hábito vigente aunque falten datos para confirmarlo.
      const since = dataEnd ? Math.round((Date.parse(dataEnd) - Date.parse(last)) / 864e5) : 0;
      if (status === 'activo' && since > P.recentDays) status = 'sin_datos';
      // Probabilidad real: de los días recientes (de los que suele llamar) con datos a esa hora, en cuántos llamó.
      const hitDates = new Set(hits.map(o => o.date));
      let elig = 0, got2 = 0;
      for (let d = addDays(dataEnd || last, -7 * P.probWeeks); dataEnd && d <= dataEnd; d = addDays(d, 1)) {
        if (!wds.includes(tsInfo(d + ' 00:00:00').wd) || !coveredNear(d, modOfDay)) continue;
        elig++;
        if (hitDates.has(d)) got2++;
      }
      const prob = +((got2 + 0.5) / (elig + 1.5)).toFixed(2);

      const zone = mode(hits.filter(o => o.zone >= 0).map(o => o.zone)) ?? -1;
      const spot = mode(hits.filter(o => o.spot >= 0).map(o => o.spot)) ?? -1;
      const place = mode(hits.filter(o => o.place).map(o => o.place)) || client.place;
      const pat = {
        key: phone + '@' + modOfDay, phone, minute: modOfDay,
        from: (((p10 - P.toleranceMin) % 1440) + 1440) % 1440, to: (((p90 + P.toleranceMin) % 1440) + 1440) % 1440,
        days: wds, hits: hits.length, confidence: +confidence.toFixed(3), prob, seen: [got2, elig], since, first, last, misses, status, zone, spot, place,
        recent: hits.slice(-8).map(o => o.date),
      };
      patterns.push(pat);
      client.patterns.push(pat.key);
    }
  }
  patterns.sort((a, b) => a.minute - b.minute || a.phone.localeCompare(b.phone));
  clients.sort((a, b) => b.calls - a.calls || a.phone.localeCompare(b.phone));

  // ---------- agenda de avisos (la usa el cron del servidor) ----------
  const zoneName = new Map(zones.map(z => [z.id, z.name]));
  const fmt = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const got2Of = p => `${p.seen[0]} de ${p.seen[1]} días`;
  const alerts = patterns.filter(p => p.status === 'activo' && p.prob >= P.minProb && p.seen[1] >= 2).map(p => {
    let minute = p.minute - P.leadMin, days = p.days;
    if (minute < 0) { minute += 1440; days = days.map(w => (w + 6) % 7); }
    const where = p.spot >= 0 ? zoneName.get(p.spot) + (p.zone !== p.spot ? ` (${zoneName.get(p.zone)})` : '') : p.zone >= 0 ? zoneName.get(p.zone) : (p.place || 'lugar sin zona');
    return {
      key: p.key, minute, days,
      title: `📍 ${where} · en ~${P.leadMin} min`,
      body: `${p.phone.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3')} suele llamar a las ${fmt(p.minute)} · llamó ${got2Of(p)} últimamente`,
      url: './#/cliente/' + p.phone,
      phone: p.phone,
    };
  });

  // ---------- eventos y feriados ----------
  // Cada vez que ocurrió: pedidos reales en sus horas vs. lo normal para ese día de la semana y hora.
  const eventStats = events.map(ev => {
    const past = [];
    for (const date of dataStart ? occurrences(ev, dataStart, dataEnd) : []) {
      let actual = 0, expected = 0, hours = 0;
      for (const sl of slots(ev, date)) {
        if (!isCovered(sl.date, sl.h)) continue;
        actual += callsBySlot.get(sl.date + '|' + sl.h) || 0;
        expected += heatmap[tsInfo(sl.date + ' 00:00:00').wd][sl.h] || 0;
        hours++;
      }
      if (hours) past.push({ date, actual, expected: +expected.toFixed(1), hours });
    }
    // Solo ocurrencias con datos en al menos la mitad de sus horas (si no, el chat estaba vacío esa noche).
    const full = past.filter(p => p.hours >= Math.max(3, slots(ev, p.date).length / 2));
    const a = full.reduce((x, p) => x + p.actual, 0), e = full.reduce((x, p) => x + p.expected, 0);
    return { id: ev.id, past, lift: e >= 3 ? +(a / e).toFixed(2) : null };
  });
  // Aviso 1 hora antes de cada evento en los próximos 400 días (desde el último dato).
  const liftOf = new Map(eventStats.map(x => [x.id, x.lift]));
  if (dataEnd) for (const ev of events) for (const date of occurrences(ev, dataEnd, addDays(dataEnd, 400))) {
    let minute = ev.from_min - 60, day = date;
    if (minute < 0) { minute += 1440; day = addDays(date, -1); }
    const lift = liftOf.get(ev.id);
    const where = ev.zone_id != null && zoneName.has(ev.zone_id) ? ' en ' + zoneName.get(ev.zone_id) : '';
    alerts.push({
      key: 'ev' + ev.id + '@' + date, date: day, minute, days: [0, 1, 2, 3, 4, 5, 6],
      title: `🎉 ${ev.name}${where} · desde ${fmt(ev.from_min)}`,
      body: lift != null && lift > 1.1 ? `Otras veces hubo ${Math.round((lift - 1) * 100)}% más pedidos de lo normal en esas horas` : (ev.note || 'Evento programado'),
      url: './#/eventos',
    });
  }

  // ---------- yo ----------
  const mine = services.filter(s => s.driver === cfg.me.driver);
  const myDays = new Set(mine.map(s => s.date)).size;
  const meStats = {
    services: mine.length, days: myDays, perDay: myDays ? mine.length / myDays : 0,
    soles: mine.reduce((a, s) => a + fareAt(s.h), 0),
    byHour: Array.from({ length: 24 }, (_, h) => mine.filter(s => s.h === h).length),
    rank: drivers.findIndex(d => d.name === cfg.me.driver) + 1,
  };

  // ---------- compacto para el celular ----------
  const phones = [...byPhone.keys()].sort();
  const phoneIdx = new Map(phones.map((p, i) => [p, i]));
  const places = [...new Set(allCalls.map(c => c.place))].sort();
  const placeIdx = new Map(places.map((p, i) => [p, i]));
  const driverNames = [...new Set(allCalls.filter(c => c.driver).map(c => c.driver))].sort();
  const driverIdx = new Map(driverNames.map((d, i) => [d, i]));
  const chats = [...new Set(allCalls.map(c => c.chat))].sort();
  const callRows = allCalls.map(c => [c.t, phoneIdx.get(c.phone), c.zone, placeIdx.get(c.place), c.driver ? driverIdx.get(c.driver) : -1, chats.indexOf(c.chat), c.cancelled ? 1 : 0, c.spot]);

  const chatSummary = {};
  for (const m of msgs) { const s = chatSummary[m.chat] ||= { messages: 0, first: m.date, last: m.date }; s.messages++; if (m.date > s.last) s.last = m.date; if (m.date < s.first) s.first = m.date; }

  // Para pruebas de acierto (backtest): datos internos sin compactar.
  if (extra.debug) extra.debug.out = { allCalls, episodes, libres, covered, senderName };

  return {
    version: LOGIC_VERSION,
    generatedAt: new Date().toISOString(),
    config: { fare: cfg.fare, shifts: cfg.shifts, myShift: cfg.myShift, pattern: cfg.pattern, me: cfg.me.driver, fuel: cfg.fuel },
    summary: {
      messages: msgs.length, calls: allCalls.length, services: services.length, cancelled: allCalls.filter(c => c.cancelled).length,
      unconfirmed: allCalls.filter(c => !c.driver).length, clients: byPhone.size, dataStart, dataEnd, chats: chatSummary,
      dispatchers: [...dispatchers].sort(), libreReports: libres.length, waits: episodes.length,
      mappedSenders: senderName.size, zonedCalls: allCalls.filter(c => c.zone >= 0).length,
    },
    zones: zones.map(z => ({ id: z.id, name: z.name, aliases: z.aliases || [], kind: z.kind || 'zona', color: z.color, polygon: z.polygon, lat: z.lat ?? null, lng: z.lng ?? null, parent: spotParent.get(z.id) ?? -1, calls: zoneCounts[z.id] || 0, direct: directCounts[z.id] || 0 })),
    hourly, heatmap, heatCov, shifts, nap, drivers, parking, parkingWd, spotHeat, waitSpots, waitInfo, unmatchedPlaces, patterns, alerts, me: meStats,
    events, eventStats,
    clients: clients.slice(0, 1500),
    dict: { phones, places, drivers: driverNames, chats },
    calls: callRows,
  };
}
