// Casas de los clientes (punto exacto de recojo). Se guardan en el servidor;
// en el celular queda una copia para verlas sin señal.
import { api } from './api.js';

const KEY = 'taxi_homes';
let cache = null;

export async function loadHomes(force = false) {
  if (cache && !force) return cache;
  try {
    const rows = await api('homes.php');
    cache = new Map(rows.map(r => [r.phone, r]));
    try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch {}
  } catch {
    let rows = [];
    try { rows = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch {}
    cache = new Map(rows.map(r => [r.phone, r]));
  }
  return cache;
}

export async function saveHome(phone, lat, lng, acc = null, note = '') {
  await api('homes.php', { method: 'POST', body: { phone, lat, lng, acc, note } });
  return loadHomes(true);
}

// ---------- apodos ----------
const NKEY = 'taxi_names';
let names = null;
export async function loadNames(force = false) {
  if (names && !force) return names;
  try {
    const rows = await api('names.php');
    names = new Map(rows.map(r => [r.phone, r.name]));
    try { localStorage.setItem(NKEY, JSON.stringify(rows)); } catch {}
  } catch {
    let rows = [];
    try { rows = JSON.parse(localStorage.getItem(NKEY) || '[]'); } catch {}
    names = new Map(rows.map(r => [r.phone, r.name]));
  }
  return names;
}
export async function saveName(phone, name) {
  await api('names.php', { method: 'POST', body: { phone, name } });
  return loadNames(true);
}

export async function deleteHome(phone) {
  await api('homes.php?phone=' + encodeURIComponent(phone), { method: 'DELETE' });
  return loadHomes(true);
}
