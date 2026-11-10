// Service worker: abre la app sin señal, guarda el último análisis y muestra los avisos.
const VERSION = 'v13';
const SHELL = `shell-${VERSION}`;
const RUNTIME = 'runtime';
const FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon-192.png',
  'js/app.js', 'js/api.js', 'js/util.js', 'js/push.js', 'js/parser.js', 'js/processor.js', 'js/worker.js', 'js/seedZones.js', 'js/naming.js', 'js/homes.js', 'js/events.js',
  'js/views/common.js', 'js/views/ahora.js', 'js/views/analisis.js', 'js/views/clientes.js', 'js/views/zonas.js', 'js/views/datos.js', 'js/views/eventos.js', 'js/views/wait.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // El análisis: primero red, si no hay señal el último guardado.
  if (url.pathname.endsWith('/api/snapshot.php')) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(RUNTIME).then(c => c.put(url.pathname, copy)); }
      return res;
    }).catch(() => caches.match(url.pathname)));
    return;
  }
  if (url.pathname.includes('/api/')) return;

  const sameOrigin = url.origin === location.origin;
  const isLib = url.hostname === 'unpkg.com';
  if (!sameOrigin && !isLib) return; // mosaicos del mapa: directo a la red

  // Librerías del mapa (versión fija): desde caché.
  if (isLib) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(RUNTIME).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  // Archivos de la app: versión nueva si hay señal (máx. 3 s), si no la guardada.
  e.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    // no-cache: siempre preguntar al servidor si hay versión nueva (evita mezclar archivos viejos y nuevos).
    const net = fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
      return res;
    });
    if (!cached) return net;
    const timeout = new Promise(ok => setTimeout(() => ok(cached), 3000));
    return Promise.race([net.catch(() => cached), timeout]);
  })());
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'Taxi Radar', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Taxi Radar', {
    body: d.body || '',
    tag: d.tag,
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 400],
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL(e.notification.data.url || './', self.registration.scope).href;
  // Enlace externo (Google Maps a la casa del cliente): abrirlo aparte.
  if (!target.startsWith(self.registration.scope)) { e.waitUntil(self.clients.openWindow(target)); return; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope)) { c.navigate(target); return c.focus(); }
    return self.clients.openWindow(target);
  }));
});
