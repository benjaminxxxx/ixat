import { loadSnapshot } from '../app.js';
import { api } from '../api.js';
import { $, esc, limaNow, shortDate, toast, addDaysIso, WD_LONG } from '../util.js';
import { zoneIndex } from './common.js';
import { eventItem } from './ahora.js';
import { occurrences, minToTime, timeToMin, peruHolidays } from '../events.js';

export async function renderEventos(view) {
  const [snap, events] = await Promise.all([loadSnapshot().catch(() => null), api('events.php')]);
  const zones = zoneIndex(snap || { zones: [] });
  const lift = new Map((snap?.eventStats || []).map(x => [x.id, x]));
  const today = limaNow().date;
  let editing = null;

  // Próximas ocurrencias (un año) y, de las pasadas, las que tienen datos del chat.
  const next = [];
  for (const ev of events) {
    const d = occurrences(ev, today, addDaysIso(today, 366))[0];
    if (d) next.push({ ev, date: d });
  }
  next.sort((a, b) => a.date.localeCompare(b.date) || a.ev.from_min - b.ev.from_min);
  const measured = events.map(ev => ({ ev, st: lift.get(ev.id) })).filter(x => x.st && x.st.past.length)
    .sort((a, b) => (b.st.lift ?? 0) - (a.st.lift ?? 0));
  const zoneOpts = [...zones.values()].sort((a, b) => a.name.localeCompare(b.name));

  view.innerHTML = `
    <section class="card" id="evForm"></section>

    <section class="card">
      <div class="card-head"><h2>Próximos</h2><span class="sub">${next.length}</span></div>
      <div class="list" id="evNext">${next.slice(0, 40).map(x => row(x)).join('') || '<div class="empty">Sin eventos. Agrega uno arriba o carga los feriados.</div>'}</div>
    </section>

    <section class="card">
      <h2>Lo que pasó otras veces</h2>
      <p class="small muted">Pedidos en las horas del evento comparados con un día normal (mismo día de la semana y hora). Solo cuenta horas en que el chat tenía datos.</p>
      ${measured.length ? `<div class="scroll-x"><table>
        <tr><th style="text-align:left">Evento</th><th>Fecha</th><th>Pedidos</th><th>Normal</th><th>Cambio</th></tr>
        ${measured.flatMap(({ ev, st }) => st.past.map(p => `<tr><td style="text-align:left">${esc(ev.name)}${p.hours < 4 ? ' <span class="muted small">(pocos datos)</span>' : ''}</td><td>${WD_LONG[new Date(p.date + 'T00:00:00Z').getUTCDay()].slice(0, 3)} ${shortDate(p.date)}</td><td>${p.actual}</td><td>${Math.round(p.expected)}</td><td><b>${p.expected ? (p.actual >= p.expected ? '+' : '') + Math.round((p.actual / p.expected - 1) * 100) + '%' : '—'}</b></td></tr>`)).join('')}
      </table></div>` : '<p class="sub">Todavía no hay eventos con datos del chat. Se calcula al tocar Reprocesar en Datos o Zonas.</p>'}
    </section>

    <section class="card">
      <h2>Feriados de Perú</h2>
      <p class="sub">Carga los feriados nacionales, Halloween, Nochebuena, Año Nuevo, Semana Santa, Día de la Madre y del Padre. No se repiten si ya están.</p>
      <div class="row"><button class="btn" id="holBtn">Cargar feriados ${today.slice(0, 4)}–${+today.slice(0, 4) + 1}</button></div>
    </section>`;

  function row(x) {
    return `<div class="item" data-id="${x.ev.id}" style="cursor:pointer">${eventItem(x, zones, lift).replace(/^<div class="item">|<\/div>$/g, '')}</div>`;
  }

  const drawForm = () => {
    const e = editing || { id: 0, name: '', date: today, from_min: 1080, to_min: 1380, zone_id: null, yearly: 0, note: '' };
    $('#evForm').innerHTML = `
      <div class="card-head"><h2>${e.id ? 'Editar evento' : 'Nuevo evento'}</h2>${e.id ? '<button class="btn sm" id="evCancel">Cancelar</button>' : ''}</div>
      <div style="display:grid;gap:10px">
        <label class="field">Qué es<input type="text" id="evName" value="${esc(e.name)}" placeholder="ej. Aniversario Minera Paraíso, fiesta del colegio…"></label>
        <div class="row">
          <label class="field grow">Fecha<input type="date" id="evDate" value="${e.date}"></label>
          <label class="field">Desde<input type="time" id="evFrom" value="${minToTime(e.from_min)}"></label>
          <label class="field">Hasta<input type="time" id="evTo" value="${minToTime(e.to_min)}"></label>
        </div>
        <label class="field">Dónde (opcional)<select id="evZone"><option value="">Todo Chala</option>${zoneOpts.map(z => `<option value="${z.id}" ${z.id === e.zone_id ? 'selected' : ''}>${z.kind === 'lugar' ? '📍' : '▢'} ${esc(z.name)}</option>`).join('')}</select></label>
        <label class="row" style="gap:8px"><input type="checkbox" id="evYearly" ${e.yearly ? 'checked' : ''} style="width:auto"> Se repite cada año en la misma fecha</label>
        <label class="field">Nota<input type="text" id="evNote" value="${esc(e.note && e.note !== 'feriado' ? e.note : '')}" placeholder="opcional"></label>
        <p class="small muted" style="margin:0">Si “hasta” es menor que “desde”, termina al día siguiente (ej. 20:00 → 03:00). Te llega un aviso 1 hora antes.</p>
        <div class="row"><span class="grow"></span>${e.id ? '<button class="btn danger" id="evDel">Eliminar</button>' : ''}<button class="btn primary" id="evSave">Guardar</button></div>
      </div>`;
    $('#evSave').onclick = async () => {
      const body = {
        id: e.id || undefined, name: $('#evName').value.trim(), date: $('#evDate').value,
        from_min: timeToMin($('#evFrom').value), to_min: timeToMin($('#evTo').value),
        zone_id: $('#evZone').value ? +$('#evZone').value : null, yearly: $('#evYearly').checked ? 1 : 0,
        note: $('#evNote').value.trim() || (e.note === 'feriado' ? 'feriado' : ''),
      };
      if (!body.name || !body.date) return toast('Ponle nombre y fecha');
      await api('events.php', { method: 'POST', body });
      toast('Evento guardado. Reprocesa para que llegue el aviso.', 4000);
      renderEventos(view);
    };
    const c = $('#evCancel'); if (c) c.onclick = () => { editing = null; drawForm(); };
    const d = $('#evDel'); if (d) d.onclick = async () => {
      if (!confirm(`¿Eliminar "${e.name}"?`)) return;
      await api('events.php?id=' + e.id, { method: 'DELETE' });
      renderEventos(view);
    };
  };

  $('#evNext').onclick = e => {
    const it = e.target.closest('[data-id]');
    if (!it || e.target.closest('a')) return;
    editing = events.find(x => x.id === +it.dataset.id);
    drawForm();
    $('#evForm').scrollIntoView({ behavior: 'smooth' });
  };
  $('#holBtn').onclick = async e => {
    e.target.disabled = true;
    const y = +today.slice(0, 4);
    const r = await api('events.php', { method: 'POST', body: { list: [...peruHolidays(y), ...peruHolidays(y + 1)] } });
    toast(r.added ? `${r.added} feriados agregados` : 'Ya estaban todos');
    renderEventos(view);
  };
  drawForm();
}
