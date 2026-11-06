import { api } from '../api.js';
import { loadSnapshot } from '../app.js';
import { $, esc, cap, toast, parseCoords, centroid, getHere } from '../util.js';
import { makeLocator, norm } from '../processor.js';
import { runProcess } from './datos.js';
import { standardize, planNames, keepOldName } from '../naming.js';

const CHALA = [-15.8565, -74.247];
const LIBS = [
  ['css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'],
  ['css', 'https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.css'],
  ['js', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'],
  ['js', 'https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.js'],
];

let libsReady = null;
export function loadLibs() {
  if (libsReady) return libsReady;
  libsReady = LIBS.reduce((p, [type, url]) => p.then(() => new Promise((ok, bad) => {
    const el = document.createElement(type === 'css' ? 'link' : 'script');
    if (type === 'css') { el.rel = 'stylesheet'; el.href = url; ok(); } else { el.src = url; el.onload = ok; el.onerror = () => bad(new Error('No cargó el mapa (¿sin internet?)')); }
    document.head.appendChild(el);
  })), Promise.resolve());
  return libsReady;
}

const round = p => [+p.lat.toFixed(7), +p.lng.toFixed(7)];
const located = z => (z.kind === 'lugar' ? z.lat != null : !!(z.polygon && z.polygon.length >= 3));
let listFilter = 'todas';
let listQuery = '';
let textQuery = '';
// Sin espacios: "coca" encuentra "cocacola" y "coca cola".
const flat = t => norm(t).replace(/ /g, '');
const hasText = (t, q) => flat(t).includes(flat(q));
const matchesQuery = (z, q) => !q || hasText(z.name, q) || z.aliases.some(a => hasText(a, q));

export async function renderZonas(view) {
  view.innerHTML = '<div class="card empty">Cargando mapa…</div>';
  const [zonesRaw, snap] = await Promise.all([api('zones.php'), loadSnapshot().catch(() => null), loadLibs()]);
  let zones = zonesRaw;
  const counts = new Map((snap?.zones || []).map(z => [z.id, z]));
  let selected = null;
  let drawer = null;
  let picking = false; // esperando un toque en el mapa para el punto de un lugar

  view.innerHTML = `
    <section class="card" style="padding:10px">
      <div id="map"></div>
      <p class="small muted" style="margin:8px 4px 0" id="mapHelp">Toca una zona o lugar para editarlo. Capas (arriba a la derecha): calles o satélite.</p>
    </section>
    <section class="card" id="editor" hidden></section>
    <section class="card" id="reproc" hidden>
      <div class="row"><div class="grow sub">Hiciste cambios. Reprocesa para que el análisis los use.</div><button class="btn primary" id="reprocBtn">Reprocesar</button></div>
    </section>
    <section class="card">
      <h3>Probar texto del chat</h3>
      <div class="row"><input class="grow" type="text" id="probe" placeholder="ej. alto paraiso, minera paraiso…"></div>
      <div id="probeOut" class="sub" style="margin-top:6px"></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Zonas y lugares</h2>
        <div class="row"><button class="btn sm" id="newPlace">+ Lugar</button><button class="btn sm primary" id="newZone">+ Zona</button></div></div>
      <input type="search" id="zSearch" placeholder="Buscar por nombre o texto del chat (ej. hostal, grifo)…" value="${esc(listQuery)}" style="margin-bottom:10px">
      <div class="seg" id="listSeg" style="margin-bottom:10px">
        <button data-f="todas">Todas</button><button data-f="zona">Zonas</button><button data-f="lugar">Lugares</button><button data-f="sin">Sin ubicar</button>
      </div>
      <div id="zoneList" class="list"></div>
      <div class="row" style="margin-top:10px"><span class="small sub grow">Nombres con su tipo: Hostal…, Grifo…, Grass… Los textos del chat se conservan.</span><button class="btn sm" id="tidy">🧹 Ordenar nombres</button></div>
    </section>
    <section class="card">
      <h2>Textos sin zona</h2>
      <p class="sub">Lo que aparece en el chat y aún no se reconoce. Si estás ahí, toca <b>📍 Aquí</b>. Si no, pega la coordenada (o toca 🗺️) y toca <b>Crear lugar</b>. Si es otro nombre de algo que ya existe, búscalo en “Es igual a…”.</p>
      <input type="search" id="tSearch" placeholder="Filtrar textos…" value="${esc(textQuery)}" style="margin-bottom:10px">
      <datalist id="zoneNames"></datalist>
      <div id="unmatched" class="list"></div>
    </section>`;

  const map = L.map('map', { zoomControl: true, maxZoom: 21 }).setView(CHALA, 15);
  // maxNativeZoom: más allá de esto se agranda la última imagen disponible (permite acercar más).
  const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 18, attribution: '© Esri' });
  L.control.layers({ Calles: street, Satélite: sat }).addTo(map);
  const shapes = L.featureGroup().addTo(map);
  const layers = new Map();
  let editMarker = null;

  const geo = () => makeLocator(zones);
  const nameOf = id => zones.find(z => z.id === id)?.name || '';

  const drawShapes = () => {
    shapes.clearLayers();
    layers.clear();
    for (const z of zones) {
      const isSel = selected && selected.id === z.id;
      if (z.kind !== 'lugar' && z.polygon && z.polygon.length >= 3) {
        const poly = L.polygon(z.polygon, { color: isSel ? '#d13b2e' : '#14130f', weight: isSel ? 3 : 2, fillColor: '#f5c400', fillOpacity: isSel ? 0.35 : 0.2 })
          .bindTooltip(esc(z.name), { permanent: true, direction: 'center', className: 'zone-label' })
          .on('click', () => !picking && select(z.id));
        poly.addTo(shapes);
        layers.set(z.id, poly);
      }
    }
    // Los lugares encima de las zonas.
    for (const z of zones) {
      if (z.kind !== 'lugar' || z.lat == null || (selected && selected.id === z.id)) continue;
      L.circleMarker([z.lat, z.lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#d13b2e', fillOpacity: 1 })
        .bindTooltip(esc(z.name), { direction: 'top', offset: [0, -6], className: 'zone-label' })
        .on('click', () => !picking && select(z.id))
        .addTo(shapes);
    }
  };

  const markDirty = () => ($('#reproc').hidden = false);

  const save = async z => {
    const body = { ...z };
    if (body.kind === 'lugar') body.polygon = null; else { body.lat = null; body.lng = null; }
    const res = await api('zones.php', { method: 'POST', body });
    zones = await api('zones.php');
    markDirty();
    return zones.find(x => x.id === res.id);
  };

  const drawList = () => {
    $('#listSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.f === listFilter));
    const g = geo();
    const q = norm(listQuery);
    const rows = zones.filter(z => matchesQuery(z, q)).filter(z => listFilter === 'todas' || (listFilter === 'sin' ? !located(z) : (z.kind || 'zona') === listFilter))
      .sort((a, b) => (counts.get(b.id)?.direct || 0) - (counts.get(a.id)?.direct || 0) || a.name.localeCompare(b.name));
    $('#zoneList').innerHTML = rows.map(z => {
      const c = counts.get(z.id);
      const inside = z.kind === 'lugar' && g.parent.get(z.id) >= 0 ? ` · dentro de ${esc(nameOf(g.parent.get(z.id)))}` : '';
      const badge = z.kind === 'lugar'
        ? (z.lat != null ? '<span class="pill good">📍 lugar</span>' : '<span class="pill warn">lugar sin punto</span>')
        : (z.polygon ? '<span class="pill good">▢ zona</span>' : '<span class="pill warn">zona sin dibujar</span>');
      return `<button class="item" data-id="${z.id}" style="border:0;text-align:left;cursor:pointer;${selected?.id === z.id ? 'outline:2px solid var(--accent)' : ''}">
        <div class="grow"><b>${esc(z.name)}</b> ${badge}
          <div class="small sub">${c ? c.direct + ' pedidos' + (z.kind !== 'lugar' && c.calls > c.direct ? ` (+${c.calls - c.direct} de lugares dentro)` : '') : ''}${inside}</div>
          <div class="small muted">${esc(z.aliases.join(', '))}</div></div>
      </button>`;
    }).join('') || '<div class="empty">Nada en esta lista.</div>';
  };

  const showEditMarker = () => {
    if (editMarker) { map.removeLayer(editMarker); editMarker = null; }
    if (!selected || selected.kind !== 'lugar' || selected.lat == null) return;
    editMarker = L.marker([selected.lat, selected.lng], { draggable: true }).addTo(map);
    editMarker.on('dragend', () => { [selected.lat, selected.lng] = round(editMarker.getLatLng()); updatePointInfo(); });
  };

  const updatePointInfo = () => {
    const el = $('#zPointInfo');
    if (!el) return;
    if (selected.lat == null) { el.innerHTML = '<span class="pill warn">Sin punto todavía</span>'; return; }
    const p = geo().container(selected.lat, selected.lng);
    $('#zCoords').value = `${selected.lat}, ${selected.lng}`;
    el.innerHTML = `${selected.lat}, ${selected.lng} · ${p >= 0 ? `queda dentro de <b>${esc(nameOf(p))}</b>` : 'no está dentro de ninguna zona'}`;
  };

  const drawEditor = () => {
    const ed = $('#editor');
    if (!selected) { ed.hidden = true; return; }
    ed.hidden = false;
    const isPlace = selected.kind === 'lugar';
    ed.innerHTML = `
      <div class="card-head"><h2>${selected.id ? 'Editar' : 'Nuevo'} ${isPlace ? 'lugar' : 'zona'}</h2><button class="btn sm" id="zClose">Cerrar</button></div>
      <div style="display:grid;gap:10px">
        <div class="seg" id="zKind"><button data-k="zona" class="${isPlace ? '' : 'on'}">▢ Zona (área)</button><button data-k="lugar" class="${isPlace ? 'on' : ''}">📍 Lugar (punto)</button></div>
        <label class="field">Nombre<input type="text" id="zName" value="${esc(selected.name)}"></label>
        <label class="field">Cómo lo escriben en el chat (separado por comas)<textarea id="zAliases" rows="2">${esc(selected.aliases.join(', '))}</textarea></label>
        ${isPlace ? `
          <label class="field">Coordenadas (pega desde Google Maps: número o enlace)
            <div class="row"><input class="grow" type="text" id="zCoords" placeholder="-15.847427, -74.257044" value="${selected.lat != null ? `${selected.lat}, ${selected.lng}` : ''}"><button class="btn sm" id="zApply">Usar</button></div></label>
          <div class="row"><button class="btn" id="zHere">📍 Estoy aquí</button><button class="btn" id="zPick">Tocar en el mapa</button></div>
          <div class="small sub" id="zPointInfo"></div>`
        : `<div class="row"><button class="btn" id="zDraw">${selected.polygon ? 'Redibujar' : 'Dibujar'} en mapa</button>${selected.polygon ? '<button class="btn" id="zEdit">Mover puntos</button>' : ''}</div>`}
        <div class="row">
          <span class="grow"></span>
          ${selected.id ? '<button class="btn danger" id="zDel">Eliminar</button>' : ''}
          <button class="btn primary" id="zSave">Guardar</button>
        </div>
      </div>`;

    const read = () => Object.assign(selected, { name: $('#zName').value.trim(), aliases: $('#zAliases').value.split(',').map(s => s.trim()).filter(Boolean) });
    $('#zClose').onclick = () => { stopTools(); selected = null; refresh(); };
    $('#zKind').onclick = e => {
      const k = e.target.dataset.k;
      if (!k || k === selected.kind) return;
      read();
      selected.kind = k;
      // Al pasar de zona dibujada a lugar, el punto empieza en el centro del dibujo.
      if (k === 'lugar' && selected.lat == null && selected.polygon) [selected.lat, selected.lng] = centroid(selected.polygon).map(v => +v.toFixed(7));
      stopTools(); refresh();
    };
    $('#zSave').onclick = async () => {
      read();
      if (!selected.name) return toast('Ponle un nombre');
      const layer = layers.get(selected.id);
      if (selected.kind !== 'lugar' && layer && layer.editing && layer.editing.enabled()) { selected.polygon = layer.getLatLngs()[0].map(round); layer.editing.disable(); }
      stopTools();
      const old = zones.find(z => z.id === selected.id);
      selected = await save(old ? keepOldName(selected, old.name) : selected);
      toast('Guardado');
      refresh();
    };
    const zd = $('#zDel');
    if (zd) zd.onclick = async () => {
      if (!confirm(`¿Eliminar "${selected.name}"?`)) return;
      await api('zones.php?id=' + selected.id, { method: 'DELETE' });
      zones = await api('zones.php');
      stopTools(); selected = null; markDirty(); refresh();
    };

    if (isPlace) {
      $('#zApply').onclick = () => {
        const ll = parseCoords($('#zCoords').value);
        if (!ll) return toast('No reconocí las coordenadas. Ej: -15.847427, -74.257044', 4000);
        if (Math.hypot(ll[0] - CHALA[0], ll[1] - CHALA[1]) > 0.5) toast('Ojo: ese punto está lejos de Chala', 4000);
        [selected.lat, selected.lng] = ll;
        showEditMarker(); updatePointInfo();
        map.setView(ll, Math.max(map.getZoom(), 18));
      };
      $('#zCoords').onkeydown = e => { if (e.key === 'Enter') $('#zApply').click(); };
      $('#zHere').onclick = async e => {
        e.target.disabled = true;
        try {
          const r = await getHere({ onUpdate: x => ($('#zPointInfo').textContent = `Buscando señal GPS… ±${x.acc} m`) });
          [selected.lat, selected.lng] = [r.lat, r.lng];
          showEditMarker(); updatePointInfo();
          map.setView([r.lat, r.lng], Math.max(map.getZoom(), 18));
          toast(`Punto tomado (±${r.acc} m). Toca Guardar.`, 3500);
        } catch (err) { toast(err.message, 5000); updatePointInfo(); }
        e.target.disabled = false;
      };
      $('#zPick').onclick = () => { picking = true; $('#mapHelp').innerHTML = '<b>Toca el mapa donde está el lugar.</b> Luego puedes arrastrar el marcador para ajustar.'; $('#map').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      updatePointInfo();
    } else {
      $('#zDraw').onclick = () => {
        stopTools(); read();
        drawer = new L.Draw.Polygon(map, { shapeOptions: { color: '#d13b2e', fillColor: '#f5c400' }, allowIntersection: false, showArea: false });
        drawer.enable();
        $('#mapHelp').innerHTML = '<b>Marca las esquinas</b> y toca el primer punto para cerrar.';
        $('#map').scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      const ze = $('#zEdit');
      if (ze) ze.onclick = () => { const l = layers.get(selected.id); if (l) { l.editing.enable(); toast('Arrastra los puntos y luego toca Guardar'); } };
    }
  };

  const stopTools = () => {
    if (drawer) { drawer.disable(); drawer = null; }
    picking = false;
    pickingText = null;
    $('#mapHelp').textContent = 'Toca una zona o lugar para editarlo. Capas (arriba a la derecha): calles o satélite.';
  };

  const refresh = () => { drawShapes(); showEditMarker(); drawEditor(); drawList(); drawUnmatched(); };

  map.on('click', async e => {
    if (pickingText) {
      const text = pickingText;
      pickingText = null;
      stopTools();
      await createPlace(text, round(e.latlng));
      return;
    }
    if (!picking || !selected) return;
    [selected.lat, selected.lng] = round(e.latlng);
    picking = false;
    $('#mapHelp').textContent = 'Arrastra el marcador si hace falta y toca Guardar.';
    showEditMarker(); updatePointInfo();
  });

  map.on(L.Draw.Event.CREATED, async e => {
    drawer = null;
    if (!selected) return;
    selected.polygon = e.layer.getLatLngs()[0].map(round);
    stopTools();
    if (!selected.name) { toast('Ponle nombre y guarda'); drawShapes(); drawEditor(); return; }
    selected = await save(selected);
    toast('Zona guardada');
    refresh();
  });

  const select = id => {
    stopTools();
    selected = structuredClone(zones.find(z => z.id === id));
    selected.kind = selected.kind || 'zona';
    refresh();
    const l = layers.get(id);
    if (selected.kind === 'lugar' && selected.lat != null) map.setView([selected.lat, selected.lng], Math.max(map.getZoom(), 18));
    else if (l) map.fitBounds(l.getBounds(), { maxZoom: 18, padding: [30, 30] });
    $('#editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const startNew = kind => { stopTools(); selected = { id: 0, kind, name: '', aliases: [], polygon: null, lat: null, lng: null }; refresh(); $('#zName').focus(); };
  $('#zoneList').onclick = e => { const b = e.target.closest('[data-id]'); if (b) select(+b.dataset.id); };
  $('#listSeg').onclick = e => { if (e.target.dataset.f) { listFilter = e.target.dataset.f; drawList(); } };
  $('#zSearch').oninput = e => { listQuery = e.target.value; drawList(); };
  $('#tSearch').oninput = e => { textQuery = e.target.value; drawUnmatched(); };
  $('#tidy').onclick = async e => {
    const plan = planNames(zones);
    if (!plan.length) return toast('Todos los nombres ya están en orden');
    const lines = plan.map(p => `• ${p.from} → ${p.keep.name}${p.removed.length ? ` (junta ${p.removed.map(r => r.name).join(', ')})` : ''}`);
    if (!confirm(`Se harán ${plan.length} cambios:\n\n${lines.slice(0, 40).join('\n')}${lines.length > 40 ? `\n… y ${lines.length - 40} más` : ''}`)) return;
    e.target.disabled = true;
    for (const p of plan) {
      await api('zones.php', { method: 'POST', body: p.keep });
      for (const r of p.removed) await api('zones.php?id=' + r.id, { method: 'DELETE' });
    }
    zones = await api('zones.php');
    selected = null; markDirty(); refresh();
    e.target.disabled = false;
    toast(`${plan.length} nombres ordenados`);
  };
  $('#newZone').onclick = () => startNew('zona');
  $('#newPlace').onclick = () => startNew('lugar');
  $('#reprocBtn').onclick = async e => {
    e.target.disabled = true;
    try { await runProcess(msg => (e.target.textContent = msg)); $('#reproc').hidden = true; toast('Análisis actualizado'); }
    catch (err) { toast(err.message, 5000); }
    e.target.disabled = false; e.target.textContent = 'Reprocesar';
  };

  // Probador: qué entiende el sistema de un texto del chat.
  $('#probe').oninput = e => {
    const t = norm(e.target.value);
    if (!t) { $('#probeOut').textContent = ''; return; }
    const r = geo().locate(t);
    $('#probeOut').innerHTML = r.zone < 0 ? '<span class="pill warn">No coincide con nada</span>'
      : r.spot >= 0 ? `📍 Lugar <b>${esc(nameOf(r.spot))}</b>${r.zone !== r.spot ? ` → cuenta para la zona <b>${esc(nameOf(r.zone))}</b>` : ' (fuera de toda zona)'}`
      : `▢ Zona <b>${esc(nameOf(r.zone))}</b>`;
  };

  // Textos sin zona: por defecto se crean como lugar (pegando su coordenada o tocando el mapa).
  // También se pueden asignar como palabra clave de algo existente, o crear como zona.
  let pickingText = null; // texto esperando un toque en el mapa para crear su lugar
  let pending = []; // textos sin zona que aún no se crean
  const drawUnmatched = () => {
    const known = new Set(zones.flatMap(z => [norm(z.name), ...z.aliases.map(a => norm(a))]));
    const list = (snap?.unmatchedPlaces || []).filter(([p]) => !known.has(p));
    pending = list;
    // Sugerencias: lugares y zonas creados, y también los otros textos pendientes (para agruparlos en un lugar nuevo).
    $('#zoneNames').innerHTML = [...zones].sort((a, b) => a.name.localeCompare(b.name))
      .map(z => `<option value="${esc(z.name)}">${z.kind === 'lugar' ? '📍 lugar' : '▢ zona'}${z.aliases.length ? ' · ' + esc(z.aliases.slice(0, 3).join(', ')) : ''}</option>`).join('')
      + list.map(([p, n]) => `<option value="${esc(cap(p))}">📝 texto pendiente · ${n} veces</option>`).join('');
    const tq = norm(textQuery);
    $('#unmatched').innerHTML = list.filter(([p]) => !tq || hasText(p, tq)).slice(0, 80).map(([p, n]) => `
      <div class="item" data-p="${esc(p)}" style="display:block">
        <div class="row"><b class="grow">${esc(cap(p))}</b>${(n => n !== cap(p) ? `<span class="small sub">→ ${esc(n)}</span>` : '')(standardize({ name: p, aliases: [p] }).name)}<span class="small muted">${n} veces</span></div>
        <div class="row" style="margin-top:6px">
          <input class="grow" type="text" data-coords placeholder="Pegar coordenada o enlace de Maps" style="min-width:0">
          <button class="btn sm" data-act="here" title="Estoy aquí: usar mi ubicación">📍 Aquí</button>
          <button class="btn sm" data-act="pick" title="Marcar tocando el mapa">🗺️</button>
          <button class="btn sm primary" data-act="lugar">📍 Crear lugar</button>
        </div>
        <div class="small sub" data-info style="margin-top:4px"></div>
        <div class="row" style="margin-top:6px">
          <input class="grow" type="search" data-assign list="zoneNames" placeholder="Es igual a… (busca el nombre)" style="min-width:0">
          <button class="btn sm" data-act="same">Asociar</button>
          <button class="btn sm" data-act="zona" title="Es un área: crear zona y dibujarla">▢ Zona</button>
        </div>
      </div>`).join('') || '<p class="sub">Nada pendiente (o falta procesar).</p>';
  };

  const createPlace = async (text, ll) => {
    const z = await save({ id: 0, kind: 'lugar', name: standardize({ name: text, aliases: [text] }).name, aliases: [text], polygon: null, lat: ll ? ll[0] : null, lng: ll ? ll[1] : null });
    const p = ll ? geo().container(ll[0], ll[1]) : -1;
    toast(`📍 ${z.name} creado${!ll ? ' sin punto (complétalo luego)' : p >= 0 ? ` · dentro de ${nameOf(p)}` : ''}`, 3500);
    refresh();
  };

  // Al pegar/escribir una coordenada, mostrar en qué zona caería.
  $('#unmatched').oninput = e => {
    if (!e.target.matches('[data-coords]')) return;
    const row = e.target.closest('[data-p]'), info = row.querySelector('[data-info]');
    const ll = parseCoords(e.target.value);
    if (!e.target.value.trim()) { info.textContent = ''; return; }
    if (!ll) { info.innerHTML = '<span class="pill warn">coordenada no reconocida</span>'; return; }
    const p = geo().container(ll[0], ll[1]);
    info.innerHTML = p >= 0 ? `queda dentro de <b>${esc(nameOf(p))}</b>` : 'fuera de toda zona';
  };
  $('#unmatched').onkeydown = e => {
    if (e.key !== 'Enter') return;
    const row = e.target.closest('[data-p]');
    if (e.target.matches('[data-coords]')) row.querySelector('[data-act="lugar"]').click();
    if (e.target.matches('[data-assign]')) row.querySelector('[data-act="same"]').click();
  };

  $('#unmatched').onclick = async e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('[data-p]'), text = row.dataset.p;
    if (btn.dataset.act === 'lugar') {
      const raw = row.querySelector('[data-coords]').value.trim();
      const ll = parseCoords(raw);
      if (raw && !ll) return toast('No reconocí la coordenada. Ej: -15.847427, -74.257044', 4000);
      btn.disabled = true;
      await createPlace(text, ll);
    } else if (btn.dataset.act === 'here') {
      // Estoy en el lugar: tomar el GPS y crearlo de una vez.
      btn.disabled = true;
      const info = row.querySelector('[data-info]');
      try {
        const r = await getHere({ onUpdate: x => (info.textContent = `Buscando señal GPS… ±${x.acc} m`) });
        await createPlace(text, [r.lat, r.lng]);
        toast(`📍 ${cap(text)} guardado aquí (±${r.acc} m)`, 3500);
      } catch (err) { toast(err.message, 5000); info.textContent = ''; btn.disabled = false; }
    } else if (btn.dataset.act === 'same') {
      await assignTo(row, text);
    } else if (btn.dataset.act === 'zona') {
      await createZoneFrom(text);
    } else if (btn.dataset.act === 'pick') {
      stopTools();
      pickingText = text;
      $('#mapHelp').innerHTML = `<b>Toca el mapa donde está “${esc(cap(text))}”.</b>`;
      $('#map').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const assignTo = async (row, text) => {
    const v = norm(row.querySelector('[data-assign]').value);
    if (!v) return toast('Escribe el nombre y elígelo de la lista');
    const others = pending.map(([p]) => p).filter(p => p !== text);
    const exactText = others.find(p => p === v);
    const z = !exactText && (zones.find(x => norm(x.name) === v) || zones.filter(x => matchesQuery(x, v)).sort((a, b) => a.name.length - b.name.length)[0]);
    if (!z) {
      // Es igual a otro texto pendiente: se crea un solo lugar con los dos.
      const other = exactText || others.find(p => hasText(p, v)); // la lista viene ordenada por más usado
      if (!other) return toast('No encontré ese nombre', 3000);
      const otherRow = [...document.querySelectorAll('#unmatched [data-p]')].find(r => r.dataset.p === other);
      const ll = parseCoords(row.querySelector('[data-coords]').value) || (otherRow && parseCoords(otherRow.querySelector('[data-coords]').value));
      const nz = await save({ id: 0, kind: 'lugar', name: standardize({ name: other, aliases: [other] }).name, aliases: [other, text], polygon: null, lat: ll ? ll[0] : null, lng: ll ? ll[1] : null });
      toast(`📍 ${nz.name} creado con "${cap(other)}" y "${cap(text)}"${ll ? '' : ' · ponle su punto en la lista'}`, 4500);
      refresh();
      return;
    }
    await save({ ...z, aliases: [...z.aliases, text] });
    toast(`"${cap(text)}" ahora cuenta como ${z.name}`);
    refresh();
  };
  $('#unmatched').addEventListener('change', e => {
    // Al elegir una sugerencia de la lista, asociar enseguida.
    if (e.target.matches('[data-assign]') && (zones.some(x => x.name === e.target.value) || pending.some(([p]) => cap(p) === e.target.value))) { const row = e.target.closest('[data-p]'); assignTo(row, row.dataset.p); }
  });
  const createZoneFrom = async text => {
    {
      selected = await save({ id: 0, kind: 'zona', name: cap(text), aliases: [text], polygon: null, lat: null, lng: null });
      toast('Zona creada: ahora dibújala', 4000);
      refresh();
      $('#editor').scrollIntoView({ behavior: 'smooth' });
    }
  };

  refresh();
  if (shapes.getLayers().length) map.fitBounds(shapes.getBounds(), { maxZoom: 16 });
  setTimeout(() => map.invalidateSize(), 50);

  return () => { stopTools(); map.remove(); };
}
