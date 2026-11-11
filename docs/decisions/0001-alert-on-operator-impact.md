# 0001 — Alert on operator-journey impact, not infrastructure metrics

**Status:** Accepted · **Date:** 2026-11-10

## Context
Process health checks and resource metrics can stay green while maintenance planners fail to get RUL assessments. Error counts that include invalid input page people for problems that are not outages.

## Decision
The service-level indicator is *operator assessment success*. The alert fires after three consecutive server-side (5xx) assessment attempts in a workspace. Validation errors (4xx) and an exhausted replay (409) never count, and any success resets the streak. `/api/health` remains, but only as a process signal.

## Alternatives considered
- **CPU or latency thresholds.** These measure the infrastructure, not the planner.
- **Any error rate.** Operator mistakes create noise and alert fatigue.
- **Burn-rate alerting on an SLO.** This is the right model at scale, but it needs traffic volumes a laboratory does not have. It is on the roadmap.

## Consequences
The alert has a direct business meaning ("planners cannot get RUL predictions"). The threshold is deliberately small so that it can be demonstrated; a plant deployment would tune it against real traffic.
