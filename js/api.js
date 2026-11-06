// Comunicación con el servidor (carpeta api/).
const BASE = new URL('../api/', import.meta.url).href;
const KEY = 'taxi_token';

export const getToken = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
export const setToken = t => { try { localStorage.setItem(KEY, t); } catch {} };

export async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'X-Token': getToken(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
    cache: 'no-store',
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function fetchAllMessages(onProgress) {
  const all = [];
  let after = 0;
  for (;;) {
    const page = await api(`messages.php?after=${after}&limit=20000`);
    if (!page.length) break;
    all.push(...page);
    after = page[page.length - 1][0];
    onProgress && onProgress(all.length);
    if (page.length < 20000) break;
  }
  return all;
}
