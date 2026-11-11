// Trains the remaining-useful-life (RUL) model on NASA C-MAPSS FD001 and writes the artifacts the
// Worker serves. Deterministic: the same dataset always produces the same files.
//   node scripts/train-model.mjs            # train, evaluate, write lib/maintenance/*.generated.ts
//   node scripts/train-model.mjs --check    # fail if the committed artifacts are out of date
import { readFileSync, writeFileSync } from 'node:fs';

/** FD001 sensors that carry degradation signal (the others are constant at one operating condition). */
const SENSORS = [2, 3, 4, 7, 8, 9, 11, 12, 13, 14, 15, 17, 20, 21];
/** Rolling window, in cycles. Every FD001 test trajectory has at least 31 cycles. */
const WINDOW = 30;
/** Piecewise-linear target: early-life RUL is not observable, so it is capped (standard practice). */
const RUL_CAP = 125;
const RIDGE = 1;

const read = name =>
  readFileSync(new URL(`../dataset/CMAPSS/${name}`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map(line => line.trim().split(/\s+/).map(Number));

/** Groups dataset rows by unit; each row keeps the cycle and the selected sensors. */
function trajectories(rows) {
  const units = new Map();
  for (const r of rows) {
    if (!units.has(r[0])) units.set(r[0], []);
    units.get(r[0]).push({ cycle: r[1], sensors: SENSORS.map(k => r[4 + k]) });
  }
  return units;
}

/** Window mean and least-squares slope per sensor, plus the cycle count. Mirrors lib/maintenance/model.ts. */
function features(window, cycle) {
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
  return [...means, ...slopes, cycle];
}

/** Training examples use full windows only: inference always sees WINDOW cycles, and the partial
 * windows of a unit's first cycles have unreliable slopes that bias the fit. */
function examples(units, labelOf) {
  const x = [],
    y = [];
  for (const [unit, rows] of units)
    for (let i = WINDOW - 1; i < rows.length; i++) {
      const label = labelOf(unit, rows, i);
      if (label === null) continue;
      const window = rows.slice(i - WINDOW + 1, i + 1).map(r => r.sensors);
      x.push(features(window, rows[i].cycle));
      y.push(label);
    }
  return { x, y };
}

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

/** Closed-form ridge regression on standardised features. */
function fit({ x, y }) {
  const d = x[0].length;
  const mean = Array.from({ length: d }, (_, j) => x.reduce((s, r) => s + r[j], 0) / x.length);
  const std = mean.map(
    (m, j) => Math.sqrt(x.reduce((s, r) => s + (r[j] - m) ** 2, 0) / x.length) || 1,
  );
  const yMean = y.reduce((s, v) => s + v, 0) / y.length;
  const z = x.map(r => r.map((v, j) => (v - mean[j]) / std[j]));
  const xtx = Array.from({ length: d }, (_, i) =>
    Array.from(
      { length: d },
      (_, j) => z.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? RIDGE : 0),
    ),
  );
  const xty = Array.from({ length: d }, (_, i) =>
    z.reduce((s, r, n) => s + r[i] * (y[n] - yMean), 0),
  );
  return { mean, std, weights: solve(xtx, xty), intercept: yMean };
}

function predict(model, f) {
  let v = model.intercept;
  for (let j = 0; j < f.length; j++)
    v += model.weights[j] * ((f[j] - model.mean[j]) / model.std[j]);
  return Math.min(model.rulCap, Math.max(0, v));
}

/** PHM08 asymmetric score: late predictions (overestimating RUL) are penalised more. */
const phmScore = errors =>
  errors.reduce((s, e) => s + (e < 0 ? Math.exp(-e / 13) - 1 : Math.exp(e / 10) - 1), 0);
const round = (v, digits = 4) => Math.round(v * 10 ** digits) / 10 ** digits;

const train = trajectories(read('train_FD001.txt'));
const test = trajectories(read('test_FD001.txt'));
const truth = read('RUL_FD001.txt').map(r => r[0]);

const fitted = fit(examples(train, (_, rows, i) => Math.min(RUL_CAP, rows.length - 1 - i)));
const model = { ...fitted, rulCap: RUL_CAP };

// Official evaluation: one prediction per test unit at its last recorded cycle.
const testPredictions = [...test].map(([unit, rows]) => {
  const window = rows.slice(-WINDOW).map(r => r.sensors);
  return {
    unit,
    predicted: predict(model, features(window, rows.at(-1).cycle)),
    actual: truth[unit - 1],
  };
});
const errors = testPredictions.map(p => p.predicted - p.actual);
const rmse = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length);
const mae = errors.reduce((s, e) => s + Math.abs(e), 0) / errors.length;
const cappedErrors = testPredictions.map(p => p.predicted - Math.min(RUL_CAP, p.actual));
const cappedRmse = Math.sqrt(cappedErrors.reduce((s, e) => s + e * e, 0) / errors.length);

