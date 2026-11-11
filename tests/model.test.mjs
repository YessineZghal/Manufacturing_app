import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODEL } from '../lib/maintenance/model.generated.ts';
import { FLEET, REFERENCE } from '../lib/maintenance/fleet.generated.ts';
import { features, predictRul, health, CRITICAL_RUL, WATCH_RUL } from '../lib/maintenance/model.ts';
import { VERIFICATION_TOLERANCE } from '../lib/maintenance/domain.ts';

const read = name =>
  readFileSync(new URL(`../dataset/CMAPSS/${name}`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map(line => line.trim().split(/\s+/).map(Number));
const sensorIndex = MODEL.sensors.map(s => 4 + Number(s.slice(1)));

test('the Worker runtime reproduces the recorded FD001 test-set evaluation', () => {
  const units = new Map();
  for (const r of read('test_FD001.txt')) {
    if (!units.has(r[0])) units.set(r[0], []);
    units.get(r[0]).push(r);
  }
  const truth = read('RUL_FD001.txt').map(r => r[0]);
  const errors = [...units].map(([unit, rows]) => {
    const window = rows.slice(-MODEL.window).map(r => sensorIndex.map(i => r[i]));
    return predictRul(MODEL, window, rows.at(-1)[1]) - truth[unit - 1];
  });
  const rmse = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length);
  assert.equal(errors.length, 100);
  assert.ok(Math.abs(rmse - MODEL.evaluation.rmse) < 0.1, `rmse ${rmse}`);
  // Quality gate: a regression above this bound must not ship.
  assert.ok(MODEL.evaluation.rmse < 20, 'FD001 RMSE must stay below 20 cycles');
});

test('features are window means, slopes and the cycle; predictions are clamped to [0, cap]', () => {
  const window = [
    [1, 10],
    [2, 10],
    [3, 10],
  ];
  assert.deepEqual(features(window, 42), [2, 10, 1, 0, 42]);
  const flat = Array.from({ length: MODEL.window }, () =>
    MODEL.mean.slice(0, MODEL.sensors.length),
  );
  const rul = predictRul(MODEL, flat, 1);
  assert.ok(rul >= 0 && rul <= MODEL.rulCap);
  assert.throws(() => predictRul(MODEL, [[1, 2]], 1), /feature_shape_mismatch/);
});

test('health bands map predicted RUL to a maintenance decision', () => {
  assert.equal(health(CRITICAL_RUL), 'critical');
  assert.equal(health(CRITICAL_RUL + 0.1), 'watch');
  assert.equal(health(WATCH_RUL), 'watch');
  assert.equal(health(WATCH_RUL + 0.1), 'healthy');
});

test('fleet replay windows and ground truth come straight from the FD001 test files', () => {
  const rows = read('test_FD001.txt');
  const truth = read('RUL_FD001.txt').map(r => r[0]);
  for (const engine of FLEET) {
    const unit = rows.filter(r => r[0] === engine.unit);
    assert.equal(engine.finalRul, truth[engine.unit - 1]);
    assert.equal(engine.firstCycle + engine.rows.length - 1, unit.at(-1)[1]);
    assert.deepEqual(
      engine.rows.at(-1),
      sensorIndex.map(i => unit.at(-1)[i]),
    );
  }
  const finalBands = FLEET.map(e =>
    health(predictRul(MODEL, e.rows.slice(-MODEL.window), e.firstCycle + e.rows.length - 1)),
  );
  assert.deepEqual([...new Set(finalBands)].sort(), ['critical', 'healthy', 'watch']);
});

test('the golden reference engine is predicted within the verification tolerance', () => {
  const predicted = predictRul(MODEL, REFERENCE.rows, REFERENCE.cycle);
  assert.ok(Math.abs(predicted - REFERENCE.expectedRul) < 0.1);
  assert.ok(Math.abs(predicted - REFERENCE.actualRul) <= VERIFICATION_TOLERANCE);
  assert.equal(REFERENCE.rows.length, MODEL.window);
});
