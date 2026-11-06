// Convierte el .txt exportado de WhatsApp en una lista de mensajes.
// Formatos soportados:
//   [6/15/26, 12:29:37 PM] Nombre: texto          (iPhone)
//   15/6/26, 12:29 p. m. - Nombre: texto            (Android)

const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g;
const LINE = /^\[?(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?\s?m\.?)?\]?\s*(-\s*)?(.*)$/i;

const pad = n => String(n).padStart(2, '0');

export function parseWhatsApp(raw) {
  const lines = raw.replace(INVISIBLE, '').replace(/ | /g, ' ').split(/\r?\n/);

  // ¿Fecha como mes/día o día/mes? Se decide mirando todo el archivo.
  let firstOver12 = 0, secondOver12 = 0;
  for (const l of lines) {
    const m = l.match(LINE);
    if (!m) continue;
    if (+m[1] > 12) firstOver12++;
    if (+m[2] > 12) secondOver12++;
  }
  const dayFirst = firstOver12 > secondOver12;

  const out = [];
  let last = null;
  for (const line of lines) {
    const m = line.match(LINE);
    if (!m) {
      if (last && line.trim()) last.text += '\n' + line;
      continue;
    }
    let [, a, b, y, h, mi, s, ampm, dash, rest] = m;
    const month = dayFirst ? +b : +a;
    const day = dayFirst ? +a : +b;
    let year = +y;
    if (year < 100) year += 2000;
    let hour = +h;
    if (ampm) {
      const pm = /p/i.test(ampm);
      hour = (hour % 12) + (pm ? 12 : 0);
    }
    const sep = rest.indexOf(': ');
    // Mensajes del sistema ("X añadió a Y", "cambió los ajustes") no tienen "Nombre: "
    // o vienen con " - " delante en el formato iPhone.
    const isSystem = sep < 0 || (dash && line.startsWith('['));
    if (isSystem) { last = null; continue; }
    const ts = `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(mi)}:${pad(s || 0)}`;
    last = { ts, sender: rest.slice(0, sep).trim(), text: rest.slice(sep + 2) };
    out.push(last);
  }

  // n = cuántas veces se repitió el mismo mensaje en el mismo segundo (para no confundirlo con un duplicado).
  const seen = new Map();
  for (const msg of out) {
    msg.text = msg.text.trim();
    const k = msg.ts + '|' + msg.sender + '|' + msg.text;
    const n = seen.get(k) || 0;
    seen.set(k, n + 1);
    msg.n = n;
  }
  return out;
}
