import { loadSnapshot } from '../app.js';
import { $, esc, hhmm, phoneFmt, pct, shortDate, daysChips, cap, WD_LONG, toast, getHere, parseCoords } from '../util.js';
import { zoneIndex, zoneLabel, goLink, homeLink, noData, who, phoneFrom, manualClients } from './common.js';
import { loadHomes, saveHome, deleteHome, loadNames, saveName } from '../homes.js';
import { textHas } from '../util.js';

const STATUS = {
  activo: '<span class="pill good">● activo</span>',
  inactivo: '<span class="pill bad">✕ dejó de llamar</span>',
  sin_datos: '<span class="pill warn">? sin datos recientes</span>',
};

let filter = 'activo';
let query = '';

export async function renderClientes(view) {
  const snap = await loadSnapshot();
  if (!snap) return noData(view);
  const zones = zoneIndex(snap);
  const [homes, names] = await Promise.all([loadHomes(), loadNames()]);
  const counts = { activo: 0, inactivo: 0, sin_datos: 0 };
  for (const p of snap.patterns) counts[p.status]++;
  const manual = manualClients(snap, names, homes);

  view.innerHTML = `
    <section class="card">
      <input type="search" id="q" placeholder="Buscar número o apodo…" value="${esc(query)}">
      <div class="seg" id="fSeg" style="margin-top:10px">
        <button data-f="activo">Hábitos activos (${counts.activo})</button>
        <button data-f="inactivo">Dejaron de llamar (${counts.inactivo})</button>
        <button data-f="sin_datos">Sin datos recientes (${counts.sin_datos})</button>
        <button data-f="frecuentes">Más frecuentes</button>
        <button data-f="nuevos">Registrados por ti (${manual.length})</button>
      </div>
    </section>
    <section class="card"><div id="list" class="list"></div></section>`;

  const draw = () => {
    document.querySelectorAll('#fSeg button').forEach(b => b.classList.toggle('on', b.dataset.f === filter));
    const q = query.replace(/\D/g, '');
    const nq = query.trim().length >= 2 && !q ? query.trim() : '';
    const named = ph => nq && names.has(ph) && textHas(names.get(ph), nq);
    let html = '';
    const manualRow = ph => `<a class="item" href="#/cliente/${ph}"><div class="grow">${who(ph, names)} ${homes.has(ph) ? '🏠' : ''}
        <div class="small sub">registrado por ti · aún no está en el chat</div></div></a>`;
    if (filter === 'nuevos' && !q && !nq) {
      html = manual.map(manualRow).join('') || '<div class="empty"><b>Ninguno todavía</b>Busca un número nuevo arriba y regístralo con su apodo o casa.</div>';
    } else if (filter === 'frecuentes' || filter === 'nuevos' || q || nq) {
      const list = snap.clients.filter(c => (!q && !nq) || (q && c.phone.includes(q)) || named(c.phone)).slice(0, 150);
      html = list.map(c => `<a class="item" href="#/cliente/${c.phone}">
        <div class="grow">${names.has(c.phone) ? who(c.phone, names) : `<b>${phoneFmt(c.phone)}</b>`} ${homes.has(c.phone) ? '🏠 ' : ''}${c.patterns.length ? '<span class="pill">hábito</span>' : ''}
          <div class="small sub">${c.calls} pedidos · ${c.days} días · ${zoneLabel(zones, c.zone, c.place, c.spot)} · últ. ${shortDate(c.last)}${c.mine ? ` · tú: ${c.mine}` : ''}</div></div></a>`).join('');
      if (q || nq) html += manual.filter(ph => (q && ph.includes(q)) || named(ph)).map(manualRow).join('');
      const full = phoneFrom(query);
      if (full && !html) html = `<a class="item" href="#/cliente/${full}"><div class="grow"><b>➕ Registrar ${phoneFmt(full)}</b>
        <div class="small sub">Cliente nuevo: ponle apodo y guarda su casa. Cuando subas el chat se junta solo con sus pedidos.</div></div></a>`;
    } else {
      const list = snap.patterns.filter(p => p.status === filter);
      html = list.map(p => `<a class="item" href="#/cliente/${p.phone}">
        <div class="time">${hhmm(p.minute)}</div>
        <div class="grow"><b>${zoneLabel(zones, p.zone, p.place, p.spot)}</b>
          <div class="small sub">${homes.has(p.phone) ? '🏠 ' : ''}${who(p.phone, names)} · ${pct(p.confidence)} · ${p.hits} veces${p.status !== 'activo' ? ` · desde ${shortDate(p.last)}` : ''}</div>
          ${daysChips(p.days)}</div></a>`).join('');
    }
    $('#list').innerHTML = html || '<div class="empty">Sin resultados</div>';
  };
  $('#q').oninput = e => { query = e.target.value; draw(); };
  $('#fSeg').onclick = e => { if (e.target.dataset.f) { filter = e.target.dataset.f; draw(); } };
  draw();
}

