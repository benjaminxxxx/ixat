import { loadSnapshot } from '../app.js';
import { api } from '../api.js';
import { textHas, $, esc, limaNow, hhmm, minutesUntil, phoneFmt, pct, num, shortDate, bindTips, toast, WD_LONG, addDaysIso, wdPlural } from '../util.js';
import { zoneIndex, zoneLabel, goLink, homeLink, noData, hourBars, searchPlaces, who, phoneFrom, manualClients } from './common.js';
import { pushStatus, enablePush, pushSupported } from '../push.js';
import { loadHomes, loadNames } from '../homes.js';
import { occurrences, slots, minToTime } from '../events.js';
import { renderWaitCard } from './wait.js';

const AHEAD_MIN = 120; // mostrar lo que viene en las próximas 2 horas
const BEHIND_MIN = 15; // y lo que debió pasar hace poco

export async function renderAhora(view) {
  const snap = await loadSnapshot();
  if (!snap) return noData(view);
  const zones = zoneIndex(snap);
  const [homes, names, events] = await Promise.all([loadHomes(), loadNames(), api('events.php').catch(() => snap.events || [])]);
  const lift = new Map((snap.eventStats || []).map(x => [x.id, x]));

  view.innerHTML = `
    <section class="card">
      <input type="search" id="placeQ" placeholder="🔎 Buscar lugar, apodo o número…" autocomplete="off">
      <div id="placeRes" class="list"></div>
    </section>
    <section class="card" id="waitCard"></section>
    <div id="live"></div>`;
  const drawWait = renderWaitCard($('#waitCard'), snap, zones);

  const placeRow = z => {
    const parent = z.kind === 'lugar' && z.parent >= 0 ? zones.get(z.parent) : null;
    return `<div class="item">
      <div class="grow"><b>${esc(z.name)}</b> <span class="small muted">${z.kind === 'lugar' ? '📍' : '▢'}${parent ? ' en ' + esc(parent.name) : ''}</span>
        <div class="small muted">${esc((z.aliases || []).slice(0, 4).join(', '))}${z.direct ? ` · ${z.direct} pedidos` : ''}</div></div>
      ${goLink(zones, z.id) || '<span class="small muted">sin punto</span>'}</div>`;
  };
  // Buscador: lugares y zonas registrados (con botón al mapa) y clientes por número o apodo.
  $('#placeQ').oninput = e => {
    const q = e.target.value.trim();
    const digits = q.replace(/\D/g, '');
    let html = '';
    const isNumber = digits.length >= 3 && digits.length === q.replace(/[\s+\-]/g, '').length;
    const matchPhone = ph => (isNumber && ph.includes(digits.length === 11 && digits.startsWith('51') ? digits.slice(2) : digits))
      || (q.length >= 2 && names.has(ph) && textHas(names.get(ph), q));
    // Clientes del chat y los que registraste tú (aunque aún no estén en el chat).
    const found = snap.clients.filter(c => matchPhone(c.phone)).slice(0, 6).map(c => `<div class="item">
        <div class="grow"><a href="#/cliente/${c.phone}">${who(c.phone, names)}</a>
          <div class="small sub">${c.calls} pedidos · ${zoneLabel(zones, c.zone, c.place, c.spot)}</div></div>
        ${homeLink(homes.get(c.phone))}${goLink(zones, c.zone, c.spot)}</div>`);
    for (const ph of manualClients(snap, names, homes).filter(matchPhone)) found.push(`<div class="item">
        <div class="grow"><a href="#/cliente/${ph}">${who(ph, names)}</a><div class="small sub">registrado por ti · aún no está en el chat</div></div>
        ${homeLink(homes.get(ph))}</div>`);
    const full = phoneFrom(q);
    if (full && !found.length) found.push(`<a class="item" href="#/cliente/${full}"><div class="grow"><b>➕ Registrar ${who(full, names)}</b>
        <div class="small sub">Cliente nuevo: ponle apodo y guarda su casa. Cuando subas el chat se junta solo con sus pedidos.</div></div></a>`);
    html = found.join('') + (isNumber ? '' : searchPlaces(snap, q).map(placeRow).join(''));
    $('#placeRes').innerHTML = q ? html || '<div class="empty">No está registrado. Agrégalo en <a href="#/zonas">Zonas</a>.</div>' : '';
  };

  const draw = async () => {
    const n = limaNow();
    // Hábitos que tocan hoy (o mañana temprano) dentro de la ventana. Solo los confiables:
    // los que llamaron en la mayoría de sus días recientes (probado: aciertan ~4 de cada 10).
    const P = snap.config.pattern;
    const upcoming = [];
    for (const p of snap.patterns) {
      if (p.status !== 'activo' || (p.prob ?? 1) < (P.minProb ?? 0) || (p.seen && p.seen[1] < 2)) continue;
      const d = minutesUntil(p.minute, n.mod);
      if (d < -BEHIND_MIN || d > AHEAD_MIN) continue;
      const wd = n.mod + d >= 1440 ? (n.wd + 1) % 7 : n.mod + d < 0 ? (n.wd + 6) % 7 : n.wd;
      if (!p.days.includes(wd)) continue;
      upcoming.push({ ...p, inMin: d });
    }
    upcoming.sort((a, b) => a.inMin - b.inMin || b.confidence - a.confidence);

    // Eventos de hoy (incluye los de anoche que siguen) y de los próximos 7 días.
    const yesterday = addDaysIso(n.date, -1), week = addDaysIso(n.date, 7);
    const evToday = [], evSoon = [];
    for (const ev of events) for (const date of occurrences(ev, yesterday, week)) {
      if (date === n.date) evToday.push({ ev, date });
      else if (date === yesterday && slots(ev, date).some(s => s.date === n.date && s.h >= n.h)) evToday.push({ ev, date });
      else if (date > n.date) evSoon.push({ ev, date });
    }
    evSoon.sort((a, b) => a.date.localeCompare(b.date) || a.ev.from_min - b.ev.from_min);

    const wdPark = snap.parkingWd?.[n.wd]?.[n.h];
    const park = wdPark || snap.parking[n.h] || [];
    // Demanda según el día de la semana (el sábado no es igual al martes).
    const dayVal = h => { const wd = h >= 24 ? (n.wd + 1) % 7 : n.wd; return snap.heatmap[wd][h % 24] ?? snap.hourly[h % 24].callsPerDay; };
    const push = await pushStatus().catch(() => 'no-soportado');
    const dayName = WD_LONG[n.wd].toLowerCase();

    $('#live').innerHTML = `
      ${push !== 'activo' ? pushBanner(push) : ''}
      ${evToday.length ? `<section class="card">
        <div class="card-head"><h2>🎉 Hoy</h2><a class="small" href="#/eventos">Eventos</a></div>
        <div class="list">${evToday.map(x => eventItem(x, zones, lift)).join('')}</div>
      </section>` : ''}
      <section class="card">
        <div class="card-head"><h2>Clientes habituales</h2><span class="sub">próx. 2 horas</span></div>
        ${upcoming.length ? `<div class="list">${upcoming.map(p => item(p, zones, homes.get(p.phone), names)).join('')}</div>`
          : `<div class="empty"><b>Ninguno confiable en las próximas 2 horas</b>Guíate por “Dónde esperar”.</div>`}
        <p class="small muted">Ayuda extra, no segura: estos avisos aciertan ~4 de cada 10 (fines de semana ~2).</p>
      </section>

      <section class="card">
        <div class="card-head"><h2>De dónde salen los pedidos</h2><span class="sub">${wdPark ? dayName + ' ' : ''}${n.h}:00–${n.h + 1}:00</span></div>
        ${park.length ? `<table>
          <tr><th style="text-align:left">Zona</th><th>Pedidos/día</th><th></th></tr>
          ${park.slice(0, 5).map(r => `<tr><td style="text-align:left">${zoneLabel(zones, r.zone)}</td><td>${num(r.callsPerDay, 1)}</td><td>${goLink(zones, r.zone)}</td></tr>`).join('')}
        </table>
        <p class="small muted">Cuántos piden recojo en esa zona ${wdPark ? `los ${wdPlural(n.wd)} ` : ''}a esta hora. Que salgan muchos pedidos no significa que convenga esperar ahí: puede haber muchos taxis (mira “Dónde esperar”).</p>`
          : `<p class="sub">Aún no hay zonas con datos a esta hora. Registra zonas en <a href="#/zonas">Zonas</a>.</p>`}
      </section>

      <section class="card">
        <div class="card-head"><h2>Demanda</h2><span class="sub">promedio de los ${wdPlural(n.wd)}</span></div>
        <div class="grid2">
          ${[0, 1, 2].map(i => `<div class="stat"><b>${num(dayVal(n.h + i), 1)}</b><span>${i === 0 ? 'Esta hora' : `${(n.h + i) % 24}:00`} · pedidos · ${num(snap.hourly[(n.h + i) % 24].perDriver, 1)} por taxista</span></div>`).join('')}
        </div>
        <div style="margin-top:10px" id="demChart">${hourBars(snap.heatmap[n.wd].map((v, h) => v ?? snap.hourly[h].callsPerDay), { unit: `pedidos (${dayName})`, nowH: n.h, fmt: v => v.toFixed(1) })}</div>
      </section>

      ${dataUntilCard(snap, n)}
      ${evSoon.length ? `<section class="card">
        <div class="card-head"><h2>Próximos eventos</h2><a class="small" href="#/eventos">Ver todos</a></div>
        <div class="list">${evSoon.slice(0, 4).map(x => eventItem(x, zones, lift)).join('')}</div>
      </section>` : ''}`;

    bindTips($('#demChart'));
    const b = $('#pushBtn');
    if (b) b.onclick = async () => {
      try { await enablePush(); toast('Avisos activados ✅'); draw(); } catch (e) { toast(e.message, 4000); }
    };
  };

  await draw();
  const timer = setInterval(() => { draw(); drawWait && drawWait(); }, 30000);
  return () => clearInterval(timer);
}

