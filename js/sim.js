// Simulador de espera: "¿qué habría pasado si mi taxi hubiera estado libre en el punto X?"
//
// 1) Cercanías aprendidas del chat. La central asigna el pedido al punto libre más cercano
//    (y ahí, al primero de la fila). En cada pedido confirmado se sabe dónde dijo estar libre
//    cada taxista y desde qué punto salió el ganador. Con eso se aprende, además de la distancia
//    del mapa, una corrección por punto ("agencia Llamosas tiene una recta a La Pampa").
//    Donde no hay datos, manda la distancia del mapa.
// 2) Simulación: en cada pedido pasado se pone mi taxi en X junto con los taxistas que estaban
//    libres en ese momento, y se calcula la probabilidad de que me lo hubieran dado.
//    Así se compara cualquier punto, incluso uno donde nadie suele esperar.

const T = globalThis.__SIM || {}; // solo para pruebas
const LIBRE_MIN = T.libreMin ?? 10;   // un "libre" vale 10 min (o hasta que consiga servicio o diga ocupado); probado: 10 acierta más que 20
const ITERS = 250;      // pasadas de aprendizaje
const REG_B = T.regB ?? 1;        // cuánto cuesta que un punto tenga corrección propia (más = más prudente)
const REG_C = T.regC ?? 3;        // ídem para la corrección de un par (pedido en A, espera en L)

function km(a, b) {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLat = r(b[0] - a[0]), dLng = r(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) * 1.3; // por calle ≈ línea recta × 1.3
}
function pointOf(z) {
  if (!z) return null;
  if (z.lat != null && z.lng != null) return [z.lat, z.lng];
  if (z.polygon && z.polygon.length) {
    let a = 0, b = 0;
    for (const [x, y] of z.polygon) { a += x; b += y; }
    return [a / z.polygon.length, b / z.polygon.length];
  }
  return null;
}
const uniq = a => [...new Set(a)];

