// Corre el procesador fuera de la pantalla para que no se congele.
import { processAll } from './processor.js';

self.onmessage = e => {
  try {
    const { messages, zones, events } = e.data;
    self.postMessage({ ok: true, snap: processAll(messages, zones, undefined, { events: events || [] }) });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.stack || err) });
  }
};
