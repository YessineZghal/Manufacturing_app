# Testing

## One command

```bash
npm ci
npx playwright install chromium     # first run only (CI uses --with-deps)
npm test
```

`npm test` ([`scripts/test.mjs`](../scripts/test.mjs)) runs five stages in order and exits non-zero on the first failure:

1. **Model freshness:** `node scripts/train-model.mjs --check`. The committed model and fleet artifacts must equal what the script produces from `dataset/CMAPSS`.
2. **Typecheck:** `tsc --noEmit`
3. **Model, unit, adviser, OpenTelemetry, report and integration:** Node.js built-in test runner (55 tests). JUnit output in `test-results/unit-integration.xml`.
4. **Production build:** `vinext build`
5. **Browser tests:** Playwright starts the production build on port 4317 against an isolated test database (8 journeys). Results in `test-results/browser.xml` and `playwright-report/`.

Individual stages: `npm run model:check`, `npm run typecheck`, `npm run test:core`, `npm run test:browser`.

## Test inventory

### Model tests: `tests/model.test.mjs` (5)

| Test | Guarantees |
|---|---|
| the Worker runtime reproduces the recorded FD001 test-set evaluation | Re-scores the 100 raw test engines with the TypeScript runtime; RMSE matches the artifact within 0.1; **quality gate: RMSE < 20** |
| features are window means, slopes and the cycle; predictions are clamped | Feature definition on a hand-computed example; output within `[0, 125]`; shape mismatch is rejected |
| health bands map predicted RUL to a maintenance decision | Boundaries at 30 and 80 cycles |
| fleet replay windows and ground truth come straight from the FD001 test files | Each fleet engine's last row and true RUL match the raw files; the fleet spans healthy, watch and critical |
| the golden reference engine is predicted within the verification tolerance | Release-time prediction reproduced; error ≤ 15 cycles |

### Unit tests: `tests/domain.test.mjs` (12)

| Test | Guarantees |
|---|---|
| assessments consume exactly one recorded cycle and retries preserve identity | Idempotent replay; same key with another engine → 409 |
| consecutive cycles advance through the replay and ground truth counts down | Cycle +1, true RUL −1 |
| recorded cycles cannot be over-ingested | 13th ingest of a 12-cycle replay → `no_cycles_remaining`; final true RUL equals `RUL_FD001` |
| malformed inputs fail without mutation | `null`, `{}`, arrays, unknown or non-string engine, the reference engine via the operator path, short keys → 422 |
| supported fault diagnoses are explicit and existing assessments survive | Each fault maps to its repair |
| unknown failures escalate and active incidents cannot be overwritten | `unknown_dependency` → escalate; second drill → 409; unsupported drill → 422 |
| alert requires three consecutive server failures, not validation failures | Four 422s do not alert; the third 503 alerts and records the trace ID |
| replayed idempotency keys during an outage neither count as success nor hide the alert | Alternating new (503) and replayed (200) requests still alert on the third 503; no success counted |
| successful attempts reset the failure streak; telemetry is bounded | Streak reset; at most 120 traces |
| manual restore is never counted as agent recovery | Status `cancelled`, recoveries = 0 |
| probe assessments use the golden engine, are bounded and never consume fleet cycles | Budget of 80; fleet untouched |
| workspaces move to the serving release model after an upgrade or a rollback | An older (v1) or newer (rolled-back) model ID assesses with the serving model after load; a drill's missing model is not "repaired" by the upgrade |

### Model-adviser tests: `tests/advisers.test.mjs` (12)
Allowlist parsing, prompt contents (three booleans only), timeouts, adviser selection (vLLM → Workers AI → policy), Workers AI JSON mode and response shapes, and end-to-end cases through the API. The vLLM tests run a real HTTP server that answers like `vllm serve`: they check the `/v1/chat/completions` path, bearer key, `Qwen/Qwen2.5-7B-Instruct` model ID, temperature 0 and the `json_schema` response format; the fallback when structured output is rejected; HTTP errors, timeouts and an unreachable server; and a full drill whose diagnosis is confirmed by the vLLM adviser without any fleet data in the request.

### OpenTelemetry tests: `tests/otel.test.mjs` (4)
OTLP field formats and shared trace/span IDs; header parsing; best-effort export; a real HTTP collector receives traces, logs and metrics with auth headers and without payloads or cookies; the download requires a session.

### Executive-report tests: `tests/report.test.mjs` (6)
Headline measures, operator impact and model quality (live MAE, critical engines); autonomy recommended only with enough verified evidence; manual restores never count as evidence; escalations never credited to the AI; unknown failures stay human-owned; `GET /api/report` end to end.

### Integration tests: `tests/integration.test.mjs` (16)
Real API handler against a **real SQLite database** created from the production migration.

| Test | Guarantees |
|---|---|
| session cookies protect isolated persistent workspaces | Separate data per cookie; absent or forged cookie → 401; cross-origin POST → 403 |
| concurrent API assessments never over-ingest or duplicate an idempotency key | 16 parallel ingests of a 12-cycle engine → exactly 12 succeed; 6 parallel requests with one key → one record |
| alert invokes responder and verifies recovery (model, gateway) | Health stays 200 during the fault; 3 × 503 → alert → agent → verification 201/422/persisted/accurate; original assessment kept; one repair step |
| unknown failure escalates without repair; owner can restore | No agent mutation; manual restore → `cancelled` |
| telemetry correlates signals and excludes credentials and payload fields | Planted secret, cookie and `token_hash` never appear in the export |
| database survives closing and reopening | Persistence across restart |
| invalid payloads and oversized bodies fail predictably | 422, 400, 413 |
| rejected bodies are always consumed so the connection stays usable | Declared and undeclared oversized bodies, wrong content types, and bodies rejected with 401, 403 or 405 are read before the reply |
| actual HTTP boundary supports cookies, assessment and reload | Real `node:http` round-trip |
| failed verification never reports recovered | Verification failure → escalated |
| **an inaccurate model fails verification even when every probe returns the expected status** | A persisted golden-engine prediction 82 cycles off → escalated, `accurate: false`, recoveries = 0 |
| adviser disagreement cannot authorize a different repair | Contradicting proposal → escalate, no change |
| stale agent action cannot overwrite an owner restore | Revision check protects engineer actions |
| concurrent responder invocations claim a single repair | Exactly one repair step |
| a failed responder run never escalates an incident another run is repairing | A run whose claim fails leaves another run's incident alone and escalates only an unclaimed one |

