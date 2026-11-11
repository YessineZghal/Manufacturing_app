import {
  KNOWN_GOOD_MODEL,
  MODELS,
  VERIFICATION_TOLERANCE,
  serviceFault,
  step,
  uuid,
  type State,
} from './domain.ts';
import { Repository } from './repository.ts';
export type Probe = (negative: boolean) => Promise<{ status: number; assessmentId?: string }>;
export interface Observation {
  rulModelAvailable: boolean;
  gatewayStreaming: boolean;
  unknownDependency: boolean;
}
/** A language-model second opinion. It can only confirm the policy decision, never widen it. */
export type Advisor = ((observation: Observation) => Promise<string>) & { label?: string };
export function diagnose(s: State): 'restore_model' | 'resume_gateway' | 'escalate' {
  const fault = serviceFault(s);
  return fault === 'model_unavailable'
    ? 'restore_model'
    : fault === 'gateway_paused'
      ? 'resume_gateway'
      : 'escalate';
}
export async function respond(repo: Repository, id: string, probe: Probe, advisor?: Advisor) {
  const runId = uuid();
  const claim = await repo.mutate(id, s => {
    const i = s.incident;
    if (i?.status !== 'alerted') return null;
    i.status = 'diagnosing';
    i.runId = runId;
    step(
      i,
      'Observe',
      'read_pipeline_state',
      'complete',
      'Read pipeline configuration and the three-attempt operator-impact alert. No sensor data is sent to reasoning.',
    );
    return { incidentId: i.id, revision: s.config.revision };
  });
  if (!claim.result) return;
  const observed = claim.state;
  const policy = diagnose(observed);
  let decision: string = policy,
    reasoner = 'bounded-policy';
  if (advisor) {
    let proposed = 'no valid answer';
    try {
      proposed = await advisor({
        rulModelAvailable: Object.hasOwn(MODELS, observed.config.model),
        gatewayStreaming: observed.config.gateway === 'streaming',
        unknownDependency: observed.config.unknownFault,
      });
    } catch (error) {
      // An unavailable or malformed adviser is treated as disagreement. Only a short,
      // sanitised reason is recorded; model output and provider messages never are.
      const code = error instanceof Error ? error.message : '';
      const reason = /^adviser_[a-z_]+$/.test(code) ? code : 'model_unavailable';
      proposed = `no valid answer (${reason})`;
    }
    if (proposed !== policy) decision = 'escalate';
    reasoner = `model-advised (${advisor.label ?? 'language model'} proposed ${proposed}; policy selected ${policy})`;
  }
  const repaired = await repo.mutate(id, s => {
    const i = s.incident;
    if (!i || i.id !== claim.result!.incidentId || i.runId !== runId || i.status !== 'diagnosing')
      return false;
    step(
      i,
      'Diagnose',
      'select_allowlisted_repair',
      decision,
      `Reasoner: ${reasoner}. The repair must agree with observed state and cannot change assessments or model weights.`,
    );
    if (
      s.config.revision !== claim.result!.revision ||
      diagnose(s) !== decision ||
      decision === 'escalate'
    ) {
      i.status = 'escalated';
      i.completedAt = Date.now();
      step(
        i,
        'Escalate',
        'request_engineer_review',
        'no_mutation',
        'Unsupported, changed or inconclusive state. Automatic repair withheld.',
      );
      return false;
    }
    if (decision === 'restore_model') s.config.model = KNOWN_GOOD_MODEL;
    else s.config.gateway = 'streaming';
    s.config.revision++;
    i.status = 'verifying';
    step(
      i,
      'Repair',
      decision,
      'applied',
      decision === 'restore_model'
        ? `Pointed the model registry back to the validated ${KNOWN_GOOD_MODEL} using a revision-checked update.`
        : 'Resumed the sensor gateway using a revision-checked update.',
    );
    return true;
  });
  if (!repaired.result) return;
  let positive: { status: number; assessmentId?: string } = { status: 599 },
    negative: { status: number; assessmentId?: string } = { status: 599 };
  try {
    positive = await probe(false);
    negative = await probe(true);
  } catch {
    /* Verification failure escalates below. */
  }
  await repo.mutate(id, s => {
    const i = s.incident;
    if (!i || i.id !== claim.result!.incidentId || i.runId !== runId || i.status !== 'verifying')
      return;
    // Accuracy is read from the persisted record, never from the probe's own response.
    const record = s.assessments.find(a => a.id === positive.assessmentId && a.probe);
    const persisted = !!record;
    const absoluteError = record
      ? Math.round(Math.abs(record.predictedRul - record.actualRul) * 10) / 10
      : null;
    const accurate = absoluteError !== null && absoluteError <= VERIFICATION_TOLERANCE;
    const pass =
      positive.status === 201 &&
      negative.status === 422 &&
      persisted &&
      accurate &&
      !serviceFault(s);
    i.verification = {
      positive: positive.status,
      negative: negative.status,
      persisted,
      absoluteError,
      accurate,
    };
    i.status = pass ? 'recovered' : 'escalated';
    i.completedAt = Date.now();
    if (pass) s.metrics.recoveries++;
    step(
      i,
      'Verify',
      'exercise_assessment_api',
      pass ? 'passed' : 'failed',
      `Golden-engine probe HTTP ${positive.status}; invalid-engine probe HTTP ${negative.status}; durable probe assessment ${persisted ? 'confirmed' : 'absent'}; ` +
        `prediction error ${absoluteError === null ? 'unknown' : `${absoluteError} cycles`} (tolerance ${VERIFICATION_TOLERANCE}).`,
    );
    if (!pass)
      step(
        i,
        'Escalate',
        'request_engineer_review',
        'verification_failed',
        'The repair did not establish recovery. No recovered status is claimed.',
      );
  });
}