// calls: pedidos (con zone, spot, driver, confirmT, cancelled, t, h, chat, date)
// libres: reportes "libre" (sender, chat, t, zone, spot); ocupados: {sender, chat, t}
// senderName: remitente → nombre de taxista; covered: Set('fecha|hora')
export function simulate({ calls, libres, ocupados, senderName, zones, covered, bands }) {
  const pt = new Map();
  for (const z of zones) { const p = pointOf(z); if (p) pt.set(z.id, p); }
  const locOf = x => (x.spot >= 0 ? x.spot : x.zone);
  const bandOf = h => bands.findIndex(([a, b]) => h >= a && h < b);
  const nameSenders = new Map();
  for (const [s, n] of senderName) { if (!nameSenders.has(n)) nameSenders.set(n, []); nameSenders.get(n).push(s); }

  // ---- quién estaba libre y dónde, en el momento de cada pedido ----
  const ev = [];
  for (const l of libres) { const loc = locOf(l); if (loc >= 0) ev.push({ t: l.t, k: 0, chat: l.chat, sender: l.sender, loc }); }
  for (const o of ocupados) ev.push({ t: o.t, k: 1, chat: o.chat, sender: o.sender });
  for (const c of calls) {
    if (!c.driver || c.confirmT == null) continue;
    for (const s of nameSenders.get(c.driver) || []) ev.push({ t: c.confirmT, k: 1, chat: c.chat, sender: s });
  }
  for (const c of calls) if (c.driver && !c.cancelled && locOf(c) >= 0) ev.push({ t: c.t, k: 2, chat: c.chat, c });
  ev.sort((a, b) => a.t - b.t || a.k - b.k);
  const state = new Map(); // chat → Map(sender → {loc, t})
  const samples = [];
  for (const e of ev) {
    if (!state.has(e.chat)) state.set(e.chat, new Map());
    const st = state.get(e.chat);
    if (e.k === 0) { st.set(e.sender, { loc: e.loc, t: e.t }); continue; }
    if (e.k === 1) { st.delete(e.sender); continue; }
    const c = e.c;
    const winners = new Set(nameSenders.get(c.driver) || []);
    let winLoc = -1;
    const comps = [];
    for (const [s, v] of st) {
      if (c.t - v.t > LIBRE_MIN) continue;
      if (winners.has(s)) winLoc = v.loc; else comps.push(v.loc);
    }
    if (winLoc < 0) continue; // no sabemos desde dónde salió el ganador
    samples.push({ A: locOf(c), h: c.h, date: c.date, b: bandOf(c.h), win: winLoc, comps });
  }

  // ---- cercanías: puntaje(A, L) = −β·distancia + corrección del punto L + corrección del par (A, L) ----
  // La central elige el punto con mayor puntaje (probabilidad ∝ e^puntaje). Se aprende con el chat.
  const dist = (A, L) => { if (A === L) return 0; const a = pt.get(A), b = pt.get(L); return a && b ? km(a, b) : null; };
  const P = { beta: 1, miss: 0, b: new Map(), c: new Map() };
  const pk = (A, L) => A + '|' + L;
  const score = (A, L) => {
    const d = dist(A, L);
    return (d == null ? P.miss : -P.beta * d) + (P.b.get(L) || 0) + (P.c.get(pk(A, L)) || 0);
  };
  const fit = samples.map(s => ({ A: s.A, win: s.win, Ls: uniq([s.win, ...s.comps]) })).filter(s => s.Ls.length >= 2);
  const G2 = new Map(); // AdaGrad
  const step = (k, g, lr = 0.3) => { const s = (G2.get(k) || 1e-8) + g * g; G2.set(k, s); return lr * g / Math.sqrt(s); };
  for (let it = 0; it < ITERS && fit.length; it++) {
    let gBeta = 0, gMiss = 0;
    const gB = new Map(), gC = new Map();
    for (const s of fit) {
      const sc = s.Ls.map(L => score(s.A, L));
      const mx = Math.max(...sc);
      const ex = sc.map(v => Math.exp(v - mx)), Z = ex.reduce((a, x) => a + x, 0);
      s.Ls.forEach((L, i) => {
        const r = (L === s.win ? 1 : 0) - ex[i] / Z; // observado − esperado
        const d = dist(s.A, L);
        if (d == null) gMiss += r; else gBeta += -d * r;
        gB.set(L, (gB.get(L) || 0) + r);
        gC.set(pk(s.A, L), (gC.get(pk(s.A, L)) || 0) + r);
      });
    }
    P.beta = Math.max(0.1, P.beta + step('beta', gBeta / fit.length * 50));
    P.miss += step('miss', gMiss / fit.length * 50);
    for (const [L, g] of gB) P.b.set(L, (P.b.get(L) || 0) + step('b' + L, g - REG_B * (P.b.get(L) || 0)));
    for (const [k, g] of gC) P.c.set(k, (P.c.get(k) || 0) + step('c' + k, g - REG_C * (P.c.get(k) || 0)));
  }

  // Probabilidad de que la central elija el punto P frente a los puntos con taxis libres (y mi turno en la fila).
  const myChance = (s, Pt) => {
    const Ls = uniq([Pt, s.win, ...s.comps]);
    const sc = Ls.map(L => score(s.A, L)), mx = Math.max(...sc);
    const ex = sc.map(v => Math.exp(v - mx)), Z = ex.reduce((a, x) => a + x, 0);
    const q = (s.win === Pt ? 1 : 0) + s.comps.filter(L => L === Pt).length; // taxis delante de mí en P
    return (ex[0] / Z) / (q + 1);
  };

  // ---- simulación: mi taxi libre en cada punto del mapa ----
  const presByLoc = new Map();
  for (const s of samples) for (const L of [s.win, ...s.comps]) presByLoc.set(L, (presByLoc.get(L) || 0) + 1);
  const cands = [...pt.keys()];
  const nB = bands.length;
  const callsB = Array(nB).fill(0), covB = Array(nB).fill(0), sampB = Array(nB).fill(0);
  for (const c of calls) if (!c.cancelled) callsB[bandOf(c.h)]++;
  for (const k of covered) covB[bandOf(+k.split('|')[1])]++;
  for (const s of samples) sampB[s.b]++;
  const spots = cands.map(Pt => {
    const got = Array(nB).fill(0);
    const byA = new Map();
    for (const s of samples) {
      const p = myChance(s, Pt);
      got[s.b] += p;
      byA.set(s.A, (byA.get(s.A) || 0) + p);
    }
    // Servicios por hora que conseguiría estando libre ahí.
    const perHour = got.map((g, b) => (sampB[b] ? g / sampB[b] : 0) * (covB[b] ? callsB[b] / covB[b] : 0));
    const total = got.reduce((a, x) => a + x, 0);
    const top = [...byA].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([A, g]) => [A, +(g / (total || 1)).toFixed(2)]);
    return { loc: Pt, pres: presByLoc.get(Pt) || 0, perHour: perHour.map(x => +x.toFixed(2)), top };
  }).filter(s => s.perHour.some(x => x > 0));
  spots.sort((a, b) => b.perHour.reduce((x, y) => x + y, 0) - a.perHour.reduce((x, y) => x + y, 0) || a.loc - b.loc);

  // Para cada lugar de pedido: desde qué puntos se llega primero (los 4 mejores).
  const pickN = new Map();
  for (const s of samples) pickN.set(s.A, (pickN.get(s.A) || 0) + 1);
  const nearFor = {};
  for (const [A, n] of pickN) {
    if (n < 10) continue;
    nearFor[A] = cands.map(L => [L, score(A, L)]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([L]) => L);
  }
  // Modelo compacto para simular en el celular cualquier punto que toques en el mapa.
  const r3 = v => Math.round(v * 1000) / 1000;
  const model = {
    beta: r3(P.beta), miss: r3(P.miss),
    b: [...P.b].filter(([, v]) => Math.abs(v) > 0.01).map(([L, v]) => [L, r3(v)]),
    c: [...P.c].filter(([, v]) => Math.abs(v) > 0.02).map(([k, v]) => [...k.split('|').map(Number), r3(v)]),
    samples: samples.map(s => [s.A, s.b, s.win, ...s.comps]),
    callsB, covB, sampB,
  };
  return {
    bands, samples: samples.length, fitted: fit.length, beta: +P.beta.toFixed(2),
    spots, nearFor, model, _score: score, _samples: samples, _myChance: myChance,
  };
}

