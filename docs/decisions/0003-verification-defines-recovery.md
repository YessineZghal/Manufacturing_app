# 0003 — Verification against the live journey, including prediction accuracy, defines recovery

**Status:** Accepted · **Date:** 2026-11-10

## Context
"The configuration was restored" is often reported as "the pipeline recovered". In predictive maintenance there is a second trap: a pipeline can answer every request successfully while serving a wrong, stale or corrupted model. A fix that disables validation would also make assessments succeed.

## Decision
An incident is *recovered* only when all of the following hold:
- a probe assessment of the golden reference engine (held-out FD001 test unit 91, true RUL 38) returns HTTP 201 and is persisted;
- the persisted prediction is within **15 cycles** of the engine's true RUL (read from the database record, not from the probe response);
- a negative probe with an invalid engine is still rejected with HTTP 422;
- no fault remains.

Probes score the reference engine and never consume fleet cycles. A failed verification escalates. A manual restore is recorded as *cancelled*, never as an agent recovery.

## Alternatives considered
- **Configuration check only.** It does not prove the journey works.
- **Status codes only.** It does not detect a wrong model.
- **Exact match with the release-time prediction.** Stricter, but it would reject legitimate model updates; a ground-truth tolerance tests the property that matters to the planner.

## Consequences
Recovery metrics cannot flatter the automation, and every recovery claim has an accuracy figure attached. The tolerance (15 cycles, below the model's 16.6-cycle test RMSE, with the reference error at 9.1 for `rul-fd001-v2`) must be revisited whenever the model changes.
