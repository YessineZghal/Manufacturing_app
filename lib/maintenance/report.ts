// Executive resilience report: turns incident evidence into the measures and decisions a plant
// leadership team needs: objective attainment, operator impact, model quality, and where the AI
// agent may act on its own.
import { MODEL } from './model.generated.ts';
import type { Fault, Incident, State } from './domain.ts';

/** Recovery time objective for the RUL assessment journey: 15 minutes, a common business default. */
export const RECOVERY_TIME_OBJECTIVE_MS = 15 * 60 * 1000;
/** Minimum verified incidents of one class before the evidence can support expanding autonomy. */
export const EVIDENCE_THRESHOLD = 3;

export type Recommendation =
  | 'expand_autonomy'
  | 'keep_human_review'
  | 'human_owned'
  | 'gather_evidence';

export interface FaultClassReport {
  fault: Fault;
  label: string;
  incidents: number;
  autonomousRecoveries: number;
  escalations: number;
  operatorRestores: number;
  medianRecoveryMs: number | null;
  withinObjective: number;
  recommendation: Recommendation;
  rationale: string;
}

export interface ExecutiveReport {
  format: 'predictive-maintenance-executive-report/v1';
  generatedAt: string;
  dataClassification: 'public-benchmark';
  objective: { journey: string; recoveryTimeObjectiveMs: number };
  headline: {
    incidents: number;
    autonomousRecoveries: number;
    escalatedToHumans: number;
    operatorRestores: number;
    autonomyRate: number | null;
    objectiveAttainment: number | null;
    medianTimeToDetectMs: number | null;
    medianTimeToVerifiedRecoveryMs: number | null;
    worstTimeToVerifiedRecoveryMs: number | null;
  };
  operatorImpact: {
    assessmentSuccessRate: number | null;
    failedOperatorAttempts: number;
    successfulOperatorAttempts: number;
    assessmentsPreserved: number;
    criticalEngines: number;
  };
  modelQuality: {
    model: string;
    offlineRmse: number;
    offlineMae: number;
    offlineUnits: number;
    liveAssessments: number;
    liveMae: number | null;
  };
  faultClasses: FaultClassReport[];
  decisions: string[];
  caveats: string[];
}

const LABELS: Record<Fault, string> = {
  model_unavailable: 'RUL model reference unavailable',
  gateway_paused: 'Sensor gateway paused',
  unknown_dependency: 'Unrecognised plant dependency failure',
};

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};
const ratio = (part: number, whole: number) => (whole ? part / whole : null);
const closed = (i: Incident) => ['recovered', 'escalated', 'cancelled'].includes(i.status);
const recoveryMs = (i: Incident) => (i.completedAt ?? i.openedAt) - i.openedAt;
/** Escalated by the agent, even if an operator restored the service afterwards. */
const wasEscalated = (i: Incident) =>
  i.status === 'escalated' || i.steps.some(step => step.phase === 'Escalate');

function classify(fault: Fault, list: Incident[], objectiveMs: number): FaultClassReport {
  const recovered = list.filter(i => i.status === 'recovered');
  const escalated = list.filter(wasEscalated);
  const restored = list.filter(i => i.status === 'cancelled');
  const within = recovered.filter(i => recoveryMs(i) <= objectiveMs).length;
  let recommendation: Recommendation;
  let rationale: string;
  if (fault === 'unknown_dependency') {
    recommendation = 'human_owned';
    rationale =
      'No approved repair exists. Keep this class with maintenance engineers; a recurring pattern is a candidate for a new, reviewed runbook.';
  } else if (list.length < EVIDENCE_THRESHOLD) {
    recommendation = 'gather_evidence';
    rationale = `${list.length} of ${EVIDENCE_THRESHOLD} incidents needed before the evidence can support a decision.`;
  } else if (
    escalated.length === 0 &&
    recovered.length === list.length - restored.length &&
    within === recovered.length
  ) {
    recommendation = 'expand_autonomy';
    rationale = `Every agent-handled incident was verified and recovered within the objective (${within}/${recovered.length}).`;
  } else {
    recommendation = 'keep_human_review';
    rationale = `${escalated.length} escalation(s) or objective misses. Keep a human in the loop until the pattern is understood.`;
  }
  return {
    fault,
    label: LABELS[fault],
    incidents: list.length,
    autonomousRecoveries: recovered.length,
    escalations: escalated.length,
    operatorRestores: restored.length,
    medianRecoveryMs: median(recovered.map(recoveryMs)),
    withinObjective: within,
    recommendation,
    rationale,
  };
}

