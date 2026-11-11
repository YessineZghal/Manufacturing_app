import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState,
  assess,
  startDrill,
  recordAttempt,
  manualRestore,
  fleet,
  upgrade,
  KNOWN_GOOD_MODEL,
} from '../lib/maintenance/domain.ts';
import { diagnose } from '../lib/maintenance/agent.ts';
test('assessments consume exactly one recorded cycle and retries preserve identity', () => {
  const s = createState();
  const first = assess(s, { engineId: 'unit-25' }, 'request_0001');
  assert.equal(first.status, 201);
  assert.equal(fleet(s)[0].remaining, 11);
  assert.equal(first.assessment.health, 'healthy');
  assert.ok(first.assessment.predictedRul > 0);
  const repeat = assess(s, { engineId: 'unit-25' }, 'request_0001');
  assert.equal(repeat.status, 200);
  assert.equal(repeat.assessment.id, first.assessment.id);
  assert.equal(s.assessments.length, 1);
  assert.equal(assess(s, { engineId: 'unit-71' }, 'request_0001').status, 409);
});
test('consecutive cycles advance through the replay and ground truth counts down', () => {
  const s = createState();
  const a = assess(s, { engineId: 'unit-34' }, 'cycle_one_01').assessment;
  const b = assess(s, { engineId: 'unit-34' }, 'cycle_two_02').assessment;
  assert.equal(b.cycle, a.cycle + 1);
  assert.equal(b.actualRul, a.actualRul - 1);
});
test('recorded cycles cannot be over-ingested', () => {
  const s = createState();
  for (let n = 0; n < 12; n++)
    assert.equal(assess(s, { engineId: 'unit-25' }, `request_${n}xx`).status, 201);
  assert.equal(assess(s, { engineId: 'unit-25' }, 'request_last').code, 'no_cycles_remaining');
  assert.equal(s.assessments.at(-1).actualRul, 145);
});
test('malformed inputs fail without mutation', () => {
  const s = createState();
  for (const body of [null, {}, [], { engineId: 'unknown' }, { engineId: 42 }])
    assert.equal(assess(s, body, 'request_1234').status, 422);
  assert.equal(assess(s, { engineId: 'unit-25' }, 'short').status, 422);
  assert.equal(assess(s, { engineId: 'reference' }, 'request_1234').status, 422);
  assert.equal(s.assessments.length, 0);
});
test('supported fault diagnoses are explicit and existing assessments survive', () => {
  for (const [fault, action] of [
    ['model_unavailable', 'restore_model'],
    ['gateway_paused', 'resume_gateway'],
  ]) {
    const s = createState();
    assess(s, { engineId: 'unit-25' }, 'existing_001');
    assert.equal(startDrill(s, fault).status, 201);
    assert.equal(diagnose(s), action);
    assert.equal(assess(s, { engineId: 'unit-25' }, 'new_one_001').status, 503);
    assert.equal(s.assessments.length, 1);
  }
});
test('unknown failures escalate and active incidents cannot be overwritten', () => {
  const s = createState();
  startDrill(s, 'unknown_dependency');
  assert.equal(diagnose(s), 'escalate');
  assert.equal(startDrill(s, 'gateway_paused').status, 409);
  assert.equal(startDrill(s, 'execute_shell').status, 422);
});
test('alert requires three consecutive server failures, not validation failures', () => {
  const s = createState();
  startDrill(s, 'gateway_paused');
  for (let n = 0; n < 4; n++)
    recordAttempt(s, { status: 422, code: 'invalid_engine' }, false, `invalid${n}`, 1);
  assert.equal(s.incident.status, 'detecting');
  for (let n = 0; n < 2; n++)
    recordAttempt(s, { status: 503, code: 'gateway_paused' }, true, `failed${n}`, 1);
  assert.equal(s.incident.status, 'detecting');
  recordAttempt(s, { status: 503, code: 'gateway_paused' }, true, 'trigger-trace', 1);
  assert.equal(s.incident.status, 'alerted');
  assert.equal(s.incident.traceId, 'trigger-trace');
});
test('successful attempts reset the failure streak; telemetry is bounded', () => {
  const s = createState();
  for (let n = 0; n < 140; n++)
    recordAttempt(s, { status: 503, code: 'unavailable' }, true, `trace${n}`, 1);
  assert.equal(s.traces.length, 120);
  recordAttempt(s, { status: 201, code: 'assessment_recorded' }, false, 'success', 1);
  assert.equal(s.failureStreak, 0);
  assert.equal(s.metrics.probeBad, 140);
  assert.equal(s.metrics.operatorGood, 1);
});
test('manual restore is never counted as agent recovery', () => {
  const s = createState();
  assess(s, { engineId: 'unit-25' }, 'assess_001');
  startDrill(s, 'unknown_dependency');
  manualRestore(s);
  assert.equal(s.incident.status, 'cancelled');
  assert.equal(s.metrics.recoveries, 0);
  assert.equal(s.assessments.length, 1);
});
test('probe assessments use the golden engine, are bounded and never consume fleet cycles', () => {
  const s = createState();
  for (let n = 0; n < 80; n++)
    assert.equal(assess(s, { engineId: 'reference' }, `probe_${n}xx`, true).status, 201);
  assert.equal(assess(s, { engineId: 'reference' }, 'probe_last', true).status, 429);
  assert.equal(assess(s, { engineId: 'unit-25' }, 'probe_wrong', true).status, 422);
  assert.ok(fleet(s).every(e => e.remaining === 12));
});
test('workspaces saved under a superseded model release move to the current model', () => {
  const s = createState();
  s.config.model = 'rul-fd001-v1';
  assert.equal(assess(upgrade(s), { engineId: 'unit-25' }, 'after_upgrade').status, 201);
  assert.equal(s.config.model, KNOWN_GOOD_MODEL);
  const drill = createState();
  startDrill(drill, 'model_unavailable');
  assert.equal(upgrade(drill).config.model, 'rul-model-missing');
});
