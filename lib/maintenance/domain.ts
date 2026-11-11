import { FLEET, REFERENCE } from './fleet.generated.ts';
import { MODEL } from './model.generated.ts';
import { health, predictRul, type Health, type RulModel } from './model.ts';
export type Fault = 'model_unavailable' | 'gateway_paused' | 'unknown_dependency';
export type IncidentStatus =
  | 'detecting'
  | 'alerted'
  | 'diagnosing'
  | 'verifying'
  | 'recovered'
  | 'escalated'
  | 'cancelled';
export interface Engine {
  id: string;
  label: string;
  unit: number;
  cycles: number;
}
export interface Assessment {
  id: string;
  engineId: string;
  key: string;
  createdAt: number;
  probe: boolean;
  cycle: number;
  predictedRul: number;
  actualRul: number;
  health: Health;
}
export interface Step {
  at: number;
  phase: string;
  tool: string;
  outcome: string;
  detail: string;
}
export interface Incident {
  id: string;
  kind: Fault;
  status: IncidentStatus;
  openedAt: number;
  alertedAt?: number;
  completedAt?: number;
  traceId?: string;
  configRevision: number;
  runId?: string;
  steps: Step[];
  verification?: {
    positive: number;
    negative: number;
    persisted: boolean;
    absoluteError: number | null;
    accurate: boolean;
  };
}
export interface Trace {
  traceId: string;
  spanId: string;
  at: number;
  durationMs: number;
  span: string;
  status: number;
  log: { event: string; component: string; outcome: string };
  metric: { name: string; value: number; journey: string; outcome: string };
}
export interface State {
  schemaVersion: 1;
  id: string;
  createdAt: number;
  config: {
    model: string;
    gateway: 'streaming' | 'paused';
    unknownFault: boolean;
    revision: number;
  };
  engines: Engine[];
  assessments: Assessment[];
  incident: Incident | null;
  history: Incident[];
  traces: Trace[];
  failureStreak: number;
  metrics: {
    operatorGood: number;
    operatorBad: number;
    probeGood: number;
    probeBad: number;
    rejected: number;
    recoveries: number;
  };
}
export interface Result {
  status: number;
  code: string;
  assessment?: Assessment;
  replay?: boolean;
}
/** The model registry. A configuration may only reference a model that exists here. */
export const MODELS: Record<string, RulModel> = { [MODEL.id]: MODEL };
export const KNOWN_GOOD_MODEL = MODEL.id;
/** The deliberately missing model reference that the `model_unavailable` drill injects. */
export const MISSING_MODEL = 'rul-model-missing';
/**
 * Pins a stored workspace to the release that loads it. A model ID this release does not serve
 * (an older one after an upgrade, a newer one after a rollback) moves to its known-good model;
 * only the drill's deliberately missing reference stays broken for the agent to repair.
 */