// Hasta cuándo hay datos de cada chat (lo de después todavía no se subió).
function dataUntilCard(snap, n) {
  const du = snap.dataUntil || {};
  const rows = Object.entries(du).sort();
  if (!rows.length) return '';
  const age = ts => Math.floor((Date.parse(n.date) - Date.parse(ts.slice(0, 10))) / 864e5);
  const old = rows.some(([, ts]) => age(ts) >= 4);
  return `<section class="card small sub">Datos hasta: ${rows.map(([c, ts]) => `<b>${c === 'dia' ? 'día' : esc(c)}</b> ${shortDate(ts.slice(0, 10))} ${ts.slice(11, 16)}`).join(' · ')}
    ${old ? '<br><span class="pill warn">Hace varios días que no subes chats</span> Las sugerencias siguen valiendo, pero se actualizan al subir los chats nuevos en <a href="#/datos">Datos</a>.' : ''}</section>`;
}

export function eventItem({ ev, date }, zones, lift) {
  const st = lift.get(ev.id);
  const l = st && st.lift != null ? `<span class="pill ${st.lift >= 1.1 ? 'good' : st.lift <= 0.9 ? 'bad' : ''}">${st.lift >= 1 ? '+' : ''}${Math.round((st.lift - 1) * 100)}% pedidos otras veces</span>` : '';
  return `<div class="item"><div class="time">${minToTime(ev.from_min)}<small>${shortDate(date)}</small></div>
    <div class="grow"><b>${esc(ev.name)}</b> ${l}
      <div class="small sub">${minToTime(ev.from_min)}–${minToTime(ev.to_min)}${ev.zone_id != null && zones.get(ev.zone_id) ? ' · ' + esc(zones.get(ev.zone_id).name) : ''}${ev.note && ev.note !== 'feriado' ? ' · ' + esc(ev.note) : ''}</div></div>
    ${ev.zone_id != null ? goLink(zones, ev.zone_id) : ''}</div>`;
}

