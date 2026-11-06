import { api, getToken, setToken } from './api.js';
import { $, $$, limaNow, hhmm, esc } from './util.js';
import { renderAhora } from './views/ahora.js';
import { renderAnalisis } from './views/analisis.js';
import { renderClientes, renderCliente } from './views/clientes.js';
import { renderZonas } from './views/zonas.js';
import { renderDatos } from './views/datos.js';
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
  } catch (e) {
    if (e.status === 401) return askToken(view, 'La clave no es correcta.');
    view.innerHTML = `<div class="card empty"><b>No se pudo cargar</b>${esc(e.message)}</div>`;
  }
  window.scrollTo(0, 0);
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
