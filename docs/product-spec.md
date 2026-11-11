# Product specification

Written on 2026-11-10, before domain implementation, from the Service Recovery Lab template. Status: accepted scope.

## Problem and intended user

A successful process-health check does not establish that a maintenance planner can get a remaining-useful-life (RUL) prediction for an engine, or that the prediction is right. Plant data and reliability teams need a repeatable way to observe a broken prediction journey, diagnose a bounded pipeline fault, restore service, prove the restored model is still accurate, and keep evidence of the recovery. This application makes that sequence inspectable in one isolated laboratory.

The initial user is a reliability engineer, data/ML engineer, reviewer or plant operations lead evaluating a predictive-maintenance pipeline. Each visitor receives an isolated persistent workspace. It contains a fleet of six turbofan engines replayed from the NASA C-MAPSS FD001 test set, their RUL assessments, pipeline configuration, telemetry, incident history and responder decisions. No personal details are requested.

## Accepted scope and behaviour

1. A visitor starts a workspace and sees the fleet, the cycles left to ingest per engine and pipeline status. Workspace access uses a random, HttpOnly cookie; a workspace ID alone never authorises access.
2. The visitor ingests the next recorded sensor cycle of an engine. The RUL model predicts remaining useful life from a 30-cycle window; the assessment (cycle, predicted RUL, true RUL, health band) persists, and the engine's remaining cycles decrease atomically. Duplicate requests with the same idempotency key create only one assessment. A reused key with a changed payload is rejected.
3. Health bands: predicted RUL ≤ 30 → *critical* (schedule maintenance now); ≤ 80 → *watch* (plan the next window); otherwise *healthy*. The maintenance board shows the latest assessment of every engine.
4. A controlled drill makes either the RUL model reference unavailable or pauses the sensor gateway for that workspace only. A separate unsupported fault demonstrates safe escalation. Public visitors cannot alter anyone else's workspace or global infrastructure.
5. The assessment journey actually fails during a supported fault. A small bounded probe sequence confirms operator-visible failure. Structured logs, spans and a journey metric share a trace identifier; inputs, sensor values and cookies are excluded.
6. A confirmed failure produces an alert. That alert invokes a responder that observes state, selects an allowlisted repair, applies it with a revision check, and verifies the live journey. Recovery never rewrites existing assessments, changes model weights or disables validation.
7. Unsupported or inconclusive diagnoses are escalated. An old incident cannot overwrite a newer configuration. Duplicate agent invocations do not apply a repair twice.
8. A successful recovery requires an actual persisted assessment of the golden reference engine whose prediction is within 15 cycles of its true RUL, plus a negative validation check. Probe assessments are flagged and score the reference engine, never consuming fleet cycles. Failed verification, including an inaccurate prediction, must not mark an incident recovered.
9. The model is trained by a deterministic script from the committed dataset, evaluated on the 100 held-out test engines, and its artifacts are checked for freshness by the test command. A test-set RMSE of 20 cycles or more fails the build.
10. The evidence view shows the causal timeline, request-level telemetry, agent tool outcomes, recovery duration, preserved assessments and the model card. Export creates a JSON evidence package containing only that workspace's records and sanitised telemetry.
11. Data survives application restart. Retention and workspace caps bound public-demo growth.
12. The public task tracker and documentation show the build process and actual verification status.

## Acceptance scenarios

Happy-path assessment; sequential cycles advance and ground truth counts down; exhausted replay; invalid input; idempotent retry; key/payload conflict; concurrent ingestion race; forged/absent cookie; cross-workspace isolation; restart persistence; model-reference recovery; paused-gateway recovery; unknown-fault escalation; inaccurate-model verification failure; stale repair rejection; concurrent responder invocation; telemetry correlation and absence of secret/payload values; model evaluation reproduced by the runtime; stale model artifacts detected; critical engine shown on the maintenance board; responsive keyboard-operable interface; clean local startup; tests in one command; container start; deployment evidence; CI/CD and rollback configuration.

## Success and limits

Technical success means independently reproducible assessment, model evaluation and recovery behaviour with passing tests and inspectable evidence. It is not measured maintenance savings, reduced downtime, airworthiness, or a validated commercial opportunity. Recovery objectives are lab observations, not production SLO claims. The data is simulated.

Configuration files are not evidence of successful cloud or CI runs.
