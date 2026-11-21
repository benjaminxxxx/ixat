// "Dónde esperar": cuánto se tarda en conseguir servicio esperando en cada zona,
// y si conviene quedarse o moverse (contando el viaje y el combustible).
import { $, esc, limaNow, getHere, toast } from '../util.js';
import { placePoint, goLink, zoneLabel } from './common.js';
import { makeLocator } from '../processor.js';

const KEY = 'taxi_here_zone';
const getSaved = () => { try { return +localStorage.getItem(KEY) || null; } catch { return null; } };
const setSaved = id => { try { localStorage.setItem(KEY, String(id)); } catch {} };

// Distancia en km por calle (línea recta × 1.3).
function km(a, b) {
  if (!a || !b) return null;
  const R = 6371, toR = x => x * Math.PI / 180;
  const dLat = toR(b[0] - a[0]), dLng = toR(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) * 1.3;
}

const bandIdx = (info, h) => info.bands.findIndex(([a, b]) => h >= a && h < b);
// Minutos promedio hasta conseguir servicio esperando en esa zona a esa hora.
export const waitMinutes = (spot, b) => 60 / spot.bands[b];
// Zonas y lugares más las alturas calculadas ("3ra por Loza Verde"), que no son lugares guardados.
export const withAlturas = (snap, zones) => new Map([...zones, ...(snap.alturas || []).map(a => [a.id, a])]);
// "Cuchara Brava · 3ra Calle": el punto y la zona donde queda. Una altura ya dice su calle.
const spotName = (zones, id) => (zones.get(id)?.altura ? esc(zones.get(id).name) : zoneLabel(zones, zones.get(id)?.parent ?? -1, '', id));

