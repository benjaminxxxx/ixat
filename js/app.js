import { api, getToken, setToken } from './api.js';
import { $, $$, limaNow, hhmm, esc, toast } from './util.js';
import { renderAhora } from './views/ahora.js';
import { renderAnalisis } from './views/analisis.js';
import { renderClientes, renderCliente } from './views/clientes.js';
import { renderZonas } from './views/zonas.js';
import { renderDatos, runProcess } from './views/datos.js';
import { renderEventos } from './views/eventos.js';

// Estado compartido por todas las pantallas.
export const state = { snap: null, loading: null };

export async function loadSnapshot(force = false) {
  if (state.snap && !force) return state.snap;
  if (!state.loading || force) {
    state.loading = api('snapshot.php').then(s => (state.snap = s)).finally(() => (state.loading = null));
  }
  return state.loading;
}

let cleanup = null;
async function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'ahora';
  const [tab, arg] = hash.split('/');
  $$('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === (tab === 'cliente' ? 'clientes' : tab === 'eventos' ? 'analisis' : tab)));
  const view = $('#view');
  if (cleanup) { cleanup(); cleanup = null; }
  $('#tip').hidden = true;

  if (!getToken() && tab !== 'datos') return askToken(view);
  try {
    const renderers = { ahora: renderAhora, analisis: renderAnalisis, clientes: renderClientes, cliente: renderCliente, zonas: renderZonas, datos: renderDatos, eventos: renderEventos };
    const fn = renderers[tab] || renderAhora;
    cleanup = (await fn(view, arg && decodeURIComponent(arg))) || null;
    if (tab !== 'datos') checkStale(view);
  } catch (e) {
    if (e.status === 401) return askToken(view, 'La clave no es correcta.');
    view.innerHTML = `<div class="card empty"><b>No se pudo cargar</b>${esc(e.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

// Si cambiaron zonas, lugares, eventos o llegaron mensajes después del último análisis, avisar y recalcular.
let reprocessing = null;
export function reprocess() {
  if (!reprocessing) {
    toast('Actualizando análisis con tus cambios…', 4000);
    reprocessing = runProcess().then(() => { toast('Análisis actualizado ✅'); route(); })
      .catch(e => toast('No se pudo actualizar: ' + e.message, 6000))
      .finally(() => (reprocessing = null));
  }
  return reprocessing;
}
async function checkStale(view) {
  let st;
  try { st = await api('stamp.php'); } catch { return; }
  if (!st.stale || !view.isConnected || $('#staleBanner')) return;
  const el = document.createElement('section');
  el.className = 'card row';
  el.id = 'staleBanner';
  el.innerHTML = '<div class="grow sub">Hiciste cambios (zonas, lugares, eventos o chats) después del último análisis. Las sugerencias aún no los incluyen.</div><button class="btn primary">Recalcular ahora</button>';
  el.querySelector('button').onclick = e => { e.target.disabled = true; e.target.textContent = 'Recalculando…'; reprocess(); };
  view.prepend(el);
  if (reprocessing) { el.querySelector('button').disabled = true; el.querySelector('button').textContent = 'Recalculando…'; }
}

function askToken(view, error = '') {
  view.innerHTML = `
    <form class="card" id="tokenForm">
      <h2>Clave de acceso</h2>
      <p class="sub">Está en <span class="mono">api/config.php</span> (campo <b>token</b>). Se pide una sola vez en cada dispositivo.</p>
      ${error ? `<p class="pill bad">${esc(error)}</p>` : ''}
      <div class="row"><input class="grow" type="password" name="t" autocomplete="current-password" placeholder="Clave" required><button class="btn primary">Entrar</button></div>
    </form>`;
  $('#tokenForm').onsubmit = e => {
    e.preventDefault();
    setToken(new FormData(e.target).get('t').trim());
    state.snap = null;
    route();
  };
}

function tickClock() {
  const n = limaNow();
  const night = n.h >= 22 || n.h < 6;
  $('#clock').innerHTML = `${hhmm(n.mod)}<small>${night ? 'Tarifa noche S/ 10' : 'Tarifa S/ 8'}</small>`;
}

// Abrir con ?k=<clave> la guarda en este dispositivo y la quita de la dirección.
const urlKey = new URLSearchParams(location.search).get('k');
if (urlKey) {
  setToken(urlKey);
  history.replaceState(null, '', location.pathname + location.hash);
}

window.addEventListener('hashchange', route);
tickClock();
setInterval(tickClock, 15000);
route();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