export async function renderCliente(view, phone) {
  const snap = await loadSnapshot();
  if (!snap) return noData(view);
  phone = phoneFrom(phone) || phone;
  const zones = zoneIndex(snap);
  const [homes, names] = await Promise.all([loadHomes(), loadNames()]);
  const home = homes.get(phone);
  const nick = names.get(phone) || '';
  const c = snap.clients.find(x => x.phone === phone);
  const pats = snap.patterns.filter(p => p.phone === phone);
  const pi = snap.dict.phones.indexOf(phone);
  const calls = snap.calls.filter(r => r[1] === pi).reverse();

  const row = r => {
    const d = new Date(r[0] * 60000);
    const date = d.toISOString().slice(0, 10), mod = d.getUTCHours() * 60 + d.getUTCMinutes();
    const driver = r[4] >= 0 ? cap(snap.dict.drivers[r[4]]) : '<span class="muted">sin confirmar</span>';
    return `<tr><td>${WD_LONG[d.getUTCDay()].slice(0, 3)} ${shortDate(date)}</td><td>${hhmm(mod)}</td><td style="text-align:left">${zoneLabel(zones, r[2], snap.dict.places[r[3]], r[7] ?? -1)}</td><td>${r[6] ? '<span class="pill bad">cancelado</span>' : driver}</td></tr>`;
  };

  view.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>${nick ? esc(nick) : phoneFmt(phone)}</h2><a class="btn sm" href="#/clientes">← Volver</a></div>
      ${nick ? `<p class="sub" style="margin-top:-6px">${phoneFmt(phone)}</p>` : ''}
      <div class="row" style="margin-bottom:10px"><input class="grow" type="text" id="nick" maxlength="60" value="${esc(nick)}" placeholder="✏️ Apodo (ej. Doña Rosa, Ing. Minera)" style="min-width:0"><button class="btn sm" id="nickSave">Guardar</button></div>
      ${c ? `<div class="grid2">
        <div class="stat"><b>${c.calls}</b><span>pedidos en ${c.days} días</span></div>
        <div class="stat"><b>${shortDate(c.first)}–${shortDate(c.last)}</b><span>primer y último pedido</span></div>
        <div class="stat"><b>${zoneLabel(zones, c.zone, c.place, c.spot)}</b><span>lugar habitual</span></div>
        <div class="stat"><b>${c.mine}</b><span>veces que lo llevaste tú</span></div>
      </div>
      ${c.topDrivers.length ? `<p class="small sub">Lo suelen llevar: ${c.topDrivers.map(([n, k]) => `${esc(cap(n))} (${k})`).join(', ')}</p>` : ''}` : pats.length || calls.length ? '<p class="sub">Solo un pedido registrado.</p>' : '<p class="sub"><span class="pill warn">nuevo</span> Aún no aparece en los chats subidos. El apodo y la casa quedan guardados con su número: cuando subas el chat y aparezca, se juntan solos con sus pedidos.</p>'}
      <div class="row" style="margin-top:8px">
        <a class="btn sm" href="tel:+51${phone}">Llamar</a>
        <a class="btn sm" href="https://wa.me/51${phone}" target="_blank" rel="noopener">WhatsApp</a>
      </div>
    </section>

    <section class="card" id="homeCard">
      <div class="card-head"><h2>🏠 Casa del cliente</h2>${home ? '<span class="pill good">guardada</span>' : ''}</div>
      ${home ? `<p class="sub">${home.lat}, ${home.lng}${home.acc ? ` · ±${home.acc} m` : ''} · ${shortDate(String(home.updated_at || '').slice(0, 10))}</p>
        <div class="row">${homeLink(home, '🏠 Ir a la casa ↗')}${c ? goLink(zones, c.zone, c.spot).replace('Ir ↗', 'Zona ↗') : ''}</div>`
      : `<p class="sub">Cuando llegues a recogerlo, toca <b>Estoy en su casa</b>. La próxima vez que llame, el aviso y el botón te llevan directo a su puerta.</p>`}
      <div class="row" style="margin-top:8px">
        <button class="btn ${home ? '' : 'primary'}" id="hereBtn">📍 ${home ? 'Actualizar: estoy en su casa' : 'Estoy en su casa'}</button>
        ${home ? '<button class="btn danger sm" id="homeDel">Quitar</button>' : ''}
      </div>
      <div class="row" style="margin-top:8px"><input class="grow" type="text" id="homeCoords" placeholder="o pega coordenada / enlace de Maps" style="min-width:0"><button class="btn sm" id="homeSave">Guardar</button></div>
      <div class="small sub" id="homeMsg" style="margin-top:4px"></div>
    </section>

    ${pats.map(p => `<section class="card">
      <div class="card-head"><h2>Suele llamar ${hhmm(p.minute)}</h2>${STATUS[p.status]}</div>
      <div class="row">${daysChips(p.days)} <span class="sub">${pct(p.confidence)} de esos días · ${p.hits} veces</span></div>
      <p class="sub">Ventana ${hhmm(p.from)}–${hhmm(p.to)} · ${zoneLabel(zones, p.zone, p.place, p.spot)} · desde ${shortDate(p.first)} hasta ${shortDate(p.last)}${p.misses ? ` · faltó ${p.misses} veces seguidas desde entonces` : ''}</p>
      <div class="row">${goLink(zones, p.zone, p.spot)}</div>
    </section>`).join('')}

    <section class="card">
      <h2>Historial</h2>
      <div class="scroll-x"><table>
        <tr><th>Día</th><th>Hora</th><th style="text-align:left">Lugar</th><th>Taxista</th></tr>
        ${calls.slice(0, 200).map(row).join('')}
      </table></div>
    </section>`;

  const reload = () => renderCliente(view, phone);
  const saveNick = async () => { await saveName(phone, $('#nick').value.trim()); toast($('#nick').value.trim() ? 'Apodo guardado' : 'Apodo quitado'); reload(); };
  $('#nickSave').onclick = saveNick;
  $('#nick').onkeydown = e => { if (e.key === 'Enter') saveNick(); };
  $('#hereBtn').onclick = async e => {
    e.target.disabled = true;
    try {
      const r = await getHere({ onUpdate: x => ($('#homeMsg').textContent = `Buscando señal GPS… ±${x.acc} m`) });
      if (r.acc > 60 && !confirm(`La precisión es baja (±${r.acc} m). ¿Guardar igual?`)) { e.target.disabled = false; return; }
      await saveHome(phone, r.lat, r.lng, r.acc);
      toast(`🏠 Casa guardada (±${r.acc} m)`);
      reload();
    } catch (err) { toast(err.message, 5000); e.target.disabled = false; $('#homeMsg').textContent = ''; }
  };
  $('#homeSave').onclick = async () => {
    const ll = parseCoords($('#homeCoords').value);
    if (!ll) return toast('No reconocí la coordenada. Ej: -15.847427, -74.257044', 4000);
    await saveHome(phone, ll[0], ll[1]);
    toast('🏠 Casa guardada');
    reload();
  };
  const del = $('#homeDel');
  if (del) del.onclick = async () => { if (confirm('¿Quitar la casa de este cliente?')) { await deleteHome(phone); reload(); } };
}