export function renderWaitCard(el, snap, savedZones) {
  if (!snap.waitSpots || !snap.waitSpots.length) { el.hidden = true; return; }
  const zones = withAlturas(snap, savedZones);
  const info = snap.waitInfo, fuel = snap.config.fuel || { solesPerKm: 0.283, kmh: 25 };
  const spots = snap.waitSpots.filter(s => placePoint(zones.get(s.zone)) && !s.hide);
  const byZone = new Map(snap.waitSpots.map(s => [s.zone, s]));
  // Zonas para elegir "estoy en": las que tienen dibujo o punto (las alturas no son lugares guardados).
  const choices = [...savedZones.values()].filter(z => placePoint(z)).sort((a, b) => a.name.localeCompare(b.name));
  let here = getSaved();
  let geoPoint = null; // si se usó el GPS, la distancia se mide desde ahí

  const draw = () => {
    const n = limaNow(), b = bandIdx(info, n.h);
    const [from, to] = info.bands[b];
    const herePt = geoPoint || placePoint(zones.get(here));
    const hereSpot = byZone.get(here);
    const hereMin = hereSpot ? waitMinutes(hereSpot, b) : 60 / info.global[b];
    // Opciones: minutos de espera + minutos de viaje.
    const opts = spots.map(s => {
      const d = herePt ? (s.zone === here ? 0 : km(herePt, placePoint(zones.get(s.zone)))) : null;
      const travel = d == null ? 0 : (d / fuel.kmh) * 60;
      return { s, d, travel, wait: waitMinutes(s, b), total: waitMinutes(s, b) + travel, cost: d == null ? null : d * fuel.solesPerKm };
    }).sort((a, b2) => (herePt ? a.total - b2.total : a.wait - b2.wait));
    // Primero los puntos con esperas reales: en días no vistos rindieron más que los solo simulados.
    const proven = opts.filter(o => !o.s.est);
    const ranked = proven.length >= 3 ? [...proven, ...opts.filter(o => o.s.est)] : opts;
    const best = ranked[0];
    let verdict = '';
    if (here && herePt && best) {
      const name = esc(zones.get(here)?.name || 'aquí');
      const hereZ = zones.get(here);
      if (hereZ?.no_wait || byZone.get(here)?.hide) {
        // Calle larga: no vale "quédate ahí", hay que decir a qué altura (mejor si es en la misma calle).
        const street = hereZ.no_wait ? hereZ : zones.get(hereZ.parent) || hereZ;
        const inside = opts.find(o => zones.get(o.s.zone).parent === street.id);
        const pick = inside && inside.total <= best.total + 3 ? inside : best;
        const move = pick.d < 0.05 ? 'Ya estás a esa altura' : `${pick.d.toFixed(1)} km · S/ ${pick.cost.toFixed(2)} de GLP`;
        const sameStreet = inside && inside !== pick ? ` Si prefieres seguir en esta calle: <b>${spotName(zones, inside.s.zone)}</b> (~${Math.round(inside.total)} min).` : '';
        verdict = `<div class="item soon"><div class="grow"><b>📍 Ponte en ${spotName(zones, pick.s.zone)}</b><div class="small sub">Decir solo “${esc(street.name)}” no indica a qué altura estás. ${move} · ~${Math.round(pick.total)} min hasta tu servicio.${sameStreet}</div></div>${goLink(zones, pick.s.zone)}</div>`;
      } else if (best.s.zone === here || best.total >= hereMin - 3) {
        verdict = `<div class="item soon"><div class="grow"><b>✅ Quédate en ${name}</b><div class="small sub">~${Math.round(hereMin)} min para tu próximo servicio${hereSpot ? '' : ' (promedio de Chala a esta hora)'}. Moverte no te ahorra tiempo.</div></div></div>`;
      } else {
        verdict = `<div class="item soon"><div class="grow"><b>➡️ Ve a ${spotName(zones, best.s.zone)}</b><div class="small sub">${best.d.toFixed(1)} km · S/ ${best.cost.toFixed(2)} de GLP · ~${Math.round(best.total)} min hasta tu servicio contando el viaje, frente a ~${Math.round(hereMin)} min si te quedas en ${name}.</div></div>${goLink(zones, best.s.zone)}</div>`;
      }
    }
    // La mejor altura de cada calle larga, aunque no entre entre los primeros de Chala.
    const streetBest = [...new Set((snap.alturas || []).map(a => a.parent))]
      .map(id => opts.find(o => zones.get(o.s.zone).altura && zones.get(o.s.zone).parent === id)).filter(Boolean);
    el.innerHTML = `
      <div class="card-head"><h2>Dónde esperar</h2><span class="sub">${from}:00–${to}:00</span></div>
      <div class="row" style="margin-bottom:8px">
        <select id="hereSel" class="grow" style="min-width:0"><option value="">¿Dónde estás?</option>${choices.map(z => `<option value="${z.id}" ${z.id === here ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select>
        <button class="btn sm" id="hereGps">📍 GPS</button>
      </div>
      ${verdict}
      <table style="margin-top:8px">
        <tr><th style="text-align:left">Zona</th><th>Espera</th>${herePt ? '<th>Viaje</th><th>GLP</th>' : ''}<th></th></tr>
        ${ranked.slice(0, 6).map(o => `<tr${o.s.zone === here ? ' class="me"' : ''}><td style="text-align:left">${spotName(zones, o.s.zone)}${o.s.est ? ' <span class="muted small">(simulado)</span>' : ''}</td><td>~${Math.round(o.wait)} min</td>${herePt ? `<td>${o.d < 0.05 ? 'aquí' : o.d.toFixed(1) + ' km'}</td><td>${o.d < 0.05 ? '—' : 'S/ ' + o.cost.toFixed(2)}</td>` : ''}<td>${goLink(zones, o.s.zone)}</td></tr>`).join('')}
      </table>
      ${streetBest.length ? `<h3 style="margin-top:10px">Mejor altura por calle</h3><div class="list" id="streetBest">${streetBest.map(o => `<div class="item"><div class="grow"><b>${spotName(zones, o.s.zone)}</b><div class="small sub">~${Math.round(o.wait)} min de espera${o.d != null ? ` · ${o.d < 0.05 ? 'aquí' : o.d.toFixed(1) + ' km'}` : ''}</div></div>${goLink(zones, o.s.zone)}</div>`).join('')}</div>` : ''}
      <p class="small muted">Espera: minutos promedio hasta conseguir servicio esperando ahí a esta hora, medido con ${snap.waitSpots.reduce((a, s) => a + s.n, 0).toLocaleString()} reportes “libre” del chat. Probado con días pasados: esperar en las 3 mejores dio 28% más servicios por hora que el resto (y que Llamosas).</p>`;

    $('#hereSel', el).onchange = e => { here = +e.target.value || null; geoPoint = null; setSaved(here || ''); draw(); };
    $('#hereGps', el).onclick = async e => {
      e.target.disabled = true;
      try {
        const r = await getHere({ goodAcc: 60, maxMs: 8000 });
        geoPoint = [r.lat, r.lng];
        // Zona donde estás (o la más cercana).
        const loc = makeLocator(snap.zones);
        let z = loc.container(r.lat, r.lng);
        if (z < 0) z = choices.map(c => [c.id, km(geoPoint, placePoint(c))]).sort((a, b2) => a[1] - b2[1])[0][0];
        here = z; setSaved(z);
        draw();
      } catch (err) { toast(err.message, 5000); e.target.disabled = false; }
    };
  };
  draw();
  return draw;
}

// Para las tablas de demanda: una calle marcada no se muestra como destino, sino su mejor altura a esa hora.
export function demandPlace(snap, zones, zoneId, h) {
  const z = zones.get(zoneId);
  if (!z?.no_wait) return { label: zoneLabel(zones, zoneId), link: goLink(zones, zoneId) };
  const b = bandIdx(snap.waitInfo, h);
  const ids = new Set((snap.alturas || []).filter(a => a.parent === zoneId).map(a => a.id));
  const best = (snap.waitSpots || []).filter(s => ids.has(s.zone)).sort((x, y) => y.bands[b] - x.bands[b])[0];
  if (!best) return { label: `${esc(z.name)} <span class="muted small">(falta indicar altura)</span>`, link: '' };
  const all = withAlturas(snap, zones);
  return { label: `${esc(all.get(best.zone).name)} <span class="muted small">· pedidos de toda la calle</span>`, link: goLink(all, best.zone) };
}

// Tabla para Análisis: minutos hasta conseguir servicio por zona y franja.
export function waitTable(snap, savedZones) {
  if (!snap.waitSpots?.length) return '<p class="sub">Aún no hay datos suficientes.</p>';
  const zones = withAlturas(snap, savedZones);
  const info = snap.waitInfo;
  const cell = (s, b) => `~${Math.round(60 / s.bands[b])}`;
  return `<div class="scroll-x"><table>
    <tr><th style="text-align:left">Zona</th>${info.bands.map(([a, b]) => `<th>${a}–${b}h</th>`).join('')}<th>Esperas</th></tr>
    ${snap.waitSpots.filter(s => !s.hide).sort((a, b) => !!a.est - !!b.est).slice(0, 30).map(s => `<tr><td style="text-align:left">${zones.get(s.zone) ? spotName(zones, s.zone) : '?'}${s.est ? ' <span class="muted small">(simulado)</span>' : ''}</td>${info.bands.map((_, b) => `<td>${cell(s, b)}</td>`).join('')}<td class="muted">${s.n}</td></tr>`).join('')}
    <tr><td style="text-align:left"><b>Promedio Chala</b></td>${info.global.map(r => `<td><b>~${Math.round(60 / r)}</b></td>`).join('')}<td></td></tr>
  </table></div>
  <p class="small muted">Minutos promedio hasta conseguir servicio esperando ahí (menos es mejor): los 30 mejores puntos. Mezcla las esperas reales del chat con el simulador; “(simulado)” = casi nadie espera ahí todavía, es una estimación.</p>`;
}
