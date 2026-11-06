// Suscribir este celular a los avisos.
import { api } from './api.js';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyToBytes(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}

export async function pushStatus() {
  if (!pushSupported()) return 'no-soportado';
  if (!window.isSecureContext) return 'sin-https';
  if (Notification.permission === 'denied') return 'bloqueado';
  // getRegistration no se queda esperando si el service worker aún no está listo.
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && reg.active ? await reg.pushManager.getSubscription() : null;
  return sub ? 'activo' : 'inactivo';
}

function swReady(ms = 8000) {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, bad) => setTimeout(() => bad(new Error('La app aún no terminó de instalarse. Recarga e intenta de nuevo.')), ms)),
  ]);
}

export async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('No diste permiso para notificaciones');
  const { publicKey } = await api('push.php');
  if (!publicKey) throw new Error('El servidor no tiene claves VAPID (php api/setup.php)');
  const reg = await swReady();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) });
  await api('push.php', { method: 'POST', body: sub.toJSON() });
}

export const testPush = () => api('push.php?test=1', { method: 'POST', body: {} });