// The plant fleet: six held-out test engines that span healthy to near-failure. Each replays its
// final recorded cycles, so the operator can ingest them one at a time.
const REPLAY = 12;
const FLEET_UNITS = [
  { unit: 25, label: 'Engine T-25' },
  { unit: 71, label: 'Engine T-71' },
  { unit: 63, label: 'Engine T-63' },
  { unit: 17, label: 'Engine T-17' },
  { unit: 20, label: 'Engine T-20' },
  { unit: 34, label: 'Engine T-34' },
];
const pack = (unit, rows, finalRul) => ({
  unit,
  firstCycle: rows.at(-(WINDOW + REPLAY - 1)).cycle,
  // Actual RUL at the last recorded cycle; earlier cycles add their distance to it.
  finalRul,
  rows: rows.slice(-(WINDOW + REPLAY - 1)).map(r => r.sensors),
});
const fleet = FLEET_UNITS.map(({ unit, label }) => ({
  id: `unit-${unit}`,
  label,
  ...pack(unit, test.get(unit), truth[unit - 1]),
}));
// Golden reference engine for synthetic probes: a held-out test unit with known RUL whose
// release-time prediction is recorded, so verification can detect a wrong or corrupted model.
const REFERENCE_UNIT = 91;
const referenceRows = test.get(REFERENCE_UNIT);
const referenceWindow = referenceRows.slice(-WINDOW).map(r => r.sensors);
const reference = {
  id: 'reference',
  label: `Golden reference (FD001 test unit ${REFERENCE_UNIT})`,
  unit: REFERENCE_UNIT,
  cycle: referenceRows.at(-1).cycle,
  actualRul: truth[REFERENCE_UNIT - 1],
  expectedRul: round(predict(model, features(referenceWindow, referenceRows.at(-1).cycle)), 2),
  rows: referenceWindow,
};

const artifact = {
  id: 'rul-fd001-v2',
  dataset: 'NASA C-MAPSS FD001 (one operating condition, HPC degradation)',
  algorithm: `Ridge regression (lambda ${RIDGE}) on full ${WINDOW}-cycle window means and slopes of ${SENSORS.length} sensors plus cycle count`,
  sensors: SENSORS.map(k => `s${k}`),
  window: WINDOW,
  rulCap: RUL_CAP,
  mean: model.mean.map(v => round(v, 6)),
  std: model.std.map(v => round(v, 6)),
  weights: model.weights.map(v => round(v, 6)),
  intercept: round(model.intercept, 6),
  evaluation: {
    split: 'FD001 test set, last recorded cycle of each of the 100 units vs RUL_FD001',
    units: testPredictions.length,
    rmse: round(rmse, 2),
    rmseAgainstCappedTruth: round(cappedRmse, 2),
    mae: round(mae, 2),
    phmScore: round(phmScore(errors), 1),
  },
};

const header =
  '// Generated by scripts/train-model.mjs from dataset/CMAPSS. Do not edit by hand.\n';
const files = {
  'lib/maintenance/model.generated.ts': `${header}import type { RulModel } from './model.ts';\n\nexport const MODEL: RulModel = ${JSON.stringify(artifact, null, 2)};\n`,
  'lib/maintenance/fleet.generated.ts': `${header}import type { FleetEngine, ReferenceEngine } from './model.ts';\n\nexport const FLEET: FleetEngine[] = ${JSON.stringify(fleet)};\n\nexport const REFERENCE: ReferenceEngine = ${JSON.stringify(reference)};\n`,
};
const stale = Object.entries(files).filter(([path, content]) => {
  try {
    return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8') !== content;
  } catch {
    return true;
  }
});
if (process.argv.includes('--check')) {
  if (stale.length) {
    console.error(`Out of date: ${stale.map(([p]) => p).join(', ')}. Run npm run model:train.`);
    process.exit(1);
  }
} else
  for (const [path, content] of stale)
    writeFileSync(new URL(`../${path}`, import.meta.url), content);
console.log(
  JSON.stringify(
    {
      model: artifact.id,
      trainingExamples: [...train.values()].reduce((s, r) => s + r.length - WINDOW + 1, 0),
      evaluation: artifact.evaluation,
      fleet: fleet.map(e => ({ id: e.id, finalRul: e.finalRul })),
      reference: {
        unit: reference.unit,
        actualRul: reference.actualRul,
        expectedRul: reference.expectedRul,
      },
    },
    null,
    2,
  ),
);
