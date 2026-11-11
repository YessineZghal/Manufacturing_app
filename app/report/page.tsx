'use client';
import { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import type { ExecutiveReport, Recommendation } from '../../lib/maintenance/report';

const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);
const duration = (ms: number | null) =>
  ms === null
    ? '—'
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : ms < 60000
        ? `${(ms / 1000).toFixed(1)} s`
        : `${(ms / 60000).toFixed(1)} min`;
const badge: Record<Recommendation, { text: string; tone: string }> = {
  expand_autonomy: { text: 'Expand autonomy', tone: 'good' },
  keep_human_review: { text: 'Keep human review', tone: 'bad' },
  human_owned: { text: 'Human-owned', tone: 'neutral' },
  gather_evidence: { text: 'Gather evidence', tone: 'neutral' },
};

export default function Report() {
  const [report, setReport] = useState<ExecutiveReport | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    (async () => {
      // Returns the existing workspace when the cookie is valid, so it is safe to call first.
      const session = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!session.ok) throw new Error('session_unavailable');
      const r = await fetch('/api/report');
      if (!r.ok) throw new Error('report_unavailable');
      setReport(await r.json());
    })().catch(() => setError(true));
  }, []);

  const h = report?.headline;
  const objectiveMin = report ? report.objective.recoveryTimeObjectiveMs / 60000 : 15;
  return (
    <main className="document-page report-page" id="main-content">
      <div className="report-actions">
        <a href="/">← Maintenance workspace</a>
        <button className="button secondary" onClick={() => window.print()}>
          <Printer size={14} />
          Print or save as PDF
        </button>
      </div>
      <div className="eyebrow">EXECUTIVE RESILIENCE REPORT</div>
      <h1>Is the maintenance pipeline resilient, and where can the AI agent act on its own?</h1>
      <p>
        One page for a plant leadership committee. It translates incident evidence into recovery
        against the business objective, operator impact, model quality, and a decision on where
        automated recovery can be trusted. Every figure is computed from the verified incident
        record.
      </p>
      {error && (
        <section className="panel">The report could not be loaded. Refresh to try again.</section>
      )}
      {!report && !error && <section className="panel muted">Compiling the report…</section>}
      {report && h && (
        <>
          <section className="stats-grid report-kpis" aria-label="Headline measures">
            <article className="stat-card">
              <div className="stat-label">Recovery objective met</div>
              <div className="stat-value">{pct(h.objectiveAttainment)}</div>
              <p>
                Verified recoveries within the {objectiveMin}-minute recovery time objective (RTO)
              </p>
            </article>
            <article className="stat-card">
              <div className="stat-label">Median time to verified recovery</div>
              <div className="stat-value">{duration(h.medianTimeToVerifiedRecoveryMs)}</div>
              <p>
                From fault to a proven, accurate assessment · detection{' '}
                {duration(h.medianTimeToDetectMs)} · worst{' '}
                {duration(h.worstTimeToVerifiedRecoveryMs)}
              </p>
            </article>
            <article className="stat-card">
              <div className="stat-label">AI autonomy rate</div>
              <div className="stat-value">{pct(h.autonomyRate)}</div>
              <p>
                {h.autonomousRecoveries} resolved by the agent · {h.escalatedToHumans} escalated to
                humans · {h.operatorRestores} operator restores (never counted as AI success)
              </p>
            </article>
            <article className="stat-card">
              <div className="stat-label">Operator assessment success</div>
              <div className="stat-value">{pct(report.operatorImpact.assessmentSuccessRate)}</div>
              <p>
                {report.operatorImpact.failedOperatorAttempts} failed operator attempts ·{' '}
                {report.operatorImpact.assessmentsPreserved} assessments preserved ·{' '}
                {report.operatorImpact.criticalEngines} critical engine(s)
              </p>
            </article>
          </section>

          <section className="panel">
            <h2>Model quality</h2>
            <p>
              <strong>{report.modelQuality.model}</strong> · offline RMSE{' '}
              {report.modelQuality.offlineRmse} cycles and MAE {report.modelQuality.offlineMae} on{' '}
              {report.modelQuality.offlineUnits} held-out FD001 test engines · live mean absolute
              error{' '}
              {report.modelQuality.liveMae === null
                ? '— (no assessments yet)'
                : `${report.modelQuality.liveMae} cycles over ${report.modelQuality.liveAssessments} assessments`}
            </p>
          </section>

          <section className="panel report-decisions">
            <h2>Decisions for the leadership team</h2>
            <ol>
              {report.decisions.map(d => (
                <li key={d}>{d}</li>
              ))}
            </ol>
            {!h.incidents && (
              <p className="muted">
                <a href="/">Run a guided recovery drill</a> to generate the first evidence.
              </p>
            )}
          </section>

          {report.faultClasses.length > 0 && (
            <section className="panel">
              <h2>Where the agent may act alone</h2>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Failure class</th>
                      <th>Incidents</th>
                      <th>Agent recovered</th>
                      <th>Escalated</th>
                      <th>Median recovery</th>
                      <th>Recommendation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.faultClasses.map(c => (
                      <tr key={c.fault}>
                        <td>
                          <strong>{c.label}</strong>
                          <small className="report-rationale">{c.rationale}</small>
                        </td>
                        <td>{c.incidents}</td>
                        <td>{c.autonomousRecoveries}</td>
                        <td>{c.escalations}</td>
                        <td>{duration(c.medianRecoveryMs)}</td>
                        <td>
                          <span className={`badge ${badge[c.recommendation].tone}`}>
                            {badge[c.recommendation].text}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="panel">
            <h2>How to read this report</h2>
            <ul>
              {report.caveats.map(c => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <p className="task-meta">
              Generated {new Date(report.generatedAt).toLocaleString()} ·{' '}
              <a href="/api/report">machine-readable version</a> ·{' '}
              <a href="/api/evidence">full evidence package</a>
            </p>
          </section>
        </>
      )}
    </main>
  );
}
