# Predictive Maintenance Lab: agent context

Predictive Maintenance Lab is a full-stack predictive-maintenance service (React UI → Cloudflare Worker API → D1/SQLite) built on the NASA C-MAPSS FD001 turbofan benchmark. Operators ingest engine sensor cycles and receive a remaining-useful-life (RUL) prediction and a maintenance decision. A controlled fault breaks assessments, an operator-impact alert fires, a bounded on-call agent repairs the pipeline and verifies recovery through the live API, including a golden-engine accuracy check, and every step is exported as trace-correlated evidence.

The architecture is adapted from Service Recovery Lab; keep the two aligned where possible.

## Read first

| When you are… | Read |
|---|---|
| Understanding why the product exists | [Strategy, value and roadmap](docs/strategy.md) |
| Changing any behaviour | [Product specification](docs/product-spec.md) |
| Touching the dataset, features or model | [Dataset provenance](dataset/README.md) · [ADR 0006](docs/decisions/0006-explainable-rul-model-trained-offline.md) |
| Touching code structure, API or data | [Architecture](docs/architecture.md) · [Decision records](docs/decisions/README.md) |
| Picking up or handing off work | [Agent team and process](docs/agent-team.md) · [Work log](docs/agent-work-log.md) · [Tracker](public/tracker.json) |
| Writing or running tests | [Testing](docs/testing.md) |
| Working on alerts, telemetry, the responder or rollback | [Operations](docs/operations.md) |
| Working on CI/CD or cloud environments | [Deployment](docs/deployment.md) |
| Reviewing the project end to end | [Reviewer guide](docs/reviewer-guide.md) |

## Working rules

- **Work from the tracker.** Each task has observable acceptance criteria. Move a task to `done` only when every criterion is verified, and list the evidence in the task's `evidence` field.
- **Log real work.** Record what you read, changed and verified in `docs/agent-work-log.md`, including failures. Never fabricate collaborators, successful checks, deployments, model metrics or commercial outcomes.
- **Preserve the invariants:** session isolation, cookie authorisation, idempotency, bounded recovery, accuracy-checked verification and telemetry redaction.
- **Respect the responder's limits.** It may repair only the two supported workspace-scoped configuration faults. Never weaken validation, change model weights or assessments, grant access or execute model-generated code.
- **Never hand-edit `lib/maintenance/*.generated.ts`.** Change `scripts/train-model.mjs` and run `npm run model:train`. Report the new evaluation as measured; do not tune on the test set.
- **Scope.** This is a controlled laboratory replaying public simulation data, not a plant-control or airworthiness system. No external equipment, personal data or real maintenance orders.
- **Before a change,** identify the task and expected outcome. **After a change,** run `npm test` (or the relevant stage) and record the result.
- **Language.** All product copy and documentation are in English.
- **Keep out of commits and archives:** secrets, `.env*`, dependency folders, runtime databases (`.wrangler/`), caches and build output.

## Commands

```bash
npm ci                 # install
npm run model:train    # retrain on dataset/CMAPSS and regenerate lib/maintenance/*.generated.ts
npm run local          # build, migrate, serve http://127.0.0.1:3000
npm test               # model check → typecheck → unit + integration → build → browser
npm run lint
docker compose up --build
BASE_URL=<url> node scripts/check-deployment.mjs
```
