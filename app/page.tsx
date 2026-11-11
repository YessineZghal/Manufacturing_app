'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCircle2,
  ChartLine,
  CircleDashed,
  ChevronRight,
  Cpu,
  Factory,
  FileCheck2,
  FlaskConical,
  Gauge,
  LifeBuoy,
  LoaderCircle,
  OctagonAlert,
  Play,
  Radio,
  RotateCcw,
  ShieldCheck,
  SquareTerminal,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import type { State, Trace, Fault, Incident, Assessment } from '../lib/maintenance/domain';
import { RECOMMENDATION, type Health } from '../lib/maintenance/model';
import { RECOVERY_TIME_OBJECTIVE_MS } from '../lib/maintenance/report';
type Snapshot = Omit<State, 'engines'> & {
  engines: (State['engines'][number] & { remaining: number; latest: Assessment | null })[];
  serviceAvailable: boolean;
  model: {
    id: string;
    dataset: string;
    algorithm: string;
    sensors: string[];
    window: number;
    rulCap: number;
    evaluation: { rmse: number; mae: number; phmScore: number; units: number; split: string };
    thresholds: { criticalRul: number; watchRul: number };
    verification: { referenceEngine: string; actualRul: number; toleranceCycles: number };
  };
};
const scenarios = [
  {
    id: 'model_unavailable',
    title: 'RUL model reference unavailable',
    description:
      'The model registry points to a missing artifact. Restore the validated FD001 model.',
  },
  {
    id: 'gateway_paused',
    title: 'Sensor gateway paused',
    description: 'Resume a paused gateway that stops sensor cycles from reaching the RUL service.',
  },
  {
    id: 'unknown_dependency',
    title: 'Unrecognized plant dependency failure',
    description:
      'Outside the repair allowlist. The agent must escalate without changing configuration.',
  },
];
const healthTone: Record<Health, string> = { healthy: 'good', watch: 'warn', critical: 'bad' };
const healthLabel: Record<Health, string> = {
  healthy: 'Healthy',
  watch: 'Watch',
  critical: 'Critical',
};
const healthIcon: Record<Health, React.ReactNode> = {
  healthy: <CheckCircle2 size={12} aria-hidden />,
  watch: <TriangleAlert size={12} aria-hidden />,
  critical: <OctagonAlert size={12} aria-hidden />,
};
/** The model cannot see beyond its training cap, so a capped prediction means "at least". */
const rulText = (rul: number, cap: number) => (rul >= cap ? `≥ ${cap}` : String(rul));
const time = (n: number) => new Date(n).toLocaleTimeString('en-GB', { hour12: false });
const elapsed = (n: number) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`);
const pause = (n: number) => new Promise(r => setTimeout(r, n));
export default function Home() {
  const [s, setS] = useState<Snapshot | null>(null),
    [view, setView] = useState('workspace'),
    [busy, setBusy] = useState(''),
    [fault, setFault] = useState<Fault>('model_unavailable'),
    [engine, setEngine] = useState('unit-25'),
    [notice, setNotice] = useState(''),
    [trace, setTrace] = useState<Trace | null>(null),
    [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    const r = await fetch('/api/workspace');
    if (!r.ok) throw new Error('Workspace unavailable. Reload to reconnect.');
    const data = (await r.json()) as Snapshot;
    setS(data);
    return data;
  }, []);
  const post = async (path: string, body: unknown, key?: string) =>
    fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
      body: JSON.stringify(body),
    });
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await post('/api/session', {});
        if (!r.ok) throw new Error('The demonstration is temporarily unavailable or at capacity.');
        if (live) await refresh();
      } catch (e) {
        if (live) setNotice((e as Error).message);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (
      !s?.incident ||
      !['detecting', 'alerted', 'diagnosing', 'verifying'].includes(s.incident.status)
    )
      return;
    const t = setInterval(() => {
      refresh().catch(() => {});
    }, 1000);
    return () => clearInterval(t);
  }, [s?.incident?.status, refresh]); // eslint-disable-line react-hooks/exhaustive-deps -- poll only while the incident status changes
  async function ingest() {
    setBusy('ingest');
    try {
      const r = await post('/api/assessments', { engineId: engine }, crypto.randomUUID());
      const b = (await r.json()) as { code?: string; error?: string };
      setNotice(
        r.ok
          ? 'Assessment recorded and saved.'
          : `Assessment unavailable: ${String(b.code || b.error).replaceAll('_', ' ')}.`,
      );
      await refresh();
    } catch {
      setNotice('Connection interrupted. Refresh before retrying.');
    } finally {
      setBusy('');
    }
  }
  async function drill(guided: boolean) {
    setBusy('drill');
    setNotice('');
    try {
      const r = await post('/api/drills', { kind: fault });
      if (!r.ok) {
        const b = (await r.json()) as { code?: string; error?: string };
        throw new Error(String(b.code || b.error).replaceAll('_', ' '));
      }
      await refresh();
      if (!guided) {
        setNotice(
          'Fault active. Try ingesting a cycle: three unavailable attempts trigger the responder.',
        );
        return;
      }
      for (let n = 0; n < 3; n++) {
        await pause(250);
        const p = await post('/api/probe', {}, crypto.randomUUID());
        if (p.status !== 503) throw new Error('Unexpected drill result. Inspect telemetry.');
        await refresh();
      }
      setNotice(
        'Three failed API probes triggered the alert. The responder is evaluating the incident.',
      );
      for (let n = 0; n < 45; n++) {
        await pause(700);
        const next = await refresh();
        if (
          next.incident &&
          ['recovered', 'escalated', 'cancelled'].includes(next.incident.status)
        ) {
          setNotice(
            next.incident.status === 'recovered'
              ? 'Recovery verified: the golden engine was scored accurately and invalid input was rejected.'
              : 'Engineer review required. The agent has not claimed recovery.',
          );
          break;
        }
      }
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function restore() {
    setBusy('restore');
    try {
      const r = await post('/api/restore', {});
      if (!r.ok) throw new Error();
      await refresh();
      setNotice('Pipeline restored manually. Existing assessments are preserved.');
    } catch {
      setNotice('Restore failed. Refresh and retry.');
    } finally {
      setBusy('');
    }
  }
  const incident = s?.incident,
    blocked = !!incident && !['recovered', 'cancelled'].includes(incident.status);
  const total = s ? s.metrics.operatorGood + s.metrics.operatorBad : 0,
    last = [...(s?.history || []), ...(incident ? [incident] : [])]
      .filter(i => i.status === 'recovered')
      .at(-1);
  const label = (id: string) => s?.engines.find(e => e.id === id)?.label ?? id;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-mark">
            <Factory size={23} />
          </span>
          <span>
            Predictive Maintenance<small>LABORATORY</small>
          </span>
        </a>
        <div className="nav-label">CONTROL ROOM</div>
        <nav aria-label="Main navigation">
          {[
            { id: 'workspace', name: 'Maintenance workspace', icon: <FlaskConical size={18} /> },
            { id: 'telemetry', name: 'Assessment telemetry', icon: <Activity size={18} /> },
            { id: 'evidence', name: 'Recovery evidence', icon: <FileCheck2 size={18} /> },
          ].map(v => (
            <button
              className={`nav-item ${view === v.id ? 'active' : ''}`}
              aria-current={view === v.id ? 'page' : undefined}
              key={v.id}
              onClick={() => setView(v.id)}
            >
              {v.icon}
              {v.name}
            </button>
          ))}
        </nav>
        <div className="nav-label secondary-label">PROJECT</div>
        <nav aria-label="Project navigation">
          <a className="nav-item" href="/guide">
            <LifeBuoy size={18} />
            Field guide
          </a>
          <a className="nav-item" href="/report">
            <FileCheck2 size={18} />
            Executive report
          </a>
          <a className="nav-item" href="/tracker">
            <SquareTerminal size={18} />
            Public task tracker
          </a>
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={20} />
          <strong>Your own isolated plant</strong>
          <p>
            NASA C-MAPSS FD001 engines. Persistent assessments. Faults stay inside your workspace.
          </p>
          <small>24-hour workspace retention</small>
        </div>
        <div className="sidebar-footer">
          Built to make recovery inspectable.<span>English · Reproducible source</span>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span className="breadcrumb">
            Plant operations <ChevronRight size={13} />
            <strong>
              {view === 'workspace'
                ? 'Maintenance workspace'
                : view === 'telemetry'
                  ? 'Assessment telemetry'
                  : 'Recovery evidence'}
            </strong>
          </span>
          <span className="environment">
            <span />
            ISOLATED DEMO
          </span>
        </header>
        <main id="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">PREDICTIVE MAINTENANCE, WITH EVIDENCE</div>
              <h1>
                {view === 'workspace'
                  ? 'Prove the prediction works.'
                  : view === 'telemetry'
                    ? 'Follow the request.'
                    : 'Inspect the recovery.'}
              </h1>
              <p>
                {view === 'workspace'
                  ? 'Ingest engine sensor cycles. Introduce a controlled fault. Watch a bounded agent restore the RUL pipeline.'
                  : view === 'telemetry'
                    ? 'Metrics, spans and structured logs meet at the same trace ID.'
                    : 'Every diagnosis, permitted action and verification result is recorded.'}
              </p>
            </div>
            <a className="button secondary export-top" href="/api/evidence">
              <ArrowDownToLine size={16} />
              Export evidence
            </a>
          </div>
          {/* Always mounted so screen readers announce each new message. */}
          <div role="status">
            {notice && (
              <div className="notice">
                <Activity size={17} />
                <span>{notice}</span>
                <button aria-label="Dismiss message" onClick={() => setNotice('')}>
                  ×
                </button>
              </div>
            )}
          </div>
          {loading ? (
            <div className="loading">
              <LoaderCircle className="spin" />
              Preparing your persistent plant workspace…
            </div>
          ) : !s ? (
            <div className="panel empty">
              <h2>Workspace unavailable</h2>
              <button className="button" onClick={() => location.reload()}>
                Try again
              </button>
            </div>
          ) : (
            <>
              <section className="stats-grid" aria-label="Observed metrics">
                <Stat
                  label="RUL assessment journey"
                  value={s.serviceAvailable ? 'Available' : 'Interrupted'}
                  detail="Process health can remain green during a prediction failure."
                  icon={<Radio size={18} />}
                  tone={s.serviceAvailable ? 'good' : 'bad'}
                />
                <Stat
                  label="Operator assessment success"
                  value={total ? `${Math.round((100 * s.metrics.operatorGood) / total)}%` : '—'}
                  detail={`${s.metrics.operatorGood} successful / ${total} valid attempts · probes excluded`}
                  icon={<Gauge size={18} />}
                />
                <Stat
                  label="Verified recoveries"
                  value={String(s.metrics.recoveries)}
                  detail={
                    last
                      ? `Last recovery ${elapsed(last.completedAt! - last.openedAt)} from fault to verification · ${last.completedAt! - last.openedAt <= RECOVERY_TIME_OBJECTIVE_MS ? 'within' : 'outside'} the 15-min objective`
                      : 'A configuration change alone is not a recovery.'
                  }
                  icon={<ShieldCheck size={18} />}
                />
              </section>
              {view === 'workspace' && (
                <>
                  <section className="panel service-map">
                    <div className="section-heading">
                      <div>
                        <span className="eyebrow">CRITICAL JOURNEY</span>
                        <h2>RUL assessment pipeline</h2>
                      </div>
                      <span className="badge neutral">Workspace {s.id.slice(0, 8)}</span>
                    </div>
                    <div className="dependency-flow">
                      <Dependency
                        title="Engine sensors"
                        subtitle="FD001 historian replay"
                        ready
                        icon={<Activity size={20} />}
                      />
                      <ArrowRight className="flow-arrow" size={20} />
                      <Dependency
                        title="Sensor gateway"
                        subtitle={
                          s.config.gateway === 'streaming' ? 'Streaming cycles' : 'Gateway paused'
                        }
                        ready={s.config.gateway === 'streaming'}
                        icon={<Radio size={20} />}
                      />
                      <ArrowRight className="flow-arrow" size={20} />
                      <Dependency
                        title="RUL model"
                        subtitle={s.config.model}
                        ready={s.config.model === s.model.id}
                        icon={<Cpu size={20} />}
                      />
                    </div>
                    <div className="service-caption">
                      <span>● Configuration revision {s.config.revision}</span>
                      <span>
                        FD001 test RMSE {s.model.evaluation.rmse} cycles · MAE{' '}
                        {s.model.evaluation.mae}
                      </span>
                    </div>
                  </section>
                  <div className="work-grid">
                    <section className="panel">
                      <div className="section-heading">
                        <div>
                          <span className="eyebrow">01 / ESTABLISH A BASELINE</span>
                          <h2>Assess an engine</h2>
                        </div>
                        <span className="badge neutral">NASA C-MAPSS FD001</span>
                      </div>
                      <p className="section-description">
                        Ingest the next recorded sensor cycle. The model predicts remaining useful
                        life and the assessment is saved in this lab’s database.
                      </p>
                      <fieldset className="engine-list">
                        <legend className="sr-only">Choose an engine</legend>
                        {s.engines.map(item => (
                          <label
                            className={`engine-option ${engine === item.id ? 'selected' : ''}`}
                            key={item.id}
                          >
                            <input
                              type="radio"
                              name="engine"
                              checked={engine === item.id}
                              disabled={!item.remaining}
                              onChange={() => setEngine(item.id)}
                            />
                            <Wrench size={18} />
                            <span>
                              <strong>{item.label}</strong>
                              <small>
                                {item.latest
                                  ? `Cycle ${item.latest.cycle} · RUL ${rulText(item.latest.predictedRul, s.model.rulCap)} predicted`
                                  : `FD001 test unit ${item.unit} · not yet assessed`}
                              </small>
                            </span>
                            <span className="engine-capacity">{item.remaining} cycles left</span>
                          </label>
                        ))}
                      </fieldset>
                      <button
                        className="button full"
                        disabled={
                          busy === 'ingest' || !s.engines.find(v => v.id === engine)?.remaining
                        }
                        onClick={ingest}
                      >
                        {busy === 'ingest' ? (
                          <LoaderCircle className="spin" size={17} />
                        ) : (
                          <Check size={17} />
                        )}
                        Ingest next cycle
                      </button>
                      <div className="assessment-list">
                        <span className="eyebrow">SAVED ASSESSMENTS</span>
                        {!s.assessments.some(r => !r.probe) ? (
                          <p className="muted">Your first assessment will appear here.</p>
                        ) : (
                          s.assessments
                            .filter(r => !r.probe)
                            .slice(-4)
                            .reverse()
                            .map(r => (
                              <div className="assessment" key={r.id}>
                                <CheckCircle2 size={16} />
                                <span>
                                  {label(r.engineId)} · RUL{' '}
                                  {rulText(r.predictedRul, s.model.rulCap)}
                                  <small>
                                    Cycle {r.cycle} · actual {r.actualRul} · {time(r.createdAt)}
                                  </small>
                                </span>
                                <StatusBadge health={r.health} />
                              </div>
                            ))
                        )}
                      </div>
                    </section>
                    <section className="panel drill-panel">
                      <div className="section-heading">
                        <div>
                          <span className="eyebrow">02 / TEST THE RECOVERY</span>
                          <h2>Introduce a controlled fault</h2>
                        </div>
                        <FlaskConical size={21} />
                      </div>
                      <p className="section-description">
                        The guided drill sends three real API probes. Failed assessments trigger the
                        responder.
                      </p>
                      <label className="field-label" htmlFor="fault">
                        Failure scenario
                      </label>
                      <select
                        id="fault"
                        value={fault}
                        disabled={!!busy || blocked}
                        onChange={e => setFault(e.target.value as Fault)}
                      >
                        {scenarios.map(f => (
                          <option key={f.id} value={f.id}>
                            {f.title}
                          </option>
                        ))}
                      </select>
                      <div className="scenario-description">
                        <TriangleAlert size={19} />
                        <p>{scenarios.find(f => f.id === fault)?.description}</p>
                      </div>
                      <div className="guardrails">
                        <span>
                          <Check size={14} />
                          Session-scoped fault
                        </span>
                        <span>
                          <Check size={14} />
                          Existing assessments preserved
                        </span>
                        <span>
                          <Check size={14} />
                          Two allowlisted repairs
                        </span>
                      </div>
                      <button
                        className="button full"
                        onClick={() => drill(true)}
                        disabled={!!busy || blocked}
                      >
                        {busy === 'drill' ? (
                          <LoaderCircle className="spin" size={17} />
                        ) : (
                          <Play size={16} />
                        )}
                        Run guided recovery drill
                      </button>
                      <div className="drill-secondary">
                        <button
                          className="text-button"
                          onClick={() => drill(false)}
                          disabled={!!busy || blocked}
                        >
                          Inject fault only
                        </button>
                        <button
                          className="text-button"
                          onClick={restore}
                          // Also offered after an escalation with a healthy configuration, for
                          // example a failed verification, so the incident can always be closed.
                          disabled={!!busy || (s.serviceAvailable && !blocked)}
                        >
                          <RotateCcw size={13} />
                          Restore manually
                        </button>
                      </div>
                      <div className="agent-note">
                        <ShieldCheck size={18} />
                        <p>
                          <strong>Bounded on-call agent</strong>Observe → diagnose → repair → verify
                          accuracy. Unsupported states require engineer review.
                        </p>
                      </div>
                    </section>
                  </div>
                  <RulTrajectory
                    engine={s.engines.find(e => e.id === engine) ?? s.engines[0]}
                    assessments={s.assessments.filter(a => !a.probe && a.engineId === engine)}
                    cap={s.model.rulCap}
                    thresholds={s.model.thresholds}
                  />
                  <section className="panel">
                    <div className="section-heading">
                      <div>
                        <span className="eyebrow">FLEET HEALTH</span>
                        <h2>Maintenance board</h2>
                      </div>
                      <span className="badge neutral plain">
                        Critical ≤ {s.model.thresholds.criticalRul} · Watch ≤{' '}
                        {s.model.thresholds.watchRul} cycles
                      </span>
                    </div>
                    <FleetSummary engines={s.engines} />
                    <div className="table-scroll">
                      <table className="board">
                        <thead>
                          <tr>
                            <th>Engine</th>
                            <th>Cycle</th>
                            <th>Predicted RUL</th>
                            <th>Actual RUL</th>
                            <th>Health</th>
                            <th>Recommendation</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.engines.map(e => (
                            <tr key={e.id}>
                              <td>{e.label}</td>
                              <td>{e.latest?.cycle ?? '—'}</td>
                              <td>
                                {e.latest ? (
                                  <RulMeter
                                    rul={e.latest.predictedRul}
                                    cap={s.model.rulCap}
                                    health={e.latest.health}
                                  />
                                ) : (
                                  '—'
                                )}
                              </td>
                              <td>{e.latest?.actualRul ?? '—'}</td>
                              <td>
                                {e.latest ? (
                                  <StatusBadge health={e.latest.health} />
                                ) : (
                                  <span className="badge neutral">Not assessed</span>
                                )}
                              </td>
                              <td>{e.latest ? RECOMMENDATION[e.latest.health] : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                  <Timeline incident={incident || null} />
                </>
              )}
              {view === 'telemetry' && (
                <section className="panel">
                  <div className="section-heading">
                    <div>
                      <span className="eyebrow">COLLECTED AND STORED</span>
                      <h2>Assessment request traces</h2>
                    </div>
                    <div className="heading-actions">
                      <span className="badge neutral">{s.traces.length} retained</span>
                      <a className="text-button" href="/api/telemetry/otlp">
                        <ArrowDownToLine size={13} />
                        OpenTelemetry (OTLP)
                      </a>
                    </div>
                  </div>
                  <p className="section-description">
                    Select a request to correlate its span, log and metric. The latest 120 traces
                    are retained and can be downloaded in OpenTelemetry format; when a collector is
                    configured, each request is also exported live. Cookies, credentials, sensor
                    values and request payloads are excluded.
                  </p>
                  {!s.traces.length ? (
                    <div className="empty muted">
                      Ingest a cycle or run a drill to collect telemetry.
                    </div>
                  ) : (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Time</th>
                            <th>Journey</th>
                            <th>Outcome</th>
                            <th>Duration</th>
                            <th>Trace ID</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.traces
                            .slice()
                            .reverse()
                            .map(t => (
                              <tr key={t.traceId}>
                                <td>{time(t.at)}</td>
                                <td>
                                  {t.metric.journey === 'synthetic_probe'
                                    ? 'Synthetic probe'
                                    : 'Operator assessment'}
                                </td>
                                <td>
                                  <span
                                    className={`badge ${t.status < 300 ? 'good' : t.status >= 500 ? 'bad' : 'neutral'}`}
                                  >
                                    {t.status} · {t.metric.outcome}
                                  </span>
                                </td>
                                <td>{elapsed(t.durationMs)}</td>
                                <td>
                                  <button className="trace-link" onClick={() => setTrace(t)}>
                                    {t.traceId.slice(0, 12)} <ChevronRight size={12} />
                                  </button>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {trace && (
                    <div className="trace-detail">
                      <div className="section-heading">
                        <h3>Correlated signals</h3>
                        <button className="text-button" onClick={() => setTrace(null)}>
                          Close
                        </button>
                      </div>
                      <code className="trace-id">trace_id: {trace.traceId}</code>
                      <div className="signal-grid">
                        <Signal
                          title="Trace span"
                          data={{
                            trace_id: trace.traceId,
                            span_id: trace.spanId,
                            name: trace.span,
                            duration_ms: trace.durationMs,
                            status: trace.status,
                          }}
                        />
                        <Signal
                          title="Structured log"
                          data={{ trace_id: trace.traceId, ...trace.log }}
                        />
                        <Signal
                          title="Metric + exemplar"
                          data={{ trace_id: trace.traceId, ...trace.metric }}
                        />
                      </div>
                    </div>
                  )}
                </section>
              )}
              {view === 'evidence' && (
                <>
                  <section className="panel evidence-intro">
                    <div>
                      <span className="eyebrow">EVIDENCE, NOT ASSUMPTIONS</span>
                      <h2>What does “recovered” mean?</h2>
                      <p>
                        A known-good configuration was restored, the golden reference engine was
                        scored within {s.model.verification.toleranceCycles} cycles of its true RUL
                        and persisted, and an invalid request was still rejected.
                      </p>
                    </div>
                    <div className="verification-checks">
                      <span>
                        <CheckCircle2 size={18} />
                        Golden-engine probe: HTTP 201
                      </span>
                      <span>
                        <CheckCircle2 size={18} />
                        Invalid-engine probe: HTTP 422
                      </span>
                      <span>
                        <CheckCircle2 size={18} />
                        Prediction persisted and accurate
                      </span>
                    </div>
                  </section>
                  <Timeline incident={incident || null} />
                  <section className="panel">
                    <div className="section-heading">
                      <div>
                        <span className="eyebrow">MODEL CARD</span>
                        <h2>{s.model.id}</h2>
                      </div>
                      <span className="badge neutral">{s.model.evaluation.units} test engines</span>
                    </div>
                    <p className="section-description">
                      {s.model.dataset}. {s.model.algorithm}; RUL capped at {s.model.rulCap} cycles.
                      Evaluation: {s.model.evaluation.split} — RMSE {s.model.evaluation.rmse}, MAE{' '}
                      {s.model.evaluation.mae}, PHM08 score {s.model.evaluation.phmScore}.
                      Verification engine: {s.model.verification.referenceEngine}, true RUL{' '}
                      {s.model.verification.actualRul}.
                    </p>
                  </section>
                  <section className="panel">
                    <h2>Previous experiments</h2>
                    {s.history.length ? (
                      s.history
                        .slice()
                        .reverse()
                        .map(i => (
                          <div className="history-row" key={i.id}>
                            <span>
                              <strong>{scenarios.find(f => f.id === i.kind)?.title}</strong>
                              <small>
                                {time(i.openedAt)} · {i.id.slice(0, 8)}
                              </small>
                            </span>
                            <span
                              className={`badge ${i.status === 'recovered' ? 'good' : 'neutral'}`}
                            >
                              {i.status}
                            </span>
                          </div>
                        ))
                    ) : (
                      <p className="section-description">
                        Completed experiments move here when the next drill starts.
                      </p>
                    )}
                  </section>
                </>
              )}
              <footer className="main-footer">
                <span>
                  Controlled laboratory · NASA C-MAPSS FD001 replay · no production plant claim
                </span>
                <a href="/guide">
                  Read the methodology <ArrowRight size={13} />
                </a>
              </footer>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
function StatusBadge({ health }: { health: Health }) {
  return (
    <span className={`badge ${healthTone[health]}`}>
      {healthIcon[health]}
      {health}
    </span>
  );
}
function FleetSummary({ engines }: { engines: Snapshot['engines'] }) {
  const count = (h: Health) => engines.filter(e => e.latest?.health === h).length;
  const pending = engines.filter(e => !e.latest).length;
  const tiles: {
    key: string;
    label: string;
    value: number;
    icon: React.ReactNode;
    tone: string;
  }[] = [
    {
      key: 'critical',
      label: 'Critical',
      value: count('critical'),
      icon: healthIcon.critical,
      tone: 'bad',
    },
    { key: 'watch', label: 'Watch', value: count('watch'), icon: healthIcon.watch, tone: 'warn' },
    {
      key: 'healthy',
      label: 'Healthy',
      value: count('healthy'),
      icon: healthIcon.healthy,
      tone: 'good',
    },
    {
      key: 'pending',
      label: 'Not assessed',
      value: pending,
      icon: <CircleDashed size={12} aria-hidden />,
      tone: 'neutral',
    },
  ];
  return (
    <ul className="fleet-summary" aria-label="Fleet health summary">
      {tiles.map(t => (
        <li key={t.key} className={`fleet-tile ${t.tone}`}>
          <span className="fleet-tile-label">
            {t.icon}
            {t.label}
          </span>
          <strong>{t.value}</strong>
          <small>{t.value === 1 ? 'engine' : 'engines'}</small>
        </li>
      ))}
    </ul>
  );
}
function RulMeter({ rul, cap, health }: { rul: number; cap: number; health: Health }) {
  return (
    <span className="rul-meter">
      <span className="rul-value">{rulText(rul, cap)}</span>
      <span className={`rul-track ${healthTone[health]}`} aria-hidden>
        <span style={{ width: `${Math.max(3, Math.min(100, (rul / cap) * 100))}%` }} />
      </span>
    </span>
  );
}
/** Predicted vs actual RUL across the ingested cycles of one engine. */
function RulTrajectory({
  engine,
  assessments,
  cap,
  thresholds,
}: {
  engine: Snapshot['engines'][number];
  assessments: Assessment[];
  cap: number;
  thresholds: { criticalRul: number; watchRul: number };
}) {
  const frame = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(280, entry.contentRect.width)),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const points = [...assessments].sort((a, b) => a.cycle - b.cycle);
  const height = 240,
    pad = { top: 16, right: width < 480 ? 86 : 104, bottom: 28, left: 40 };
  const top = Math.max(cap, ...points.map(p => p.actualRul));
  const yMax = Math.ceil((top + 5) / 40) * 40;
  const firstCycle = points[0]?.cycle ?? 0,
    lastCycle = points.at(-1)?.cycle ?? 1;
  const span = Math.max(1, lastCycle - firstCycle);
  const x = (cycle: number) =>
    points.length < 2
      ? pad.left + (width - pad.left - pad.right) / 2
      : pad.left + ((cycle - firstCycle) / span) * (width - pad.left - pad.right);
  const y = (rul: number) => pad.top + (1 - rul / yMax) * (height - pad.top - pad.bottom);
  const path = (key: 'predictedRul' | 'actualRul') =>
    points
      .map((p, i) => `${i ? 'L' : 'M'}${x(p.cycle).toFixed(1)},${y(p[key]).toFixed(1)}`)
      .join('');
  const last = points.at(-1);
  const shown = active === null ? null : points[active];
  const pick = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || !points.length) return;
    const px = clientX - rect.left;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(x(p.cycle) - px) < Math.abs(x(points[best].cycle) - px)) best = i;
    });
    setActive(best);
  };
  const ticks = Array.from({ length: yMax / 40 + 1 }, (_, i) => i * 40);
  const endLabels = last
    ? (() => {
        const a = {
          text: `Predicted ${rulText(last.predictedRul, cap)}`,
          y: y(last.predictedRul),
          cls: 'predicted',
        };
        const b = { text: `Actual ${last.actualRul}`, y: y(last.actualRul), cls: 'actual' };
        // Keep the two end labels apart without detaching them from their lines.
        if (Math.abs(a.y - b.y) < 14) {
          const mid = (a.y + b.y) / 2;
          const up = a.y <= b.y ? a : b;
          const down = up === a ? b : a;
          up.y = mid - 8;
          down.y = mid + 8;
        }
        return [a, b];
      })()
    : [];
  return (
    <section className="panel trajectory-panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">RUL TRAJECTORY</span>
          <h2>{engine.label}: predicted vs actual remaining life</h2>
        </div>
        <ul className="chart-legend" aria-label="Legend">
          <li>
            <span className="line-key predicted" aria-hidden />
            Predicted RUL
          </li>
          <li>
            <span className="line-key actual" aria-hidden />
            Actual RUL (FD001 ground truth)
          </li>
        </ul>
      </div>
      <div className="chart-frame" ref={frame}>
        {!points.length ? (
          <div className="timeline-empty">
            <ChartLine size={28} />
            <div>
              <h3>No cycles ingested for {engine.label} yet.</h3>
              <p>Each ingested cycle adds one predicted and one actual point to this chart.</p>
            </div>
          </div>
        ) : (
          <>
            <div
              className="chart-box"
              ref={box}
              tabIndex={0}
              role="img"
              aria-label={`${engine.label}: ${points.length} cycles. Latest cycle ${last!.cycle}, predicted RUL ${rulText(last!.predictedRul, cap)}, actual ${last!.actualRul}. Use the arrow keys to read each cycle.`}
              onPointerMove={e => pick(e.clientX)}
              onPointerLeave={() => setActive(null)}
              onBlur={() => setActive(null)}
              onKeyDown={e => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                const step = e.key === 'ArrowLeft' ? -1 : 1;
                setActive(i =>
                  Math.min(points.length - 1, Math.max(0, (i ?? points.length) + step)),
                );
              }}
            >
              {width > 0 && (
                <svg width={width} height={height} aria-hidden>
                  {ticks.map(t => (
                    <g key={t}>
                      <line
                        className="grid"
                        x1={pad.left}
                        x2={width - pad.right}
                        y1={y(t)}
                        y2={y(t)}
                      />
                      <text className="tick" x={pad.left - 8} y={y(t) + 3} textAnchor="end">
                        {t}
                      </text>
                    </g>
                  ))}
                  {[
                    { v: thresholds.watchRul, label: 'Watch' },
                    { v: thresholds.criticalRul, label: 'Critical' },
                  ].map(t => (
                    <g key={t.label}>
                      <line
                        className="threshold"
                        x1={pad.left}
                        x2={width - pad.right}
                        y1={y(t.v)}
                        y2={y(t.v)}
                      />
                      <text className="threshold-label" x={pad.left + 6} y={y(t.v) - 5}>
                        {t.label} ≤ {t.v}
                      </text>
                    </g>
                  ))}
                  {[firstCycle, lastCycle]
                    .filter((c, i, all) => all.indexOf(c) === i)
                    .map(c => (
                      <text key={c} className="tick" x={x(c)} y={height - 8} textAnchor="middle">
                        Cycle {c}
                      </text>
                    ))}
                  {shown && (
                    <line
                      className="crosshair"
                      x1={x(shown.cycle)}
                      x2={x(shown.cycle)}
                      y1={pad.top}
                      y2={height - pad.bottom}
                    />
                  )}
                  <path className="series actual" d={path('actualRul')} />
                  <path className="series predicted" d={path('predictedRul')} />
                  {last && (
                    <>
                      <circle
                        className="dot actual"
                        cx={x(last.cycle)}
                        cy={y(last.actualRul)}
                        r={4}
                      />
                      <circle
                        className="dot predicted"
                        cx={x(last.cycle)}
                        cy={y(last.predictedRul)}
                        r={4}
                      />
                    </>
                  )}
                  {shown && shown !== last && (
                    <>
                      <circle
                        className="dot actual"
                        cx={x(shown.cycle)}
                        cy={y(shown.actualRul)}
                        r={4}
                      />
                      <circle
                        className="dot predicted"
                        cx={x(shown.cycle)}
                        cy={y(shown.predictedRul)}
                        r={4}
                      />
                    </>
                  )}
                  {endLabels.map(l => (
                    <text key={l.cls} className="end-label" x={x(last!.cycle) + 10} y={l.y + 4}>
                      {l.text}
                    </text>
                  ))}
                </svg>
              )}
              {shown && (
                <div
                  className="chart-tooltip"
                  role="status"
                  style={{
                    left: Math.min(width - 190, Math.max(0, x(shown.cycle) + 12)),
                    top: 8,
                  }}
                >
                  <span className="tooltip-title">Cycle {shown.cycle}</span>
                  <span>
                    <span className="line-key predicted" aria-hidden />
                    <strong>{rulText(shown.predictedRul, cap)}</strong> predicted
                  </span>
                  <span>
                    <span className="line-key actual" aria-hidden />
                    <strong>{shown.actualRul}</strong> actual
                  </span>
                  <span className="tooltip-meta">
                    Error {Math.round(Math.abs(shown.predictedRul - shown.actualRul) * 10) / 10}{' '}
                    cycles · {healthLabel[shown.health]}
                  </span>
                </div>
              )}
            </div>
            <details className="chart-data">
              <summary>Show the data table</summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Cycle</th>
                      <th>Predicted RUL</th>
                      <th>Actual RUL</th>
                      <th>Error</th>
                      <th>Health</th>
                    </tr>
                  </thead>
                  <tbody>
                    {points.map(p => (
                      <tr key={p.id}>
                        <td>{p.cycle}</td>
                        <td>{rulText(p.predictedRul, cap)}</td>
                        <td>{p.actualRul}</td>
                        <td>{Math.round(Math.abs(p.predictedRul - p.actualRul) * 10) / 10}</td>
                        <td>{healthLabel[p.health]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </div>
    </section>
  );
}
function Stat({
  label,
  value,
  detail,
  icon,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className={`stat-card ${tone || ''}`}>
      <div className="stat-label">
        {label}
        {icon}
      </div>
      <div className="stat-value">
        {tone && <span className="status-dot" />}
        {value}
      </div>
      <p>{detail}</p>
    </div>
  );
}
function Dependency({
  title,
  subtitle,
  ready,
  icon,
}: {
  title: string;
  subtitle: string;
  ready: boolean;
  icon: React.ReactNode;
}) {
  return (
    <div className={`dependency ${ready ? '' : 'impaired'}`}>
      <span className="dependency-icon">{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{subtitle}</small>
      </span>
      <span className="dependency-status" />
    </div>
  );
}
function Timeline({ incident: i }: { incident: Incident | null }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">03 / INSPECT THE OUTCOME</span>
          <h2>Recovery timeline</h2>
        </div>
        <span
          className={`badge ${i?.status === 'recovered' ? 'good' : i?.status === 'escalated' ? 'bad' : 'neutral'}`}
        >
          {i?.status || 'Ready for an experiment'}
        </span>
      </div>
      {!i ? (
        <div className="timeline-empty">
          <Activity size={28} />
          <div>
            <h3>Your experiment will leave a trail.</h3>
            <p>Fault, alert, diagnosis, repair and verification appear here as they happen.</p>
          </div>
        </div>
      ) : (
        <>
          <div className="incident-meta">
            <span>Incident {i.id.slice(0, 8)}</span>
            <span>Opened {time(i.openedAt)}</span>
            {i.completedAt && <span>Elapsed {elapsed(i.completedAt - i.openedAt)}</span>}
          </div>
          <ol className="timeline">
            {i.steps.map((step, n) => (
              <li key={`${step.at}-${n}`}>
                <span className={`timeline-dot ${step.phase === 'Escalate' ? 'warn' : ''}`}>
                  {step.phase === 'Verify' && step.outcome === 'passed' ? (
                    <Check size={12} />
                  ) : (
                    n + 1
                  )}
                </span>
                <div className="timeline-entry">
                  <div>
                    <strong>{step.phase}</strong>
                    <span className="step-tool">{step.tool}</span>
                    <time>{time(step.at)}</time>
                  </div>
                  <p>{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>
          {i.verification && (
            <div
              className={`verification-result ${i.status === 'recovered' ? 'passed' : 'failed'}`}
            >
              <ShieldCheck size={20} />
              <span>
                <strong>
                  {i.status === 'recovered'
                    ? 'Recovery independently checked'
                    : 'Verification needs review'}
                </strong>
                Positive {i.verification.positive} · Negative {i.verification.negative} · Durable
                record {i.verification.persisted ? 'confirmed' : 'absent'} · Prediction error{' '}
                {i.verification.absoluteError ?? '—'} cycles
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
function Signal({ title, data }: { title: string; data: unknown }) {
  return (
    <div>
      <h3>{title}</h3>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}
