export default function Guide() {
  return (
    <main className="document-page" id="main-content">
      <a href="/">← Maintenance workspace</a>
      <div className="eyebrow">FIELD GUIDE / VERSION 1</div>
      <h1>Predictions need evidence.</h1>
      <p>
        A green process-health check does not establish that a maintenance planner can get a
        remaining-useful-life (RUL) prediction for an engine. This laboratory makes the gap
        observable, then tests a bounded repair against the same assessment API and checks that the
        restored model still predicts accurately.
      </p>
      <section className="panel">
        <h2>A five-minute experiment</h2>
        <ol>
          <li>
            Select an engine and ingest its next recorded sensor cycle. The assessment, its
            predicted RUL and its health band appear in saved records and on the maintenance board.
          </li>
          <li>
            Run the model-reference drill. Three unavailable API probes produce an operator-impact
            alert.
          </li>
          <li>
            Inspect observation, diagnosis, revision-checked repair and accuracy verification in the
            timeline.
          </li>
          <li>
            Open Assessment telemetry: a trace ID connects a span, structured log and metric
            exemplar.
          </li>
          <li>Export evidence. Refresh: the assessments and incident remain in the database.</li>
          <li>
            Try the unrecognized plant dependency. The correct outcome is escalation; restore
            manually afterward.
          </li>
        </ol>
      </section>
      <section className="panel">
        <h2>The data and the model</h2>
        <p>
          The engines come from the NASA C-MAPSS turbofan degradation benchmark, subset FD001: one
          operating condition and one fault mode (high-pressure compressor degradation). The model
          is trained on the 100 run-to-failure training trajectories and evaluated on the 100
          held-out test trajectories against the published true RUL values. Each fleet engine in the
          lab is a held-out test engine whose final recorded cycles are replayed one at a time, so
          every prediction can be compared with its ground truth.
        </p>
        <p>
          The model is a ridge regression on 30-cycle window means and slopes of 14 informative
          sensors plus the cycle count, with RUL capped at 125 cycles. It is deliberately simple and
          explainable; the training script, the evaluation and the quality gate are part of the test
          suite.
        </p>
      </section>
      <section className="panel">
        <h2>The responder’s authority</h2>
        <p>
          The responder is a tool-using agent with two allowed repairs: point the model registry
          back to the validated model, or resume a paused sensor gateway. In the cloud deployment it
          also asks a language model (Cloudflare Workers AI) for a second opinion, sending only
          three booleans that describe the pipeline. The model can confirm the policy’s choice but
          never widen it: a different answer, a malformed answer or no answer leads to escalation.
          The recovery timeline records which reasoner was used and what the model proposed. When a
          vLLM server is configured, the second opinion comes from Qwen2.5-7B-Instruct served by
          vLLM; without one, the same agent runs on the deterministic policy.
        </p>
        <p>
          Recovery requires a persisted assessment of the golden reference engine whose prediction
          is within 15 cycles of its true RUL, plus an invalid request that remains rejected. A
          pipeline that answers HTTP 201 with a wrong prediction does not count as recovered.
          Unknown states, stale configuration and failed verification escalate. Probes score the
          reference engine and never consume fleet cycles.
        </p>
      </section>
      <section className="panel">
        <h2>Scope and privacy</h2>
        <p>
          A random HttpOnly cookie authorizes each isolated workspace. No personal data is
          requested. Telemetry excludes bodies, sensor values, cookies, credentials and raw
          exceptions. Workspaces expire after 24 hours; traces and experiments are bounded.
        </p>
        <p>
          This controlled laboratory replays a public simulation benchmark. It does not connect to
          plant equipment, certify airworthiness or replace a maintenance engineer’s judgement, and
          it does not establish production savings. Recovery time describes the observed experiment
          only.
        </p>
      </section>
      <section className="panel">
        <h2>Sources</h2>
        <p>
          A. Saxena, K. Goebel, D. Simon and N. Eklund, “Damage Propagation Modeling for Aircraft
          Engine Run-to-Failure Simulation”, PHM08, Denver CO, 2008. Data:{' '}
          <a
            href="https://www.nasa.gov/intelligent-systems-division/discovery-and-systems-health/pcoe/pcoe-data-set-repository/"
            target="_blank"
            rel="noreferrer"
          >
            NASA Prognostics Center of Excellence data set repository
          </a>
          . Architecture adapted from{' '}
          <a
            href="https://github.com/cssaritama/Service-Recovery-Lab"
            target="_blank"
            rel="noreferrer"
          >
            Service Recovery Lab
          </a>
          .
        </p>
      </section>
      <section className="panel">
        <h2>Delivery evidence</h2>
        <p>
          Read the <a href="/tracker">public task tracker</a>. The source package includes
          specifications, architecture decisions, tests, containers, CI/CD workflows, rollback
          instructions, agent work logs and a reviewer guide that maps each capability to its
          evidence.
        </p>
      </section>
    </main>
  );
}
