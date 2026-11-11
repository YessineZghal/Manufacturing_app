# Agent team and development process

This project was built by a small team: one human owner and AI coding agents with explicit roles. The roles are defined by **responsibility and hand-off**, not by which tool happened to run them. One agent session may play several roles in sequence. When it does, it changes role explicitly and follows that role's rules.

A separate, **runtime** agent (the on-call responder) is part of the product itself. It is described at the end.

## Development team

| Role | Performed by | Responsibilities | Inputs | Outputs | Done when |
|---|---|---|---|---|---|
| **Owner** | Human (repository owner) | Sets goals and constraints: reuse the Predictive Maintenance Lab architecture and components, apply them to manufacturing, use NASA C-MAPSS FD001, zero budget, English. Approves scope and releases. Operates accounts: GitHub, Cloudflare. | Project goals, template repository | Decisions, approvals, credentials (never shared with agents) | Release approved |
| **Product agent** | Coding agent | Research and topic evaluation. Writes the problem statement, specification and acceptance scenarios **before** domain code. Creates tracker tasks. | Owner goals | `docs/product-spec.md`, `public/tracker.json` | Every task has observable acceptance criteria |
| **Implementation agent** | Coding agent | Builds the model training, domain, API, persistence, responder and UI against one tracker task at a time. | Spec, tracker task, `AGENTS.md` | Source code, migrations | Task criteria demonstrably met |
| **Verification agent** | Coding agent (independent session from implementation where possible) | Writes and runs unit, integration and browser tests. Reviews the code against the spec. Reports defects back to implementation. | Spec, code | `tests/`, test results, defect list | All tests pass in one command; defects fixed or recorded |
| **Delivery agent** | Coding agent | Containers, CI/CD, rollback, documentation, evidence capture, submission packaging. | Verified build | `Dockerfile`, `compose.yaml`, workflows, `docs/`, `evidence/` | Reviewer can reproduce every claim from the repository |

## How the team works together

```mermaid
flowchart LR
  O[Owner] -->|goals and constraints| P[Product agent]
  P -->|spec and tracker tasks| O
  O -->|approves scope| I[Implementation agent]
  I -->|code for task N| V[Verification agent]
  V -->|defects| I
  V -->|passing build| D[Delivery agent]
  D -->|package and evidence| O
  O -->|merge, deploy prod| R[(Release)]
```

1. **Spec first.** No domain code before `docs/product-spec.md` and the tracker tasks exist. A behaviour change that is not in the spec starts with a spec update.
2. **One task at a time.** Each agent starts by reading `AGENTS.md`, the spec and the tracker task, then states the expected outcome. It moves the task to `in_progress` and to `done` only when all acceptance criteria are verified.
3. **Evidence over assertion.** A status change must be backed by a test, a command output or a file in `evidence/`. Configuration files do not count as proof that a deployment ran.
4. **Separation of build and review.** The verification role should run from a fresh context (it re-reads the spec, not the implementer's notes) so the work is not graded by its author. In the first build session, implementation and verification ran in the same agent session; an independent review is an open item (see the work log).
5. **Logged hand-offs.** Each session appends what it read, changed and verified to `docs/agent-work-log.md`, including failures.
6. **Human gates.** The owner alone holds credentials, approves the production environment and merges to `main`.

## Agent rules (enforced through `AGENTS.md`)

- Never fabricate collaborators, test results, deployments, model metrics or commercial outcomes.
- Preserve session isolation, cookie authorisation, idempotency, bounded recovery and telemetry redaction.
- Never weaken validation to make a test pass.
- Keep secrets, dependency folders, runtime databases and caches out of commits and archives.
- All product copy and documentation are in English.

## Runtime agent: the on-call responder

| Property | Value |
|---|---|
| Trigger | Operator-impact alert: three consecutive 5xx assessment attempts in a workspace |
| Tools | `read_pipeline_state`, `select_allowlisted_repair`, `restore_model` / `resume_gateway`, `exercise_assessment_api`, `request_engineer_review` |
| Authority | Two configuration repairs, scoped to one workspace, revision-checked |
| Cannot | Edit assessments, change model weights or validation, touch other workspaces, run code, act on unknown faults |
| Reasoner | Deterministic policy plus a language-model second opinion: vLLM serving Qwen2.5-7B-Instruct when configured, otherwise Workers AI in the cloud. Disagreement, malformed output or timeout → escalate. |
| Success | Golden-engine probe 201 **and** invalid-engine probe 422 **and** persisted probe assessment **and** prediction error ≤ 15 cycles **and** no remaining fault |
| Otherwise | Escalate to the maintenance engineer with the reason recorded in the timeline |

Implementation: [`lib/maintenance/agent.ts`](../lib/maintenance/agent.ts). Runbook: [operations.md](operations.md).