function item(p, zones, home, names) {
  const soon = p.inMin >= -5 && p.inMin <= 15;
  const when = p.inMin < 0 ? `hace ${-p.inMin} min` : p.inMin === 0 ? 'ahora' : `en ${p.inMin} min`;
  const zoneBtn = goLink(zones, p.zone, p.spot);
  return `<div class="item ${soon ? 'soon' : ''} ${p.inMin < -5 ? 'past' : ''}">
    <div class="time">${hhmm(p.minute)}<small>${when}</small></div>
    <div class="grow">
      <div><b>${home ? '🏠 ' : ''}${zoneLabel(zones, p.zone, p.place, p.spot)}</b></div>
      <div class="small sub"><a href="#/cliente/${p.phone}">${who(p.phone, names)}</a> · ${p.seen ? `llamó ${p.seen[0]} de sus últimos ${p.seen[1]} días` : pct(p.confidence) + ' de sus días'} · últ. ${shortDate(p.last)}</div>
      <div class="small muted">Ventana ${hhmm(p.from)}–${hhmm(p.to)}</div>
    </div>
    <div style="display:grid;gap:4px">${homeLink(home)}${home ? zoneBtn.replace('Ir ↗', 'Zona ↗') : zoneBtn}</div>
  </div>`;
}

function pushBanner(status) {
  const msg = {
    'no-soportado': 'Este navegador no soporta avisos. En Android usa Chrome; en iPhone instala la app en la pantalla de inicio (iOS 16.4+).',
    'sin-https': 'Los avisos necesitan https. Funcionarán cuando la app esté en tu subdominio con SSL.',
    'bloqueado': 'Bloqueaste las notificaciones para este sitio. Actívalas en los ajustes del navegador.',
    'inactivo': 'Activa los avisos para que el celular te avise minutos antes aunque la app esté cerrada.',
  }[status];
  const can = status === 'inactivo' && pushSupported();
  return `<section class="card row"><div class="grow sub">${esc(msg)}</div>${can ? '<button class="btn primary" id="pushBtn">Activar avisos</button>' : ''}</section>`;
}