### Browser tests: `tests/browser/journeys.spec.ts` (8)

| Test | Covers |
|---|---|
| an operator assesses, refreshes, recovers and inspects correlated evidence | Ingest, persistence after reload, guided drill to *Recovery independently checked*, trace drill-down, model card, evidence API with `accurate: true`, no page errors |
| the maintenance board flags a near-failure engine as critical | 12 ingests of T-34 exhaust its replay; the board shows *critical* and *Schedule maintenance now* |
| unsupported faults require review and manual restore | Escalation path |
| an escalation after a failed verification can still be closed by an engineer | Probe budget exhausted → repair applied, verification fails → *Restore manually* stays available → cancelled |
| two browser contexts cannot affect each other | Fault in one session; assessments still succeed in the other |
| mobile layout, keyboard entry and public project pages | 390 px with no horizontal scroll, skip link, `/tracker` (7 tasks), `/guide` |
| every back link and sidebar link navigates without errors | Back links on `/guide`, `/tracker`, `/report` and the three sidebar links; no page or console errors |
| the executive report turns a verified recovery into leadership measures | `/report` shows model quality, 100 % objective attainment and *Gather evidence* |

### Deployment check: `scripts/check-deployment.mjs`
Checks health, ingests a cycle, injects a model fault, asserts three 503s, waits for the agent, and asserts `recovered`, `accurate` and the original assessment intact.

## Latest recorded results

| Date | Environment | Result |
|---|---|---|
| 2026-11-10 | Owner's macOS laptop (Apple silicon), Node 26.5, npm 11.17, Chromium headless shell 156 | `npm test`: model check passed · typecheck passed · **47/47** · build passed · **6/6** browser. Prettier and ESLint clean. `npm run local` + `scripts/check-deployment.mjs`: recovered, verification 201/422/persisted, golden-engine error 4.9 cycles. `scripts/benchmark.mjs`: 48/48 assessments, p95 27.7 ms. `scripts/capture-demo.mjs`: 5 screenshots, 0 page errors. |
| 2026-11-10 | Same laptop, Docker Desktop 29.5 | `docker compose up --build` (port 3100): container *healthy*, runs as `node`, dataset not in the image; `scripts/check-deployment.mjs` recovered with a 4.9-cycle error; 62/62 exploratory API checks; assessment kept after `docker compose restart`. |
| 2026-11-10 | Same laptop, after the review fixes | `npm test`: model check · typecheck · **51/51** · build · **7/7** browser. Exploratory reviews: 62/62 API checks, 19/19 UI checks (all faults, every view, 390 and 360 px, keyboard) with no page or console errors. |

| 2026-11-11 | Owner's macOS laptop, after model v2 | `npm test`: model check · typecheck · **52/52** · build · **7/7** browser. v2 server: `scripts/check-deployment.mjs` recovered, golden-engine error 9.1 cycles; a workspace saved under v1 kept working after the upgrade; `scripts/capture-demo.mjs` 0 page errors. |
| 2026-11-11 | Owner's laptop, after the independent-review fixes | `npm test`: model check · typecheck · **55/55** · build · **8/8** browser; lint and format clean; `npm run model:cv` reproduces the ADR 0006 numbers. |
| 2026-11-11 | Cloudflare Workers free plan, **production** (`https://predictive-maintenance-lab.yessine-zghal.workers.dev`), promoted by the owner from the laptop with Wrangler | `scripts/check-deployment.mjs`: recovered, 201/422/persisted, error 9.1. `/`, `/guide`, `/tracker`, `/report` → 200. Live `gateway_paused` drill: Workers AI proposed `resume_gateway`, policy agreed, recovered. Browser walkthrough (ingest, guided drill, sidebar pages): no page errors; the only console errors are the drill's three intentional 503s. |
| 2026-11-11 | Cloudflare Workers free plan, development (`https://predictive-maintenance-lab-dev.yessine-zghal.workers.dev`), deployed from the owner's laptop with Wrangler | `scripts/check-deployment.mjs`: recovered, verification 201/422/persisted, golden-engine error 9.1. A live drill's diagnosis: Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast` proposed `restore_model`, policy agreed. |
| 2026-11-11 | Owner's laptop, vllm-metal serving `mlx-community/Qwen2.5-7B-Instruct-4bit` | `npm run adviser:check`: 8/8, median 191 ms. `npm run local:qwen`: model and gateway drills recovered and the unknown dependency escalated, each with Qwen agreeing with the policy; `scripts/capture-demo.mjs` 0 page errors. |
| 2026-11-10 | GitHub Actions `ubuntu-latest` (*Quality gate*, [run 42895135910](https://github.com/YessineZghal/Manufacturing_app/actions/runs/42895135910)) | `verify` job (format check, lint, `npm test`) passed; `container` job (`docker compose up --wait` + `scripts/check-deployment.mjs`) passed. The run was on the history before it was squashed into one commit; the application code is the same. *Deploy development* was skipped because `DEPLOY_ENABLED` is not set yet. |