// Combina lo real (esperas "libre" del chat, incluye clientes al paso) con lo simulado
// (solo ve pedidos de la central, por eso se ajusta a la escala real con los puntos de muchos datos).
export function blendWait({ real, sim, nB, global, W = 60, W0 = 120 }) {
  const simBy = new Map(sim.spots.map(s => [s.loc, s]));
  const realBy = new Map(real.map(r => [r.zone, r]));
  const k = Array.from({ length: nB }, (_, b) => {
    const r = real.filter(x => x.n >= 100 && simBy.get(x.zone)?.perHour[b] > 0)
      .map(x => x.bands[b] / simBy.get(x.zone).perHour[b]).sort((a, c) => a - c);
    return r.length ? r[Math.floor(r.length / 2)] : 1;
  });
  sim.model.scale = k.map(v => Math.round(v * 1000) / 1000);
  const ids = new Set([...real.filter(r => simBy.has(r.zone) || r.n >= 100).map(r => r.zone), ...sim.spots.map(s => s.loc)]);
  return [...ids].map(id => {
    const r = realBy.get(id), s = simBy.get(id);
    const bands = Array.from({ length: nB }, (_, b) => {
      const sv = s ? k[b] * s.perHour[b] : null, rn = r ? r.bandN[b] : 0;
      if (sv == null) return r.bands[b];
      // Sin esperas reales suficientes, lo simulado se acerca al promedio de Chala (W0):
      // el simulador acierta solo en parte, así que un punto sin probar no puede quedar primero por sí solo.
      const g = global[b] || sv, w0 = Math.max(0, W0 - 4 * (r ? r.n : 0));
      return ((r ? rn * r.bands[b] : 0) + W * sv + w0 * g) / (rn + W + w0);
    }).map(v => +v.toFixed(2));
    const rate = +(bands.reduce((a, x) => a + x, 0) / nB).toFixed(2);
    return { zone: id, n: r ? r.n : 0, paso: r ? r.paso : 0, rate, bands, bandN: r ? r.bandN : Array(nB).fill(0), est: !r || r.n < 30, top: s ? s.top : [] };
  }).filter(x => x.bands.every(v => v > 0)).sort((a, b) => b.rate - a.rate || a.zone - b.zone);
}
