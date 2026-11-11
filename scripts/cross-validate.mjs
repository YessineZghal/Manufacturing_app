// Model selection without the test set: grouped 5-fold cross-validation over the 100 FD001
// TRAINING engines. Each held-out engine is cut every 3 cycles where its true RUL is at most 150,
// like the truncated test trajectories, and scored against its uncapped true RUL.
//   npm run model:cv
// The test files are never read here. See ADR 0006 for the decision these numbers support.
import { readFileSync } from 'node:fs';

const SENSORS = [2, 3, 4, 7, 8, 9, 11, 12, 13, 14, 15, 17, 20, 21];
const units = new Map();
for (const line of readFileSync(
  new URL('../dataset/CMAPSS/train_FD001.txt', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n')) {
  const r = line.trim().split(/\s+/).map(Number);
  if (!units.has(r[0])) units.set(r[0], []);
  units.get(r[0]).push({ cycle: r[1], sensors: SENSORS.map(k => r[4 + k]) });
}

function windowStats(window) {
  const n = window.length,
    tMean = (n - 1) / 2;
  let tVar = 0;
  for (let t = 0; t < n; t++) tVar += (t - tMean) ** 2;
  const means = [],
    slopes = [];
  for (let k = 0; k < SENSORS.length; k++) {
    let sum = 0;
    for (const row of window) sum += row[k];
    const mean = sum / n;
    let cov = 0;
    for (let t = 0; t < n; t++) cov += (t - tMean) * (window[t][k] - mean);
    means.push(mean);
    slopes.push(tVar ? cov / tVar : 0);
  }
  return { means, slopes };
}
/** Feature sets: `base` is the shipped definition; `quad` adds squared standardised means. */
const FEATURES = {
  base: ({ means, slopes }, cycle) => [...means, ...slopes, cycle],
  quad: ({ means, slopes }, cycle, scale) => [
    ...means,
    ...slopes,
    cycle,
    ...means.map((v, k) => ((v - scale.mean[k]) / scale.std[k]) ** 2),
  ],
};

function solve(a, b) {
  const n = b.length,
    m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}
function fit(x, y, lambda) {
  const d = x[0].length;
  const mean = Array.from({ length: d }, (_, j) => x.reduce((s, r) => s + r[j], 0) / x.length);
  const std = mean.map(
    (mu, j) => Math.sqrt(x.reduce((s, r) => s + (r[j] - mu) ** 2, 0) / x.length) || 1,
  );
  const yMean = y.reduce((s, v) => s + v, 0) / y.length;
  const z = x.map(r => r.map((v, j) => (v - mean[j]) / std[j]));
  const xtx = Array.from({ length: d }, (_, i) =>
    Array.from({ length: d }, (_, j) => {
      let s = i === j ? lambda : 0;
      for (const r of z) s += r[i] * r[j];
      return s;
    }),
  );
  const xty = Array.from({ length: d }, (_, i) => {
    let s = 0;
    z.forEach((r, n) => (s += r[i] * (y[n] - yMean)));
    return s;
  });
  return { mean, std, weights: solve(xtx, xty), intercept: yMean };
}
const predict = (m, f, cap) => {
  let v = m.intercept;
  for (let j = 0; j < f.length; j++) v += m.weights[j] * ((f[j] - m.mean[j]) / m.std[j]);
  return Math.min(cap, Math.max(0, v));
};

function crossValidate({ window = 30, lambda = 1, cap = 125, features = 'base', fullOnly = true }) {
  const ids = [...units.keys()];
  let squared = 0,
    count = 0;
  for (let fold = 0; fold < 5; fold++) {
    const trainIds = ids.filter(u => u % 5 !== fold);
    const rows = trainIds.flatMap(u => units.get(u));
    const mean = SENSORS.map((_, k) => rows.reduce((s, r) => s + r.sensors[k], 0) / rows.length);
    const std = mean.map((mu, k) =>
      Math.sqrt(rows.reduce((s, r) => s + (r.sensors[k] - mu) ** 2, 0) / rows.length),
    );
    const featuresOf = (w, cycle) => FEATURES[features](windowStats(w), cycle, { mean, std });
    const x = [],
      y = [];
    for (const u of trainIds) {
      const rs = units.get(u);
      for (let i = fullOnly ? window - 1 : 0; i < rs.length; i++) {
        const w = rs.slice(Math.max(0, i - window + 1), i + 1).map(r => r.sensors);
        x.push(featuresOf(w, rs[i].cycle));
        y.push(Math.min(cap, rs.length - 1 - i));
      }
    }
    const model = fit(x, y, lambda);
    for (const u of ids.filter(id => id % 5 === fold)) {
      const rs = units.get(u);
      for (let i = 30; i < rs.length; i += 3) {
        const actual = rs.length - 1 - i;
        if (actual > 150) continue;
        const w = rs.slice(i - window + 1, i + 1).map(r => r.sensors);
        const e = predict(model, featuresOf(w, rs[i].cycle), cap) - actual;
        squared += e * e;
        count++;
      }
    }
  }
  return { rmse: Math.round(Math.sqrt(squared / count) * 100) / 100, cuts: count };
}

const CANDIDATES = [
  { name: 'v1: every cycle, partial windows included', fullOnly: false },
  { name: 'v2 (shipped): full 30-cycle windows only' },
  { name: 'cap 115', cap: 115 },
  { name: 'cap 120', cap: 120 },
  { name: 'cap 130', cap: 130 },
  { name: 'cap 135', cap: 135 },
  { name: 'window 20', window: 20 },
  { name: 'window 25', window: 25 },
  { name: 'lambda 10', lambda: 10 },
  { name: 'lambda 100', lambda: 100 },
  { name: 'squared window means', features: 'quad' },
];
console.table(CANDIDATES.map(({ name, ...c }) => ({ candidate: name, ...crossValidate(c) })));
