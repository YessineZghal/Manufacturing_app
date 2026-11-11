// Remaining-useful-life inference for NASA C-MAPSS FD001. The weights are trained offline by
// scripts/train-model.mjs; this file is the identical, dependency-free runtime used by the Worker.
export interface RulModel {
  id: string;
  dataset: string;
  algorithm: string;
  sensors: string[];
  window: number;
  rulCap: number;
  mean: number[];
  std: number[];
  weights: number[];
  intercept: number;
  evaluation: {
    split: string;
    units: number;
    rmse: number;
    rmseAgainstCappedTruth: number;
    mae: number;
    phmScore: number;
  };
}
/** A held-out FD001 test engine replayed cycle by cycle from the plant historian. */
export interface FleetEngine {
  id: string;
  label: string;
  unit: number;
  firstCycle: number;
  finalRul: number;
  rows: number[][];
}
/** The golden engine scored by synthetic probes. Its true RUL is known. */
export interface ReferenceEngine {
  id: 'reference';
  label: string;
  unit: number;
  cycle: number;
  actualRul: number;
  expectedRul: number;
  rows: number[][];
}
export type Health = 'healthy' | 'watch' | 'critical';

/** Below this predicted RUL an engine must be scheduled for maintenance now. */
export const CRITICAL_RUL = 30;
/** Below this predicted RUL an engine is planned into the next maintenance window. */
export const WATCH_RUL = 80;

/** Window mean and least-squares slope per sensor, plus the cycle count. */
export function features(window: number[][], cycle: number): number[] {
  const n = window.length,
    tMean = (n - 1) / 2,
    width = window[0]?.length ?? 0;
  let tVar = 0;
  for (let t = 0; t < n; t++) tVar += (t - tMean) ** 2;
  const means: number[] = [],
    slopes: number[] = [];
  for (let k = 0; k < width; k++) {
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

export function predictRul(model: RulModel, window: number[][], cycle: number): number {
  const f = features(window, cycle);
  if (f.length !== model.weights.length) throw new Error('feature_shape_mismatch');
  let v = model.intercept;
  for (let j = 0; j < f.length; j++)
    v += model.weights[j] * ((f[j] - model.mean[j]) / model.std[j]);
  return Math.round(Math.min(model.rulCap, Math.max(0, v)) * 10) / 10;
}

export function health(rul: number): Health {
  return rul <= CRITICAL_RUL ? 'critical' : rul <= WATCH_RUL ? 'watch' : 'healthy';
}

export const RECOMMENDATION: Record<Health, string> = {
  healthy: 'Continue operation',
  watch: 'Plan maintenance in the next window',
  critical: 'Schedule maintenance now',
};
