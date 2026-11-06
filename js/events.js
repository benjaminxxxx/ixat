// Eventos programados y feriados: cuándo ocurren y qué horas cubren.
// Un evento: { id, name, date: 'YYYY-MM-DD', from_min, to_min, zone_id, yearly, note }.
// Si to_min <= from_min, el evento cruza la medianoche (ej. 20:00 → 03:00).

const pad = n => String(n).padStart(2, '0');
const iso = d => d.toISOString().slice(0, 10);
const addDaysIso = (date, n) => iso(new Date(Date.parse(date + 'T00:00:00Z') + n * 864e5));

// Fechas en que ocurre entre from y to (incluidas). Los anuales se repiten cada año en el mismo día.
export function occurrences(ev, from, to) {
  if (!ev.yearly) return ev.date >= from && ev.date <= to ? [ev.date] : [];
  const md = ev.date.slice(5);
  const out = [];
  for (let y = +from.slice(0, 4); y <= +to.slice(0, 4); y++) {
    const d = `${y}-${md}`;
    if (iso(new Date(d + 'T00:00:00Z')) !== d) continue; // 29 de febrero en año no bisiesto
    if (d >= from && d <= to) out.push(d);
  }
  return out;
}

// Horas (fecha + hora) que cubre una ocurrencia.
export function slots(ev, date) {
  const end = ev.to_min > ev.from_min ? ev.to_min : ev.to_min + 1440;
  const out = [];
  for (let m = Math.floor(ev.from_min / 60) * 60; m < end; m += 60) {
    out.push({ date: m >= 1440 ? addDaysIso(date, 1) : date, h: Math.floor(m / 60) % 24 });
  }
  return out;
}

export const minToTime = m => pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60);
export const timeToMin = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

// Domingo de Pascua (algoritmo de Meeus).
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${pad(month)}-${pad(day)}`;
}
// n-ésimo domingo de un mes.
function nthSunday(y, month, n) {
  const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
  return `${y}-${pad(month)}-${pad(1 + ((7 - first) % 7) + (n - 1) * 7)}`;
}

// Feriados y fechas con movimiento en Perú. Los de fecha fija se guardan como anuales;
// los que cambian de fecha (Semana Santa, Día de la Madre/Padre) se crean para el año indicado.
export function peruHolidays(year) {
  const fixed = [
    ['Año Nuevo', '01-01', 0, 360],
    ['Día del Trabajo', '05-01', 600, 1380],
    ['Batalla de Arica y Día de la Bandera', '06-07', 600, 1380],
    ['San Pedro y San Pablo', '06-29', 600, 1380],
    ['Fiestas Patrias', '07-28', 600, 180],
    ['Fiestas Patrias (2.º día)', '07-29', 600, 1380],
    ['Batalla de Junín', '08-06', 600, 1380],
    ['Santa Rosa de Lima', '08-30', 600, 1380],
    ['Combate de Angamos', '10-08', 600, 1380],
    ['Halloween / Día de la Canción Criolla', '10-31', 1080, 180],
    ['Todos los Santos', '11-01', 480, 1260],
    ['Inmaculada Concepción', '12-08', 600, 1380],
    ['Batalla de Ayacucho', '12-09', 600, 1380],
    ['Nochebuena', '12-24', 1080, 240],
    ['Navidad', '12-25', 600, 1380],
    ['Año Nuevo (víspera)', '12-31', 1080, 360],
  ].map(([name, md, from, to]) => ({ name, date: `${year}-${md}`, from_min: from, to_min: to, yearly: 1, note: 'feriado' }));
  const e = easter(year);
  const moving = [
    ['Jueves Santo', addDaysIso(e, -3)],
    ['Viernes Santo', addDaysIso(e, -2)],
    ['Día de la Madre', nthSunday(year, 5, 2)],
    ['Día del Padre', nthSunday(year, 6, 3)],
  ].map(([name, date]) => ({ name, date, from_min: 600, to_min: 1380, yearly: 0, note: 'feriado' }));
  return [...fixed, ...moving];
}