/** Builds the executive report for one workspace from its stored incident evidence. */
export function executiveReport(
  s: Pick<State, 'incident' | 'history' | 'metrics' | 'assessments'>,
  now = Date.now(),
  objectiveMs = RECOVERY_TIME_OBJECTIVE_MS,
): ExecutiveReport {
  const incidents = [...s.history, ...(s.incident ? [s.incident] : [])].filter(closed);
  const recovered = incidents.filter(i => i.status === 'recovered');
  const escalated = incidents.filter(wasEscalated);
  const restored = incidents.filter(i => i.status === 'cancelled');
  const agentHandled = recovered.length + escalated.length;
  const detection = incidents.filter(i => i.alertedAt).map(i => i.alertedAt! - i.openedAt);
  const recoveries = recovered.map(recoveryMs);
  const within = recoveries.filter(ms => ms <= objectiveMs).length;
  const operatorAttempts = s.metrics.operatorGood + s.metrics.operatorBad;
  const fleetAssessments = s.assessments.filter(a => !a.probe);
  const latest = new Map(fleetAssessments.map(a => [a.engineId, a]));
  const faultClasses = (Object.keys(LABELS) as Fault[])
    .map(fault =>
      classify(
        fault,
        incidents.filter(i => i.kind === fault),
        objectiveMs,
      ),
    )
    .filter(c => c.incidents > 0);

  const decisions: string[] = [];
  for (const c of faultClasses) {
    if (c.recommendation === 'expand_autonomy')
      decisions.push(`Approve autonomous recovery for “${c.label}”: the evidence meets the bar.`);
    if (c.recommendation === 'keep_human_review')
      decisions.push(
        `Keep human review for “${c.label}” and investigate the escalations before widening autonomy.`,
      );
    if (c.recommendation === 'human_owned')
      decisions.push(
        `Keep “${c.label}” with maintenance engineers; fund a reviewed runbook if it recurs.`,
      );
    if (c.recommendation === 'gather_evidence')
      decisions.push(
        `No decision yet on “${c.label}”: run more drills to reach the evidence threshold.`,
      );
  }
  if (!incidents.length) decisions.push('Run a recovery drill to generate the first evidence.');

  return {
    format: 'predictive-maintenance-executive-report/v1',
    generatedAt: new Date(now).toISOString(),
    dataClassification: 'public-benchmark',
    objective: { journey: 'Engine RUL assessment', recoveryTimeObjectiveMs: objectiveMs },
    headline: {
      incidents: incidents.length,
      autonomousRecoveries: recovered.length,
      escalatedToHumans: escalated.length,
      operatorRestores: restored.length,
      autonomyRate: ratio(recovered.length, agentHandled),
      objectiveAttainment: ratio(within, recovered.length),
      medianTimeToDetectMs: median(detection),
      medianTimeToVerifiedRecoveryMs: median(recoveries),
      worstTimeToVerifiedRecoveryMs: recoveries.length ? Math.max(...recoveries) : null,
    },
    operatorImpact: {
      assessmentSuccessRate: ratio(s.metrics.operatorGood, operatorAttempts),
      failedOperatorAttempts: s.metrics.operatorBad,
      successfulOperatorAttempts: s.metrics.operatorGood,
      assessmentsPreserved: fleetAssessments.length,
      criticalEngines: [...latest.values()].filter(a => a.health === 'critical').length,
    },
    modelQuality: {
      model: MODEL.id,
      offlineRmse: MODEL.evaluation.rmse,
      offlineMae: MODEL.evaluation.mae,
      offlineUnits: MODEL.evaluation.units,
      liveAssessments: fleetAssessments.length,
      liveMae: fleetAssessments.length
        ? Math.round(
            (fleetAssessments.reduce((sum, a) => sum + Math.abs(a.predictedRul - a.actualRul), 0) /
              fleetAssessments.length) *
              10,
          ) / 10
        : null,
    },
    faultClasses,
    decisions,
    caveats: [
      'Controlled laboratory replaying the public NASA C-MAPSS FD001 benchmark; figures describe this workspace only.',
      'Autonomy rate = agent recoveries ÷ agent-handled incidents. An escalation counts against autonomy even if an engineer later restores the pipeline; manual restores are never counted as AI success.',
      `A fault class needs at least ${EVIDENCE_THRESHOLD} incidents before the report recommends expanding autonomy.`,
      'Model error is measured against the simulated ground truth. RUL predictions support, and never replace, a maintenance engineer’s decision.',
    ],
  };
}
