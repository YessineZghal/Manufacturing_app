# Strategy, value and roadmap

## The strategic problem

Unplanned downtime is one of the largest controllable costs in asset-intensive manufacturing. Predictive maintenance promises to replace both run-to-failure and fixed-interval maintenance with condition-based decisions, but it only works if two things hold at the same time: **the prediction pipeline is available when planners need it, and the prediction it serves is still right.**

Most plants monitor the infrastructure of their ML pipelines (servers, queues, jobs) instead of the journey that matters: *a planner asks for an engine's remaining useful life and gets a correct answer.* After an incident they can rarely say, with evidence, how quickly that journey recovered, who restored it, or whether the restored model still predicts accurately.

Two shifts make this an executive issue:
- **AI is moving from dashboards into operations.** Leaders need a clear answer to *"what is the agent allowed to do to our maintenance pipeline, and how do we know it did the right thing?"*
- **Model risk is now operational risk.** A silently wrong RUL prediction (late maintenance) is worse than an outage, which at least is visible.

Predictive Maintenance Lab is a reference implementation of the operating model this requires:
1. Measure the planner's journey.
2. Make the model reproducible and its error visible.
3. Automate pipeline recovery within explicit bounds.
4. Verify the outcome against the journey **and** the model's accuracy.
5. Keep the evidence.

It is a working laboratory on a public benchmark, not a plant product.

## Who it serves

| Stakeholder | Question | What the system provides |
|---|---|---|
| Plant manager, COO | Which engines need maintenance, and can we trust the prediction? | A maintenance board with predicted vs true RUL and health bands; an executive report with model quality |
| Head of reliability / maintenance | Are we paging on what matters? | An operator-journey indicator and alert that ignore user errors and infrastructure noise |
| Data / ML lead | Is the model reproducible and guarded? | Deterministic training on committed data, a quality gate and a runtime-reproduction test |
| CDAO, CIO | Where can AI act safely in operations? | Bounded autonomy: allowlist, second opinion, human escalation, audit trail |
| Quality, audit | Can this be reviewed independently? | Exportable JSON and OpenTelemetry evidence, redacted by design |

## Value hypotheses and how they would be measured

These are hypotheses for a pilot. The laboratory demonstrates the mechanism, not the business result.

| Hypothesis | Indicator | Measured by |
|---|---|---|
| Alerting on the assessment journey detects prediction outages that health checks miss | Share of incidents first detected by the journey alert | Alert source per incident |
| Bounded automation shortens time to verified recovery for known pipeline faults | Time from fault to **verified, accurate** recovery | Incident timeline |
| Accuracy-checked verification prevents false recoveries | Incidents marked recovered with a wrong model (target: zero) | Verification record (error vs tolerance) |
| Escalation keeps engineers in control of the unknown | Share of unknown faults escalated (target: 100 %) | Escalation steps |
| Visible model error builds planner trust | Planner override rate when error is shown vs hidden | Pilot study |

## Roadmap

| Horizon | Capability | Why it matters |
|---|---|---|
| **Now** | FD001 fleet, explainable RUL model with a quality gate, three pipeline fault classes, a bounded agent with an AI second opinion, accuracy-checked recovery, executive report, OpenTelemetry evidence, CI/CD and rollback | Demonstrates the full loop end to end, reproducibly |
| **Next** | FD002–FD004 (multiple operating conditions and fault modes) with condition normalisation | Closer to real fleets |
| **Next** | A sequence model (LSTM/CNN) as a second registered model, promoted only if it beats the baseline on the gate | Better recall of the critical band, where the linear model still predicts 13 of 25 near-failure test engines at 31–48 cycles |
| **Next** | A data-drift fault class (sensor bias) detected by the golden engine and by input-distribution checks | Model risk beyond availability |
| **Later** | Maintenance work orders and bay capacity, scheduled from critical assessments | Connects the prediction to the decision |
| **Later** | Live plant data via an OPC UA / MQTT gateway | From laboratory to pilot |

## Principal risks and mitigations

| Risk | Mitigation in the design |
|---|---|
| A wrong RUL prediction leads to late maintenance | Error shown next to every prediction; recovery requires accuracy; predictions support, not replace, engineers |
| An agent applies the wrong fix | Two allowlisted repairs only; revision-checked writes; the model can confirm but never widen authority |
| A "recovered" status is false | Positive, negative, persistence and accuracy checks are required |
| The model silently regresses | Artifacts checked for freshness; RMSE gate in every test run |
| Telemetry leaks data | Payloads, sensor values, cookies and tokens excluded and tested |
| Cost runs away on a public demo | Free tiers; workspace, drill, probe and telemetry caps |