export function upgrade(s: State): State {
  if (!Object.hasOwn(MODELS, s.config.model) && s.config.model !== MISSING_MODEL)
    s.config.model = KNOWN_GOOD_MODEL;
  return s;
}
/** A recovered model must predict the golden engine within this many cycles of its true RUL. */
export const VERIFICATION_TOLERANCE = 15;
export const uuid = () => crypto.randomUUID();
export const traceId = () => uuid().replaceAll('-', '');
export function createState(id = uuid(), now = Date.now()): State {
  return {
    schemaVersion: 1,
    id,
    createdAt: now,
    config: { model: KNOWN_GOOD_MODEL, gateway: 'streaming', unknownFault: false, revision: 0 },
    engines: FLEET.map(e => ({
      id: e.id,
      label: e.label,
      unit: e.unit,
      cycles: e.rows.length - MODEL.window + 1,
    })),
    assessments: [],
    incident: null,
    history: [],
    traces: [],
    failureStreak: 0,
    metrics: {
      operatorGood: 0,
      operatorBad: 0,
      probeGood: 0,
      probeBad: 0,
      rejected: 0,
      recoveries: 0,
    },
  };
}
export function serviceFault(s: State): string | null {
  if (s.config.unknownFault) return 'unknown_dependency';
  if (!Object.hasOwn(MODELS, s.config.model)) return 'model_unavailable';
  if (s.config.gateway !== 'streaming') return 'gateway_paused';
  return null;
}
/** Ingests the next recorded sensor cycle of an engine and persists its RUL assessment. */
export function assess(
  s: State,
  body: unknown,
  key: string,
  probe = false,
  now = Date.now(),
): Result {
  if (!body || typeof body !== 'object' || !/^[a-zA-Z0-9_-]{8,80}$/.test(key))
    return { status: 422, code: 'invalid_request' };
  const engineId = (body as { engineId?: unknown }).engineId;
  if (
    typeof engineId !== 'string' ||
    (!probe && !s.engines.some(engine => engine.id === engineId)) ||
    (probe && engineId !== REFERENCE.id)
  )
    return { status: 422, code: 'invalid_engine' };
  const previous = s.assessments.find(a => a.key === key);
  if (previous) {
    if (previous.engineId !== engineId || previous.probe !== probe)
      return { status: 409, code: 'idempotency_conflict' };
    return { status: 200, code: 'assessment_recorded', assessment: previous, replay: true };
  }
  const fault = serviceFault(s);
  if (fault) return { status: 503, code: fault };
  const model = MODELS[s.config.model];
  let window: number[][], cycle: number, actualRul: number;
  if (!probe) {
    const engine = s.engines.find(engine => engine.id === engineId)!;
    const source = FLEET.find(e => e.id === engineId)!;
    const ingested = s.assessments.filter(a => !a.probe && a.engineId === engineId).length;
    if (ingested >= engine.cycles) return { status: 409, code: 'no_cycles_remaining' };
    window = source.rows.slice(ingested, ingested + model.window);
    cycle = source.firstCycle + ingested + model.window - 1;
    actualRul = source.finalRul + (engine.cycles - 1 - ingested);
  } else {
    if (s.assessments.filter(a => a.probe).length >= 80)
      return { status: 429, code: 'probe_budget_exhausted' };
    window = REFERENCE.rows;
    cycle = REFERENCE.cycle;
    actualRul = REFERENCE.actualRul;
  }
  const predictedRul = predictRul(model, window, cycle);
  const assessment: Assessment = {
    id: uuid(),
    engineId,
    key,
    createdAt: now,
    probe,
    cycle,
    predictedRul,
    actualRul,
    health: health(predictedRul),
  };
  s.assessments.push(assessment);
  return { status: 201, code: 'assessment_recorded', assessment };
}
export function recordAttempt(
  s: State,
  result: Result,
  probe: boolean,
  trace: string,
  durationMs: number,
  now = Date.now(),
) {
  const good = result.status < 300,
    bad = result.status >= 500;
  // A replayed idempotency key returns the stored record without exercising the pipeline, so it
  // is traced but neither counts as a success nor resets the failure streak.
  if (result.replay) {
    /* traced below only */
  } else if (good) {
    if (probe) s.metrics.probeGood++;
    else s.metrics.operatorGood++;
    s.failureStreak = 0;
  } else if (bad) {
    if (probe) s.metrics.probeBad++;
    else s.metrics.operatorBad++;
    s.failureStreak++;
  } else s.metrics.rejected++;
  const outcome = good ? 'success' : bad ? 'unavailable' : 'rejected';
  s.traces.push({
    traceId: trace,
    spanId: uuid().replaceAll('-', '').slice(0, 16),
    at: now,
    durationMs: Math.max(0, Math.round(durationMs * 100) / 100),
    span: 'rul.assessment',
    status: result.status,
    log: { event: 'assessment.completed', component: 'rul-service', outcome: result.code },
    metric: {
      name: 'rul_assessment_journey_total',
      value: 1,
      journey: probe ? 'synthetic_probe' : 'operator_assessment',
      outcome,
    },
  });
  s.traces = s.traces.slice(-120);
  if (bad && s.failureStreak >= 3 && s.incident?.status === 'detecting') {
    s.incident.status = 'alerted';
    s.incident.alertedAt = now;
    s.incident.traceId = trace;
    step(
      s.incident,
      'Alert',
      'evaluate_operator_impact',
      'triggered',
      'Three consecutive unavailable RUL assessments. Validation errors are excluded.',
      now,
    );
  }
}
export function step(
  i: Incident,
  phase: string,
  tool: string,
  outcome: string,
  detail: string,
  now = Date.now(),
) {
  i.steps.push({ at: now, phase, tool, outcome, detail });
}
export function startDrill(s: State, kind: unknown, now = Date.now()): Result {
  if (!['model_unavailable', 'gateway_paused', 'unknown_dependency'].includes(String(kind)))
    return { status: 422, code: 'unsupported_drill' };
  if (s.incident && !['recovered', 'cancelled'].includes(s.incident.status))
    return { status: 409, code: 'incident_in_progress' };
  if (s.history.length >= 12) return { status: 429, code: 'drill_budget_exhausted' };
  if (s.incident) s.history.push(s.incident);
  s.config = {
    model: kind === 'model_unavailable' ? MISSING_MODEL : KNOWN_GOOD_MODEL,
    gateway: kind === 'gateway_paused' ? 'paused' : 'streaming',
    unknownFault: kind === 'unknown_dependency',
    revision: s.config.revision + 1,
  };
  s.failureStreak = 0;
  s.incident = {
    id: uuid(),
    kind: kind as Fault,
    status: 'detecting',
    openedAt: now,
    configRevision: s.config.revision,
    steps: [],
  };
  step(
    s.incident,
    'Fault',
    'inject_workspace_fault',
    'applied',
    'A controlled fault affects this workspace only. Existing assessments are unchanged.',
    now,
  );
  return { status: 201, code: 'drill_started' };
}
export function manualRestore(s: State, now = Date.now()): Result {
  s.config = {
    model: KNOWN_GOOD_MODEL,
    gateway: 'streaming',
    unknownFault: false,
    revision: s.config.revision + 1,
  };
  s.failureStreak = 0;
  if (s.incident && !['recovered', 'cancelled'].includes(s.incident.status)) {
    s.incident.status = 'cancelled';
    s.incident.completedAt = now;
    step(
      s.incident,
      'Operator',
      'restore_known_good',
      'cancelled',
      'Maintenance engineer restored the pipeline; this is not an autonomous recovery.',
      now,
    );
  }
  return { status: 200, code: 'service_restored' };
}
/** Fleet view: cycles left to ingest and the latest assessment per engine. */
export function fleet(s: State) {
  return s.engines.map(engine => {
    const own = s.assessments.filter(a => !a.probe && a.engineId === engine.id);
    return { ...engine, remaining: engine.cycles - own.length, latest: own.at(-1) ?? null };
  });
}
