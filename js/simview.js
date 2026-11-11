// Simular en el celular cualquier punto del mapa con el modelo que guarda el análisis (ver js/sim.js).
import { placePoint } from './views/common.js';

function km(a, b) {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLat = r(b[0] - a[0]), dLng = r(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) * 1.3;
}

export function makeSimulator(sim, zones) {
  const m = sim.model;
  const pt = id => placePoint(zones.get(id));
  const b = new Map(m.b), c = new Map(m.c.map(([A, L, v]) => [A + '|' + L, v]));
  const score = (A, L, LPt) => {
    const a = pt(A), q = LPt || pt(L);
    const d = A === L ? 0 : a && q ? km(a, q) : null;
    return (d == null ? m.miss : -m.beta * d) + (L != null ? (b.get(L) || 0) + (c.get(A + '|' + L) || 0) : 0);
  };
  // Punto tocado: si está a menos de 40 m de un lugar o zona conocida, se usa ese (con su fila de taxis).
  const snapTo = ll => {
    let best = null, bd = 0.04;
    for (const z of zones.values()) { const p = placePoint(z); if (!p) continue; const d = km(p, ll) / 1.3; if (d < bd) { bd = d; best = z.id; } }
    return best;
  };
  return {
    // Minutos promedio hasta conseguir servicio esperando ahí, por franja, y qué pedidos ganaría.
    at(ll) {
      const id = snapTo(ll);
      const nB = m.callsB.length, got = Array(nB).fill(0), byA = new Map();
      for (const s of m.samples) {
        const [A, band, win, ...comps] = s;
        const Ls = [...new Set([win, ...comps])].filter(L => L !== id);
        const mine = score(A, id, id == null ? ll : null);
        const sc = Ls.map(L => score(A, L)), mx = Math.max(mine, ...sc);
        const Z = Math.exp(mine - mx) + sc.reduce((a, v) => a + Math.exp(v - mx), 0);
        const q = id == null ? 0 : [win, ...comps].filter(L => L === id).length;
        const p = Math.exp(mine - mx) / Z / (q + 1);
        got[band] += p;
        byA.set(A, (byA.get(A) || 0) + p);
      }
      const perHour = got.map((g, k) => (m.sampB[k] ? g / m.sampB[k] : 0) * (m.covB[k] ? m.callsB[k] / m.covB[k] : 0) * (m.scale ? m.scale[k] : 1));
      const total = got.reduce((a, x) => a + x, 0);
      const top = [...byA].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([A, g]) => [A, g / (total || 1)]);
      return { id, minutes: perHour.map(x => (x > 0 ? 60 / x : null)), top };
    },
  };
}
