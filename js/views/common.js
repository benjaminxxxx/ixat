import { esc, cap, centroid, mapsLink, textHas } from '../util.js';

export function zoneIndex(snap) {
  const m = new Map();
  for (const z of snap.zones || []) m.set(z.id, z);
  return m;
}

// "Hotel Sarita · Centro" si es un lugar dentro de una zona; si no, la zona o el texto del chat.
export function zoneLabel(zones, zoneId, place, spotId = -1) {
  const s = zones.get(spotId), z = zones.get(zoneId);
  if (s) return esc(s.name) + (z && z.id !== s.id ? ` <span class="muted">· ${esc(z.name)}</span>` : '');
  if (z) return esc(z.name);
  return place ? `<span class="muted">${esc(cap(place))}</span>` : '<span class="muted">sin lugar</span>';
}

export function placePoint(z) {
  if (!z) return null;
  if (z.lat != null && z.lng != null) return [z.lat, z.lng];
  return centroid(z.polygon);
}

export function goLink(zones, zoneId, spotId = -1) {
  const url = mapsLink(placePoint(zones.get(spotId)) || placePoint(zones.get(zoneId)));
  return url ? `<a class="btn sm" href="${url}" target="_blank" rel="noopener">Ir ↗</a>` : '';
}

// "Doña Rosa · 964 565 272" si tiene apodo; si no, solo el número.
export function who(phone, names) {
  const n = names && names.get(phone);
  const p = String(phone).replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
  return n ? `<b>${esc(n)}</b> <span class="muted">${p}</span>` : p;
}

// Número escrito o pegado ("+51 964 565 272", "964565272") → "964565272", o null si no es un celular.
export function phoneFrom(text) {
  let d = String(text || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('51')) d = d.slice(2);
  return /^9\d{8}$/.test(d) ? d : null;
}

// Clientes que registraste tú (apodo o casa) y que todavía no aparecen en los chats subidos.
export function manualClients(snap, names, homes) {
  const known = new Set(snap.clients.map(c => c.phone));
  for (const p of snap.patterns) known.add(p.phone);
  return [...new Set([...names.keys(), ...homes.keys()])].filter(p => !known.has(p)).sort();
}

// Botón para ir a la casa del cliente (si está guardada).
export function homeLink(home, label = '🏠 Casa ↗') {
  return home ? `<a class="btn sm primary" href="${mapsLink([home.lat, home.lng])}" target="_blank" rel="noopener">${label}</a>` : '';
}

// Buscar zonas y lugares por nombre o por cómo los escriben en el chat. Los más pedidos primero.
export function searchPlaces(snap, q, limit = 8) {
  if (!q || !q.trim()) return [];
  return (snap.zones || []).filter(z => textHas(z.name, q) || (z.aliases || []).some(a => textHas(a, q)))
    .sort((a, b) => (textHas(b.name, q) - textHas(a.name, q)) || b.direct - a.direct || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function noData(view) {
  view.innerHTML = `<div class="card empty"><b>Todavía no hay análisis</b>Ve a <a href="#/datos">Datos</a>, sube los chats y toca <b>Procesar todo</b>.</div>`;
}

// Gráfico de barras de una sola serie, 24 horas. band = horas a resaltar (tu turno).
export function hourBars(values, { fmt = v => v.toFixed(1), unit = '', band = [], nowH = null, height = 150 } = {}) {
  const W = 360, H = height, padL = 28, padB = 18, padT = 8;
  const max = Math.max(...values, 0.0001);
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const bw = (W - padL) / 24;
  const y = v => padT + (H - padT - padB) * (1 - v / top);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">`;
  for (const h of band) s += `<rect class="band" x="${padL + h * bw}" y="${padT}" width="${bw}" height="${H - padT - padB}"/>`;
  for (let v = 0; v <= top + 1e-9; v += step) s += `<line class="grid" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${padL - 4}" y="${y(v) + 3}" text-anchor="end">${+v.toFixed(2)}</text>`;
  values.forEach((v, h) => {
    const x = padL + h * bw + 1, w = bw - 2, yy = y(v), hh = Math.max(0, y(0) - yy);
    if (hh > 0) {
      const r = Math.min(4, w / 2, hh);
      s += `<path class="bar" d="M${x},${y(0)} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + w - r} Q${x + w},${yy} ${x + w},${yy + r} V${y(0)} Z"/>`;
    }
    s += `<rect class="hit" x="${padL + h * bw}" y="${padT}" width="${bw}" height="${H - padT}" data-tip="<b>${h}:00–${h + 1}:00</b><br>${esc(fmt(v))} ${esc(unit)}"/>`;
    if (h % 3 === 0) s += `<text class="axis" x="${padL + h * bw + bw / 2}" y="${H - 4}" text-anchor="middle">${h}h</text>`;
  });
  if (nowH != null) s += `<line class="now" x1="${padL + nowH * bw}" x2="${padL + nowH * bw}" y1="${padT}" y2="${H - padB}"/>`;
  return s + '</svg>';
}

function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const n = x / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
