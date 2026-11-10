import { api, fetchAllMessages, getToken, setToken } from '../api.js';
import { state, loadSnapshot } from '../app.js';
import { $, esc, toast, num } from '../util.js';
import { parseWhatsApp } from '../parser.js';
import { SEED_ZONES } from '../seedZones.js';
import { LOGIC_VERSION } from '../processor.js';
import { pushStatus, enablePush, testPush } from '../push.js';

const BATCH = 3000;

// Descarga todo, procesa en segundo plano y sube el resultado. La usa también Zonas.
export async function runProcess(onStep = () => {}) {
  onStep('Descargando mensajes…');
  const messages = await fetchAllMessages(n => onStep(`Descargando… ${n.toLocaleString()}`));
  const [zones, events] = await Promise.all([api('zones.php'), api('events.php')]);
  onStep(`Procesando ${messages.length.toLocaleString()} mensajes…`);
  const snap = await new Promise((ok, bad) => {
    const w = new Worker(new URL('../worker.js', import.meta.url), { type: 'module' });
    w.onmessage = e => { w.terminate(); e.data.ok ? ok(e.data.snap) : bad(new Error(e.data.error)); };
    w.onerror = e => { w.terminate(); bad(new Error(e.message || 'Falló el procesador')); };
    w.postMessage({ messages, zones, events });
  });
  onStep('Guardando análisis…');
  await api('snapshot.php', { method: 'POST', body: snap });
  state.snap = snap;
  return snap;
}

// ¿Día o noche? 1) los mensajes que ya existen en la base; 2) el nombre del grupo (grupo 1 = día, grupo 2 = noche).
async function detectChat(fileName, raw, parsed) {
  const group = (raw.slice(0, 3000).match(/cre[oó] el grupo [“"](.+?)[”"]/) || fileName.match(/Chat de WhatsApp con (.+?)\.txt$/i) || [])[1] || '';
  try {
    const step = Math.max(1, Math.floor(parsed.length / 400));
    const sample = parsed.filter((_, i) => i % step === 0).slice(0, 500).map(m => [m.ts, m.sender, m.text, m.n]);
    const r = await api('messages.php?detect=1', { method: 'POST', body: { messages: sample } });
    const [best, n] = Object.entries(r.matches).sort((a, b) => b[1] - a[1])[0] || [];
    if (best && n >= Math.max(5, r.sample * 0.1)) return { chat: best, why: `ya tenía ${Math.round(100 * n / r.sample)}% de estos mensajes` };
  } catch {}
  const g = group || fileName;
  if (/grupo\s*2|noche/i.test(g)) return { chat: 'noche', why: 'por el nombre: ' + g };
  if (/grupo\s*1|d[ií]a|ma[ñn]ana/i.test(g)) return { chat: 'dia', why: 'por el nombre: ' + g };
  return { chat: null, why: '' };
}

