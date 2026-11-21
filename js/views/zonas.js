import { api } from '../api.js';
import { loadSnapshot } from '../app.js';
import { $, esc, cap, toast, parseCoords, centroid, getHere } from '../util.js';
import { makeLocator, norm } from '../processor.js';
import { runProcess } from './datos.js';
import { standardize, planNames, keepOldName } from '../naming.js';
import { alturasFor } from '../alturas.js';
import { pendingItems, suggestions } from '../pendientes.js';

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
let pendFilter = 'todo';
let pendQuery = '';
// Sin espacios: "coca" encuentra "cocacola" y "coca cola".
const flat = t => norm(t).replace(/ /g, '');
const hasText = (t, q) => flat(t).includes(flat(q));
const matchesQuery = (z, q) => !q || hasText(z.name, q) || z.aliases.some(a => hasText(a, q));

export async function renderZonas(view) {
  view.innerHTML = '<div class="card empty">Cargando mapa…</div>';
  const [zonesRaw, snap, ignoredRaw] = await Promise.all([api('zones.php'), loadSnapshot().catch(() => null), api('ignored.php').catch(() => []), loadLibs()]);
  let zones = zonesRaw;
  const ignored = new Set(ignoredRaw);
  const counts = new Map((snap?.zones || []).map(z => [z.id, z]));
  let selected = null;
  let drawer = null;
  let picking = false; // esperando un toque en el mapa para el punto de un lugar

  view.innerHTML = `
    <section class="card" id="reproc" hidden>
      <div class="row"><div class="grow sub">Hiciste cambios. Reprocesa para que el análisis los use.</div><button class="btn primary" id="reprocBtn">Reprocesar</button></div>
    </section>
    <section class="card" id="pendCard">
      <div class="card-head"><h2>Pendientes</h2><span class="small sub">lo más usado primero</span></div>
      <input type="search" id="pendQ" placeholder="Filtrar pendientes…" value="${esc(pendQuery)}" autocomplete="off" style="margin-bottom:8px">
      <div class="seg" id="pendSeg" style="margin-bottom:8px"></div>
      <div class="item" id="pendUndo" hidden style="margin-bottom:8px;outline:1px solid var(--accent)"><span class="grow small" id="pendUndoText"></span><button class="btn sm" id="pendUndoBtn">↩ Deshacer</button></div>
      <datalist id="zoneNames"></datalist>
      <div id="pendList" class="list" style="max-height:48vh;overflow-y:auto;overscroll-behavior:contain"></div>
      <button class="btn sm" id="pendMore" hidden style="width:100%;margin-top:8px"></button>
    </section>
    <section class="card" style="padding:10px">
      <div id="map"></div>
      <p class="small muted" style="margin:8px 4px 0" id="mapHelp">Toca una zona o lugar para editarlo. Capas (arriba a la derecha): calles o satélite.</p>
    </section>
    <section class="card" id="editor" hidden></section>
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
`;

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

  let dirty = false;
  const markDirty = () => { dirty = true; $('#reproc').hidden = false; };

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
        <div class="grow"><b>${esc(z.name)}</b> ${badge}${z.no_wait ? ' <span class="pill warn">no sugerir</span>' : ''}
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
    const waits = new Map((snap?.waitSpots || []).map(s => [s.zone, s.n]));
    const alturas = isPlace ? [] : alturasFor(selected, zones, id => (counts.get(id)?.direct || 0) + (waits.get(id) || 0) * 0.25);
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
        <label class="row" style="align-items:flex-start;flex-wrap:nowrap;cursor:pointer">
          <input type="checkbox" id="zNoWait" style="width:auto;margin-top:3px" ${selected.no_wait ? 'checked' : ''}>
          <span class="grow"><b>No sugerir como punto de espera</b>
            <span class="small sub" style="display:block">${isPlace ? 'Este lugar no saldrá en las recomendaciones.' : alturas.length ? 'Calle larga: se recomendará a qué altura ponerte.' : 'No parece una calle larga o no tiene referencias cerca: se recomendarán los lugares que tiene dentro.'}</span>
            <span class="small muted" id="zAlturas" style="display:block;margin-top:2px" ${selected.no_wait && alturas.length ? '' : 'hidden'}>${alturas.map(a => esc(a.name)).join(' · ')}</span></span>
        </label>
        <div class="row">
          <span class="grow"></span>
          ${selected.id ? '<button class="btn danger" id="zDel">Eliminar</button>' : ''}
          <button class="btn primary" id="zSave">Guardar</button>
        </div>
      </div>`;

    const read = () => Object.assign(selected, { name: $('#zName').value.trim(), aliases: $('#zAliases').value.split(',').map(s => s.trim()).filter(Boolean) });
    $('#zNoWait').onchange = e => { selected.no_wait = e.target.checked ? 1 : 0; $('#zAlturas').hidden = !selected.no_wait || !alturas.length; };
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
    pickTarget = null;
    $('#mapHelp').textContent = 'Toca una zona o lugar para editarlo. Capas (arriba a la derecha): calles o satélite.';
  };

  const refresh = () => { drawShapes(); showEditMarker(); drawEditor(); drawList(); drawPending(); };

  map.on('click', async e => {
    if (pickTarget) {
      const target = pickTarget;
      stopTools();
      try { await applyPoint(target, round(e.latlng)); } catch (err) { toast(err.message, 5000); }
      $('#pendCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    try { await runProcess(msg => (e.target.textContent = msg)); $('#reproc').hidden = true; dirty = false; toast('Análisis actualizado'); }
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

  // ---- Pendientes: una sola lista con filtros; cada acción la saca de la lista y se puede deshacer ----
  let pickTarget = null; // { text } o { id }: esperando un toque en el mapa
  let pendItems = [];
  let pendLimit = 40;
  let openKey = null; // fila con las opciones extra abiertas
  let undo = null;
  const TAGS = { texto: ['Sin registrar', 'warn'], punto: ['Sin punto', 'bad'], dibujo: ['Sin dibujar', 'bad'] };
  const itemOf = key => pendItems.find(i => i.key === key);
  const zoneOf = id => zones.find(z => z.id === id);
  const reloadZones = async () => { zones = await api('zones.php'); markDirty(); };
  const done = (label, run) => { undo = { label, run }; refresh(); };

  const rowHtml = it => {
    const [tag, cls] = TAGS[it.type];
    const chips = it.type === 'dibujo' ? [] : suggestions(it, zones, pendItems);
    const canPoint = it.type !== 'dibujo';
    return `<div class="item" data-key="${esc(it.key)}" style="display:block">
      <div class="row"><b class="grow">${esc(it.name)}</b><span class="pill ${cls}">${tag}</span><span class="small muted">${it.n} veces</span></div>
      ${chips.length ? `<div class="row" style="margin-top:6px"><span class="small sub">¿Es igual a?</span>${chips.map(c => `<button class="btn sm primary" data-act="merge" data-to="${esc(c.key)}">${esc(c.name)}</button>`).join('')}</div>` : ''}
      <div class="row" style="margin-top:6px">
        ${canPoint ? '<button class="btn sm" data-act="here">📍 Estoy aquí</button><button class="btn sm" data-act="pick">🗺️ Marcar</button>' : '<button class="btn sm primary" data-act="draw">▢ Dibujar</button>'}
        <button class="btn sm" data-act="more">${openKey === it.key ? 'Menos' : 'Más…'}</button>
        ${it.type === 'texto' ? '<button class="btn sm" data-act="ignore" style="margin-left:auto">🚫 No es lugar</button>' : '<button class="btn sm" data-act="edit" style="margin-left:auto">Editar</button>'}
      </div>
      ${openKey === it.key ? `<div style="display:grid;gap:6px;margin-top:6px">
        ${canPoint ? `<div class="row"><input class="grow" type="text" data-coords placeholder="Pegar coordenada o enlace de Maps" style="min-width:0"><button class="btn sm primary" data-act="coords">Usar</button></div>` : ''}
        <div class="row"><input class="grow" type="search" data-assign list="zoneNames" placeholder="Es igual a… (busca el nombre)" style="min-width:0"><button class="btn sm" data-act="same">Unir</button></div>
        ${it.type === 'texto' ? '<div class="row"><button class="btn sm" data-act="nopoint">Crear sin punto</button><button class="btn sm" data-act="zona">▢ Es una zona</button></div>' : ''}
      </div>` : ''}
    </div>`;
  };

  const drawPending = () => {
    pendItems = pendingItems(zones, snap?.unmatchedPlaces || [], counts, ignored);
    const total = t => pendItems.filter(i => t === 'todo' || i.type === t).length;
    $('#pendSeg').innerHTML = [['todo', 'Todo'], ['texto', 'Sin registrar'], ['punto', 'Sin punto'], ['dibujo', 'Sin dibujar']]
      .map(([k, l]) => `<button data-f="${k}" class="${pendFilter === k ? 'on' : ''}">${l} ${total(k)}</button>`).join('');
    $('#zoneNames').innerHTML = [...zones].sort((a, b) => a.name.localeCompare(b.name))
      .map(z => `<option value="${esc(z.name)}">${z.kind === 'lugar' ? '📍 lugar' : '▢ zona'}${z.aliases.length ? ' · ' + esc(z.aliases.slice(0, 3).join(', ')) : ''}</option>`).join('')
      + pendItems.filter(i => i.type === 'texto').map(i => `<option value="${esc(i.name)}">📝 texto pendiente · ${i.n} veces</option>`).join('');
    const shown = pendItems.filter(i => (pendFilter === 'todo' || i.type === pendFilter) && (!pendQuery.trim() || hasText(i.name, pendQuery)));
    const list = $('#pendList'), top = list.scrollTop;
    list.innerHTML = shown.slice(0, pendLimit).map(rowHtml).join('') || '<div class="empty"><b>Nada pendiente aquí</b>Si subiste chats nuevos, recalcula para ver sus textos.</div>';
    list.scrollTop = top;
    $('#pendMore').hidden = shown.length <= pendLimit;
    $('#pendMore').textContent = `Ver más (${shown.length - pendLimit})`;
    const bar = $('#pendUndo');
    bar.hidden = !undo;
    if (undo) $('#pendUndoText').textContent = undo.label;
  };

  const createFromText = async (text, ll) => {
    const z = await save({ id: 0, kind: 'lugar', name: standardize({ name: text, aliases: [text] }).name, aliases: [text], polygon: null, lat: ll ? ll[0] : null, lng: ll ? ll[1] : null });
    const p = ll ? geo().container(ll[0], ll[1]) : -1;
    done(`${z.name} creado${!ll ? ' sin punto' : p >= 0 ? ` · dentro de ${nameOf(p)}` : ''}`, async () => { await api('zones.php?id=' + z.id, { method: 'DELETE' }); await reloadZones(); });
  };
  const setPoint = async (id, ll) => {
    const z = zoneOf(id);
    await save({ ...z, lat: ll[0], lng: ll[1] });
    const p = geo().container(ll[0], ll[1]);
    done(`${z.name} ubicado${p >= 0 ? ` · dentro de ${nameOf(p)}` : ''}`, async () => { await save({ ...z, lat: null, lng: null }); });
  };
  const applyPoint = (target, ll) => (target.text ? createFromText(target.text, ll) : setPoint(target.id, ll));

  // Une un pendiente con una zona, un lugar u otro texto.
  const mergeInto = async (it, toKey) => {
    if (toKey.startsWith('t:')) {
      const other = itemOf(toKey);
      const z = await save({ id: 0, kind: 'lugar', name: standardize({ name: other.text, aliases: [other.text] }).name, aliases: [other.text, it.text], polygon: null, lat: null, lng: null });
      return done(`${z.name} creado con “${it.name}” y “${other.name}”. Falta su punto`, async () => { await api('zones.php?id=' + z.id, { method: 'DELETE' }); await reloadZones(); });
    }
    const target = zoneOf(+toKey.slice(2));
    const before = [...target.aliases];
    if (it.type === 'texto') {
      await save({ ...target, aliases: [...before, it.text] });
      return done(`“${it.name}” ahora cuenta como ${target.name}`, async () => { await save({ ...target, aliases: before }); });
    }
    // Un registro repetido: pasa sus textos al otro y se elimina.
    const dup = zoneOf(it.id);
    const events = await api('events.php');
    if (events.some(ev => ev.zone_id === dup.id)) return toast(`${dup.name} se usa en un evento: cámbialo primero`, 4500);
    await save({ ...target, aliases: [...new Set([...before, norm(dup.name), ...dup.aliases])] });
    await api('zones.php?id=' + dup.id, { method: 'DELETE' });
    await reloadZones();
    if (selected?.id === dup.id) selected = null;
    done(`${dup.name} unido a ${target.name}`, async () => {
      await api('zones.php', { method: 'POST', body: { ...dup, id: 0 } });
      await save({ ...target, aliases: before });
    });
  };
  // "Es igual a…" escrito a mano: nombre exacto, texto del chat o el parecido más corto.
  const resolveTarget = (it, typed) => {
    const v = norm(typed);
    if (!v) return null;
    const text = it.type === 'texto' && pendItems.find(i => i.type === 'texto' && i.key !== it.key && i.text === v);
    if (text) return text.key;
    const z = zones.find(x => x.id !== it.id && norm(x.name) === v) || zones.filter(x => x.id !== it.id && matchesQuery(x, v)).sort((a, b) => a.name.length - b.name.length)[0];
    return z ? 'z:' + z.id : null;
  };

  $('#pendSeg').onclick = e => { const f = e.target.dataset.f; if (f) { pendFilter = f; pendLimit = 40; $('#pendList').scrollTop = 0; drawPending(); } };
  $('#pendQ').oninput = e => { pendQuery = e.target.value; pendLimit = 40; $('#pendList').scrollTop = 0; drawPending(); };
  $('#pendMore').onclick = () => { pendLimit += 40; drawPending(); };
  $('#pendUndoBtn').onclick = async e => {
    if (!undo) return;
    e.target.disabled = true;
    try { await undo.run(); undo = null; toast('Deshecho'); refresh(); }
    catch (err) { toast(err.message, 5000); }
    e.target.disabled = false;
  };
  $('#pendList').onkeydown = e => {
    if (e.key !== 'Enter') return;
    const row = e.target.closest('[data-key]');
    if (e.target.matches('[data-coords]')) row.querySelector('[data-act="coords"]').click();
    if (e.target.matches('[data-assign]')) row.querySelector('[data-act="same"]').click();
  };
  $('#pendList').onclick = async e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('[data-key]'), it = itemOf(row.dataset.key), act = btn.dataset.act;
    if (!it) return;
    const target = it.type === 'texto' ? { text: it.text } : { id: it.id };
    if (act === 'more') { openKey = openKey === it.key ? null : it.key; return drawPending(); }
    if (act === 'edit') return select(it.id);
    if (act === 'draw') { select(it.id); return $('#zDraw').click(); }
    if (act === 'pick') {
      stopTools();
      pickTarget = target;
      $('#mapHelp').innerHTML = `<b>Toca el mapa donde está “${esc(it.name)}”.</b>`;
      return $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    btn.disabled = true;
    try {
      if (act === 'merge') await mergeInto(it, btn.dataset.to);
      else if (act === 'here') { const r = await getHere({ onUpdate: x => (btn.textContent = `±${x.acc} m…`) }); await applyPoint(target, [r.lat, r.lng]); }
      else if (act === 'coords') {
        const ll = parseCoords(row.querySelector('[data-coords]').value);
        if (!ll) { btn.disabled = false; return toast('No reconocí la coordenada. Ej: -15.847427, -74.257044', 4000); }
        await applyPoint(target, ll);
      } else if (act === 'same') {
        const to = resolveTarget(it, row.querySelector('[data-assign]').value);
        if (!to) { btn.disabled = false; return toast('No encontré ese nombre', 3000); }
        await mergeInto(it, to);
      } else if (act === 'nopoint') await createFromText(it.text, null);
      else if (act === 'zona') {
        selected = await save({ id: 0, kind: 'zona', name: cap(it.text), aliases: [it.text], polygon: null, lat: null, lng: null });
        const id = selected.id;
        done(`Zona ${selected.name} creada: dibújala`, async () => { await api('zones.php?id=' + id, { method: 'DELETE' }); selected = null; await reloadZones(); });
        $('#zDraw').click();
      } else if (act === 'ignore') {
        await api('ignored.php', { method: 'POST', body: { text: it.text } });
        ignored.add(it.text);
        done(`“${it.name}” no volverá a salir`, async () => { await api('ignored.php?text=' + encodeURIComponent(it.text), { method: 'DELETE' }); ignored.delete(it.text); });
      }
      openKey = null;
    } catch (err) { toast(err.message, 5000); btn.disabled = false; drawPending(); }
  };

  refresh();
  if (shapes.getLayers().length) map.fitBounds(shapes.getBounds(), { maxZoom: 16 });
  setTimeout(() => map.invalidateSize(), 50);

  // Al salir de Zonas con cambios sin recalcular, el análisis se actualiza solo.
  return () => { stopTools(); map.remove(); if (dirty) import('../app.js').then(m => m.reprocess()); };
}
