// Utilidades compartidas por las pantallas.

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Hora de Perú (UTC-5, sin horario de verano), sin depender de la zona del dispositivo.
export function limaNow() {
  const d = new Date(Date.now() - 5 * 3600e3);
  return {
    date: d.toISOString().slice(0, 10),
    h: d.getUTCHours(),
    mod: d.getUTCHours() * 60 + d.getUTCMinutes(),
    sec: d.getUTCSeconds(),
    wd: d.getUTCDay(),
    t: Math.floor(d.getTime() / 60000),
  };
}

export const hhmm = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
export const hourLabel = h => { const x = h % 12 || 12; return x + (h < 12 ? 'am' : 'pm'); };
export const phoneFmt = p => String(p).replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
export const pct = x => x == null ? '—' : Math.round(x * 100) + '%';
export const num = (x, d = 1) => x == null || !isFinite(x) ? '—' : x.toLocaleString('es-PE', { maximumFractionDigits: d, minimumFractionDigits: d });
export const soles = x => 'S/ ' + num(x, 0);
export const cap = s => String(s || '').replace(/(^|\s)\S/g, c => c.toUpperCase());
export const WD = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
export const WD_LONG = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
export const shortDate = d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) : '—';
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// Minutos que faltan de "now" a "target" (minutos del día), considerando el día siguiente.
export function minutesUntil(target, now) {
  let d = target - now;
  if (d < -720) d += 1440;
  if (d > 720) d -= 1440;
  return d;
}

export function daysChips(days) {
  // Lunes primero.
  return '<span class="days">' + [1, 2, 3, 4, 5, 6, 0].map(w => `<i class="${days.includes(w) ? 'on' : ''}">${WD[w]}</i>`).join('') + '</span>';
}

export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

// Tooltip para gráficos: los elementos con data-tip lo muestran al pasar o tocar.
export function bindTips(root) {
  const tip = $('#tip');
  const show = (e, el) => {
    tip.innerHTML = el.dataset.tip;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const x = Math.min(window.innerWidth - r.width - 8, Math.max(8, e.clientX - r.width / 2));
    const y = Math.max(8, e.clientY - r.height - 14);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  };
  root.addEventListener('pointermove', e => { const el = e.target.closest('[data-tip]'); if (el) show(e, el); else tip.hidden = true; });
  root.addEventListener('pointerdown', e => { const el = e.target.closest('[data-tip]'); if (el) show(e, el); });
  root.addEventListener('pointerleave', () => (tip.hidden = true));
}

// Centro de un polígono [[lat,lng],...] (promedio de vértices: suficiente para zonas pequeñas).
export function centroid(poly) {
  if (!poly || !poly.length) return null;
  let la = 0, ln = 0;
  for (const [a, b] of poly) { la += a; ln += b; }
  return [la / poly.length, ln / poly.length];
}
// Acepta "-15.8474, -74.2570", enlaces de Google Maps (@lat,lng / !3dlat!4dlng / ?q=lat,lng).
export function parseCoords(text) {
  const s = String(text || '').replace(/%2C/gi, ',');
  let m = s.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/) || s.match(/(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  const lat = +m[1], lng = +m[2];
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [+lat.toFixed(7), +lng.toFixed(7)];
}

export const mapsLink = ll => ll ? `https://www.google.com/maps/dir/?api=1&destination=${ll[0].toFixed(6)},${ll[1].toFixed(6)}` : null;

// Ubicación del celular por GPS. Espera hasta ~15 s a que la precisión baje de 15 m
// y devuelve la mejor lectura { lat, lng, acc } (acc = margen de error en metros).
export function getHere({ goodAcc = 15, maxMs = 15000, onUpdate = () => {} } = {}) {
  return new Promise((ok, bad) => {
    if (!('geolocation' in navigator)) return bad(new Error('Este celular no permite ubicación'));
    if (!isSecureContext) return bad(new Error('La ubicación necesita https (funcionará en tu subdominio)'));
    let best = null;
    const finish = () => { navigator.geolocation.clearWatch(id); clearTimeout(timer); best ? ok(best) : bad(new Error('No se obtuvo la ubicación. ¿GPS activado?')); };
    const id = navigator.geolocation.watchPosition(p => {
      const r = { lat: +p.coords.latitude.toFixed(7), lng: +p.coords.longitude.toFixed(7), acc: Math.round(p.coords.accuracy) };
      if (!best || r.acc < best.acc) { best = r; onUpdate(r); }
      if (r.acc <= goodAcc) finish();
    }, err => {
      if (err.code === 1) { navigator.geolocation.clearWatch(id); clearTimeout(timer); bad(new Error('Permiso de ubicación denegado. Actívalo en los ajustes del navegador.')); }
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: maxMs });
    const timer = setTimeout(finish, maxMs);
  });
}

// "coca" encuentra "cocacola" y "coca cola".
const flatText = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
export const textHas = (t, q) => flatText(t).includes(flatText(q));
export const addDaysIso = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
// "los viernes", "los sábados".
export const wdPlural = wd => { const d = WD_LONG[wd].toLowerCase(); return d.endsWith('s') ? d : d + 's'; };