export async function renderDatos(view) {
  let summary = [], snap = null, authError = '';
  if (getToken()) {
    try { [summary, snap] = await Promise.all([api('messages.php?summary=1'), loadSnapshot(true)]); }
    catch (e) { if (e.status === 401) authError = 'La clave guardada no es correcta.'; else throw e; }
  }
  const total = summary.reduce((a, r) => a + +r.n, 0);
  const push = await pushStatus().catch(() => 'no-soportado');

  view.innerHTML = `
    <section class="card">
      <h2>Subir chat</h2>
      <p class="sub">Exporta el chat de WhatsApp <b>sin archivos</b> y sube el <b>.txt</b> completo. Los mensajes que ya estaban se ignoran solos, así que no hace falta recortar días.</p>
      <div style="display:grid;gap:10px">
        <input type="file" id="file" accept=".txt,text/plain">
        <label class="field" id="chatField">Chat (se detecta solo; cámbialo solo si está mal)
          <select id="chat"><option value="dia">Grupo de día</option><option value="noche">Grupo de noche</option></select></label>
        <div id="preview" class="sub"></div>
        <div class="progress" id="prog" hidden><div></div></div>
        <button class="btn primary" id="upload" disabled>Subir y procesar</button>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Base de datos</h2><span class="sub">${total.toLocaleString()} mensajes</span></div>
      ${summary.length ? `<table><tr><th>Chat</th><th>Mensajes</th><th>Desde</th><th>Hasta</th></tr>
        ${summary.map(r => `<tr><td>${esc(r.chat)}</td><td>${(+r.n).toLocaleString()}</td><td>${esc(r.first.slice(0, 10))}</td><td>${esc(r.last.slice(0, 16))}</td></tr>`).join('')}</table>
      <p class="small muted">“Hasta” = último mensaje subido de cada chat. Los cálculos de cada horario llegan solo hasta ahí: los días sin subir no cuentan como que los clientes dejaron de llamar.</p>`
        : '<p class="sub">Vacía. Sube el primer chat.</p>'}
      <div class="hr"></div>
      <p class="sub">${snap ? `Último análisis: ${new Date(snap.generatedAt).toLocaleString('es-PE')} · lógica v${snap.version}${snap.version !== LOGIC_VERSION ? ` <span class="pill warn">hay lógica nueva v${LOGIC_VERSION}: reprocesa</span>` : ''}` : 'Sin análisis todavía.'}</p>
      <div class="row">
        <button class="btn primary" id="process" ${total ? '' : 'disabled'}>Procesar todo desde cero</button>
        <span class="sub" id="procMsg"></span>
      </div>
    </section>

    <section class="card">
      <h2>Zonas</h2>
      <p class="sub">Crea las ${SEED_ZONES.length} zonas más mencionadas en el chat (Llamosas, Pampa, Aguadita…). Luego dibuja cada una en <a href="#/zonas">Zonas</a>. Las que ya existan no se duplican.</p>
      <button class="btn" id="seed">Crear zonas sugeridas</button>
    </section>

    <section class="card">
      <h2>Avisos en este celular</h2>
      <p class="sub">Estado: <b>${{ activo: 'activados', inactivo: 'desactivados', bloqueado: 'bloqueados en el navegador', 'sin-https': 'necesitan https', 'no-soportado': 'no soportados aquí' }[push]}</b></p>
      <div class="row">
        ${push === 'inactivo' ? '<button class="btn primary" id="pushOn">Activar avisos</button>' : ''}
        ${push === 'activo' ? '<button class="btn" id="pushTest">Enviar aviso de prueba</button>' : ''}
      </div>
    </section>

    <section class="card">
      <h2>Clave de acceso</h2>
      ${authError ? `<p class="pill bad">${esc(authError)}</p>` : ''}
      <div class="row"><input class="grow" type="password" id="token" value="${esc(getToken())}" placeholder="Clave de api/config.php"><button class="btn" id="saveToken">Guardar</button></div>
    </section>

    <section class="card">
      <details><summary class="danger">Borrar datos</summary>
        <p class="sub">Borra los mensajes guardados de un chat (por ejemplo, para volver a subirlo desde cero). Las zonas no se tocan.</p>
        <div class="row">${summary.map(r => `<button class="btn danger sm" data-del="${esc(r.chat)}">Borrar "${esc(r.chat)}"</button>`).join('')}</div>
      </details>
    </section>`;

  let parsed = null;
  const prog = $('#prog'), bar = prog.firstElementChild;
  $('#file').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    const raw = await f.text();
    parsed = parseWhatsApp(raw);
    if (!parsed.length) {
      $('#preview').innerHTML = '<span class="pill bad">No se reconoció el formato. ¿Es el .txt exportado de WhatsApp?</span>';
      $('#upload').disabled = true;
      return;
    }
    const det = await detectChat(f.name, raw, parsed);
    if (det.chat) $('#chat').value = det.chat;
    $('#preview').innerHTML = `${parsed.length.toLocaleString()} mensajes · del ${parsed[0].ts.slice(0, 16)} al ${parsed[parsed.length - 1].ts.slice(0, 16)}<br>`
      + (det.chat ? `<span class="pill good">${det.chat === 'dia' ? 'Grupo de día' : 'Grupo de noche'}</span> <span class="small">${esc(det.why)}</span>`
        : '<span class="pill warn">No pude saber qué chat es: elígelo abajo</span>');
    $('#upload').disabled = false;
  };

  $('#upload').onclick = async e => {
    const btn = e.target;
    btn.disabled = true;
    prog.hidden = false;
    const chat = $('#chat').value;
    let added = 0;
    try {
      for (let i = 0; i < parsed.length; i += BATCH) {
        const part = parsed.slice(i, i + BATCH).map(m => [m.ts, m.sender, m.text, m.n]);
        const r = await api('messages.php', { method: 'POST', body: { chat, messages: part } });
        added += r.added;
        bar.style.width = Math.round(((i + part.length) / parsed.length) * 100) + '%';
        $('#preview').textContent = `Subiendo… ${(i + part.length).toLocaleString()} / ${parsed.length.toLocaleString()} (${added.toLocaleString()} nuevos)`;
      }
      toast(`${added.toLocaleString()} mensajes nuevos`);
      if (added) await runProcess(msg => ($('#preview').textContent = msg));
      renderDatos(view);
    } catch (err) {
      toast(err.message, 5000);
      btn.disabled = false;
    }
  };

  $('#process').onclick = async e => {
    e.target.disabled = true;
    const t0 = performance.now();
    try {
      const s = await runProcess(msg => ($('#procMsg').textContent = msg));
      toast(`Listo: ${s.summary.services.toLocaleString()} servicios, ${s.patterns.length} hábitos (${num((performance.now() - t0) / 1000, 1)} s)`, 4000);
      renderDatos(view);
    } catch (err) { toast(err.message, 5000); e.target.disabled = false; }
  };

  $('#seed').onclick = async e => {
    e.target.disabled = true;
    const existing = new Set((await api('zones.php')).map(z => z.name.toLowerCase()));
    let n = 0;
    for (const [name, aliases] of SEED_ZONES) {
      if (existing.has(name.toLowerCase())) continue;
      await api('zones.php', { method: 'POST', body: { name, aliases } });
      n++;
    }
    toast(n ? `${n} zonas creadas` : 'Ya estaban creadas');
    e.target.disabled = false;
  };

  const pOn = $('#pushOn');
  if (pOn) pOn.onclick = async () => { try { await enablePush(); toast('Avisos activados ✅'); renderDatos(view); } catch (err) { toast(err.message, 4000); } };
  const pTest = $('#pushTest');
  if (pTest) pTest.onclick = async () => { try { const r = await testPush(); toast(r.sent ? 'Aviso enviado' : 'No llegó a ningún celular'); } catch (err) { toast(err.message, 5000); } };

  $('#saveToken').onclick = () => { setToken($('#token').value.trim()); state.snap = null; toast('Clave guardada'); renderDatos(view); };

  view.querySelectorAll('[data-del]').forEach(b => (b.onclick = async () => {
    if (!confirm(`¿Borrar todos los mensajes del chat "${b.dataset.del}"? Luego tendrás que volver a subirlo.`)) return;
    await api('messages.php?chat=' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
    toast('Borrado');
    renderDatos(view);
  }));
}
