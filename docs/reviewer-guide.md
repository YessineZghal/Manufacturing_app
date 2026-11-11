# Reviewer guide: capabilities and evidence

This guide maps each capability to concrete files, commands and tests, so each claim can be checked in a few minutes. The structure follows the Service Recovery Lab reviewer guide.

| # | Capability | Evidence | How to verify |
|---|---|---|---|
| 1 | **Problem description** | [README](../README.md): problem, solution, five-minute experiment | Read the README |
| 2 | **Product specification** | [product-spec.md](product-spec.md) (12 behaviours, acceptance scenarios). Tracker: [`public/tracker.json`](../public/tracker.json), rendered at `/tracker` | Open `/tracker` |
| 3 | **Dataset and model** | [dataset/README.md](../dataset/README.md) (provenance, checksums), [`scripts/train-model.mjs`](../scripts/train-model.mjs), [ADR 0006](decisions/0006-explainable-rul-model-trained-offline.md); FD001 test RMSE 16.60 (`rul-fd001-v2`) | `npm run model:train`; `node --test tests/model.test.mjs` |
| 4 | **Agent team specification** | [agent-team.md](agent-team.md) | Read the doc |
| 5 | **Context management** | [AGENTS.md](../AGENTS.md) links to modular docs | Follow the links |
| 6 | **Application** | React UI → Worker API → D1 database. Data persists across reloads and restarts. | `npm ci && npm run local` → ingest → reload |
| 7 | **Testing** | 5 model + 10 unit + 12 adviser + 4 OpenTelemetry + 5 report + 15 integration + 7 Playwright | `npm test`; see [testing.md](testing.md) |
| 8 | **Containerization** | [Dockerfile](../Dockerfile) (multi-stage, non-root, health check), [compose.yaml](../compose.yaml) | `docker compose up --build`; CI `container` job |
| 9 | **Deployment** | Cloudflare Workers + D1 workflows ([deployment.md](deployment.md)). Live: [production](https://predictive-maintenance-lab.yessine-zghal.workers.dev), [development](https://predictive-maintenance-lab-dev.yessine-zghal.workers.dev); the GitHub deploy workflows have not run yet. | `BASE_URL=<url> node scripts/check-deployment.mjs` |
| 10 | **CI/CD** | [ci.yml](../.github/workflows/ci.yml), [deploy-development.yml](../.github/workflows/deploy-development.yml), [deploy-production.yml](../.github/workflows/deploy-production.yml) (manual), [rollback.yml](../.github/workflows/rollback.yml) | *Actions* tab after the first push |
| 11 | **Observability** | One trace ID shared by span, log and metric; OTLP export; Grafana via `compose.observability.yaml` | UI → *Assessment telemetry*; `tests/otel.test.mjs` |
| 12 | **Alerting on operator impact** | `RulAssessmentUnavailable` ([operations.md](operations.md#alert-rulassessmentunavailable)) | Run a drill; unit test *alert requires three consecutive server failures…* |
| 13 | **On-call agent** | [`lib/maintenance/agent.ts`](../lib/maintenance/agent.ts): diagnoses, applies an allowlisted repair, verifies availability **and accuracy** | Guided drill → *Recovery independently checked*; integration test *an inaccurate model fails verification…* |

## Fast path for reviewers (≈ 5 minutes)

```bash
git clone https://github.com/YessineZghal/Manufacturing_app.git && cd Manufacturing_app
npm ci && npm run local              # or: docker compose up --build
# open http://127.0.0.1:3000 → Engine T-34 → Ingest next cycle → Run guided recovery drill
npx playwright install chromium && npm test
```
