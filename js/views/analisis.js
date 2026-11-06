import { loadSnapshot } from '../app.js';
import { $, $$, esc, limaNow, hourLabel, pct, num, soles, cap, WD_LONG, bindTips, wdPlural } from '../util.js';
import { zoneIndex, zoneLabel, goLink, noData, hourBars, placePoint } from './common.js';
import { loadLibs } from './zonas.js';

const METRICS = {
  soles: { label: 'S/ por taxista', unit: 'soles por taxista por hora', get: x => x.solesPerDriver, fmt: v => 'S/ ' + v.toFixed(1) },
  pedidos: { label: 'Pedidos', unit: 'pedidos por día', get: x => x.callsPerDay, fmt: v => v.toFixed(1) },
  taxistas: { label: 'Taxistas', unit: 'taxistas con servicio', get: x => x.driversPerDay, fmt: v => v.toFixed(1) },
};

export async function renderAnalisis(view) {
  const snap = await loadSnapshot();
  if (!snap) return noData(view);
  const zones = zoneIndex(snap);
  const s = snap.summary;
  const my = snap.shifts.find(x => x.id === snap.config.myShift);
  const myBand = hoursOf(my);
  const best = [...snap.shifts].sort((a, b) => b.solesPerDriver - a.solesPerDriver)[0];
  let metric = 'soles';
  let parkHour = limaNow().h;
  let parkWd = limaNow().wd; // -1 = todos los días

  view.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>¿Qué turno gana más?</h2><span class="sub">${esc(s.dataStart)} → ${esc(s.dataEnd)}</span></div>
      <div class="scroll-x"><table>
        <tr><th>Turno</th><th>Serv/día</th><th>Taxis</th><th>S/ c/u</th></tr>
        ${snap.shifts.map(x => `<tr class="${x.id === best.id ? 'best' : ''}"><td>${esc(x.name)}${x.id === my.id ? ' <span class="pill">tú</span>' : ''}<div class="muted small">${x.start}–${x.end}h</div></td><td>${num(x.servicesDay, 0)}</td><td>${num(x.drivers, 0)}</td><td><b>${soles(x.solesPerDriver)}</b></td></tr>`).join('')}
      </table></div>
      <p class="small muted">S/ c/u: lo que gana en promedio cada taxista por día en ese turno. Solo cuenta servicios que pasan por el chat. Tarifa S/ ${snap.config.fare.day}, y S/ ${snap.config.fare.night} de ${snap.config.fare.nightFrom}:00 a ${snap.config.fare.nightTo}:00.</p>
    </section>

    <section class="card">
      <div class="card-head"><h2>Por hora</h2><div class="seg" id="metricSeg">${Object.entries(METRICS).map(([k, m]) => `<button data-k="${k}" class="${k === metric ? 'on' : ''}">${m.label}</button>`).join('')}</div></div>
      <div id="hourChart"></div>
      <div class="legend"><span><i style="background:var(--series)"></i><span id="metricName"></span></span><span><i style="background:var(--band)"></i>Tu turno (${esc(my.name)})</span></div>
    </section>

    <section class="card">
      <h2>Siesta y horas fuertes</h2>
      <div class="grid2">
        <div class="stat"><b>${snap.nap ? `${hourLabel(snap.nap.from)}–${hourLabel(snap.nap.to)}` : '—'}</b><span>Mejor hora para descansar en tu turno (${snap.nap ? soles(snap.nap.value) : ''}/h por taxista)</span></div>
        <div class="stat"><b>${peakText(snap.hourly, myBand)}</b><span>Horas con más pedidos en tu turno</span></div>
        <div class="stat"><b>${peakText(snap.hourly, [...Array(24).keys()], 'solesPerDriver')}</b><span>Horas que más pagan por taxista (todo el día)</span></div>
      </div>
    </section>

    <section class="card">
      <h2>Pedidos por día y hora</h2>
      ${heatmap(snap.heatmap)}
    </section>

    <section class="card">
      <div class="card-head"><h2>Dónde hay pedidos</h2><a class="btn sm" href="#/eventos">🎉 Eventos</a></div>
      <div class="row" style="margin-bottom:8px">
        <div class="seg" id="wdSeg">${[1, 2, 3, 4, 5, 6, 0].map(w => `<button data-w="${w}">${WD_LONG[w].slice(0, 3)}</button>`).join('')}<button data-w="-1">Todos</button></div>
        <select id="parkHour" style="width:auto">${[...Array(24).keys()].map(h => `<option value="${h}" ${h === parkHour ? 'selected' : ''}>${h}:00–${h + 1}:00</option>`).join('')}</select>
      </div>
      <div id="dmap" style="height:50vh;border-radius:12px"></div>
      <p class="small muted" id="mapNote" style="margin:6px 0 10px"></p>
      <div id="parkTable"></div>
    </section>

    <section class="card">
      <h2>Tus números</h2>
      <div class="grid2">
        <div class="stat"><b>${snap.me.services}</b><span>servicios en ${snap.me.days} días</span></div>
        <div class="stat"><b>${num(snap.me.perDay, 1)}</b><span>servicios por día trabajado</span></div>
        <div class="stat"><b>${soles(snap.me.days ? snap.me.soles / snap.me.days : 0)}</b><span>por día (estimado chat)</span></div>
        <div class="stat"><b>#${snap.me.rank || '—'}</b><span>en servicios del grupo</span></div>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Taxistas</h2><span class="sub">${snap.drivers.length}</span></div>
      <div class="scroll-x"><table>
        <tr><th>Nombre</th><th>Servicios</th><th>Por día</th><th>Éxito</th><th>Espera</th></tr>
        ${snap.drivers.map(d => `<tr class="${d.name === snap.config.me ? 'me' : ''}"><td>${esc(cap(d.name))}</td><td>${d.services}</td><td>${num(d.perDay, 1)}</td><td>${pct(d.successRate)}</td><td>${d.medianWait == null ? '—' : num(d.medianWait, 0) + "'"}</td></tr>`).join('')}
      </table></div>
      <p class="small muted">Éxito: de las veces que se reportó "libre", cuántas consiguió servicio. Espera: minutos típicos desde que dijo "libre" hasta que lo confirmaron. Solo para taxistas que se pudieron identificar en el chat (${s.mappedSenders}).</p>
    </section>

    <section class="card small sub">
      ${s.messages.toLocaleString()} mensajes · ${s.calls.toLocaleString()} pedidos · ${s.services.toLocaleString()} servicios confirmados · ${s.unconfirmed} sin confirmar · ${s.cancelled} cancelados · ${Math.round(100 * s.zonedCalls / s.calls)}% de pedidos con zona · lógica v${snap.version}
    </section>`;

  const drawHours = () => {
    const m = METRICS[metric];
    $('#hourChart').innerHTML = hourBars(snap.hourly.map(m.get), { unit: m.unit, fmt: m.fmt, band: myBand, nowH: limaNow().h, height: 170 });
    $('#metricName').textContent = m.unit;
    $$('#metricSeg button').forEach(b => b.classList.toggle('on', b.dataset.k === metric));
  };
  const drawPark = () => {
    $$('#wdSeg button').forEach(b => b.classList.toggle('on', +b.dataset.w === parkWd));
    const rows = (parkWd >= 0 && snap.parkingWd ? snap.parkingWd[parkWd][parkHour] : snap.parking[parkHour]) || [];
    drawMap();
    $('#parkTable').innerHTML = rows.length ? `<table>
      <tr><th>Zona</th><th>Pedidos/día</th><th>Éxito libres</th><th>Espera</th><th></th></tr>
      ${rows.map(r => `<tr><td>${zoneLabel(zones, r.zone)}</td><td>${num(r.callsPerDay, 1)}</td><td>${pct(r.successRate)}</td><td>${r.medianWait == null ? '—' : num(r.medianWait, 0) + ' min'}</td><td>${goLink(zones, r.zone)}</td></tr>`).join('')}
    </table>` : '<p class="sub">Sin datos de zonas a esta hora.</p>';
  };
  $('#metricSeg').onclick = e => { const k = e.target.dataset.k; if (k) { metric = k; drawHours(); } };
  $('#parkHour').onchange = e => { parkHour = +e.target.value; drawPark(); };
  $('#wdSeg').onclick = e => { if (e.target.dataset.w != null) { parkWd = +e.target.dataset.w; drawPark(); } };
  // Mapa de demanda: un círculo por lugar (o zona), más grande donde hay más pedidos a esa hora.
  const counts = new Map(); // id -> 168 valores (día*24 + hora)
  for (const [id, wd, h, n] of snap.spotHeat || []) {
    if (!counts.has(id)) counts.set(id, new Array(168).fill(0));
    counts.get(id)[wd * 24 + h] = n;
  }
  let map = null, layer = null;
  const css = getComputedStyle(document.documentElement);
  const color = css.getPropertyValue('--series').trim() || '#2a78d6';
  const ring = css.getPropertyValue('--surface').trim() || '#fff';
  function drawMap() {
    if (!map) return;
    layer.clearLayers();
    const cov = snap.heatCov || [];
    const covSum = cov.reduce((a, row) => a + (row[parkHour] || 0), 0);
    const pts = [];
    let unplaced = 0;
    for (const [id, arr] of counts) {
      const n = parkWd >= 0 ? arr[parkWd * 24 + parkHour] : [0, 1, 2, 3, 4, 5, 6].reduce((a, w) => a + arr[w * 24 + parkHour], 0);
      const c = parkWd >= 0 ? cov[parkWd]?.[parkHour] : covSum;
      if (!n || !c) continue;
      const z = zones.get(id), ll = placePoint(z);
      if (!ll) { unplaced += n / c; continue; }
      pts.push({ z, ll, v: n / c });
    }
    const max = Math.max(...pts.map(p => p.v), 0.01);
    for (const p of pts.sort((a, b) => b.v - a.v)) {
      L.circleMarker(p.ll, { radius: 5 + 17 * Math.sqrt(p.v / max), color: ring, weight: 2, fillColor: color, fillOpacity: 0.6 })
        .bindTooltip(`<b>${esc(p.z.name)}</b><br>${p.v.toFixed(2)} pedidos por día`, { direction: 'top' })
        .addTo(layer);
    }
    const day = parkWd >= 0 ? wdPlural(parkWd) : 'todos los días';
    $('#mapNote').textContent = `Pedidos promedio los ${day} de ${parkHour}:00 a ${parkHour + 1}:00. Círculo más grande = más pedidos.${unplaced >= 0.5 ? ` Otros ${unplaced.toFixed(1)} pedidos son de lugares sin punto en el mapa.` : ''}`;
  }

  drawHours();
  drawPark();
  bindTips(view);
  loadLibs().then(() => {
    if (!document.body.contains($('#dmap'))) return;
    map = L.map('dmap', { maxZoom: 19 }).setView([-15.8565, -74.247], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    layer = L.layerGroup().addTo(map);
    // Encuadrar solo los puntos de Chala (unos 6 km a la redonda).
    const all = [...counts.keys()].map(id => placePoint(zones.get(id))).filter(p => p && Math.hypot(p[0] + 15.8565, p[1] + 74.247) < 0.06);
    if (all.length) map.fitBounds(all, { maxZoom: 15, padding: [20, 20] });
    drawMap();
  }).catch(err => ($('#mapNote').textContent = err.message));
  return () => { if (map) map.off(), map.remove(); };
}

function hoursOf(sh) {
  const r = [];
  for (let h = sh.start; ; h = (h + 1) % 24) { r.push(h); if ((h + 1) % 24 === sh.end) break; }
  return r;
}

function peakText(hourly, hours, key = 'callsPerDay') {
  const top = [...hours].sort((a, b) => hourly[b][key] - hourly[a][key]).slice(0, 3).sort((a, b) => a - b);
  return top.map(h => hourLabel(h)).join(', ');
}

function heatmap(rows) {
  const flat = rows.flat().filter(v => v != null);
  const max = Math.max(...flat, 0.01);
  const lvl = v => v == null ? 0 : 1 + Math.min(6, Math.floor((v / max) * 7));
  const order = [1, 2, 3, 4, 5, 6, 0];
  let s = '<div class="heat"><div class="lbl"></div>';
  for (let h = 0; h < 24; h++) s += `<div class="hl">${h % 3 === 0 ? h : ''}</div>`;
  for (const wd of order) {
    s += `<div class="lbl">${WD_LONG[wd].slice(0, 3)}</div>`;
    for (let h = 0; h < 24; h++) {
      const v = rows[wd][h];
      s += `<div style="background:var(--seq-${lvl(v)})" data-tip="<b>${WD_LONG[wd]} ${h}:00</b><br>${v == null ? 'sin datos' : v.toFixed(1) + ' pedidos promedio'}"></div>`;
    }
  }
  s += '</div><div class="scale">Menos ' + [1, 2, 3, 4, 5, 6, 7].map(i => `<i style="background:var(--seq-${i})"></i>`).join('') + ' Más</div>';
  return s;
}
