# Operations: observability, alerting, on-call agent and rollback

## Service level indicator

**SLI — operator assessment success:** successful assessments divided by valid assessment attempts, with synthetic probes excluded. It is shown as *Operator assessment success* in the UI.

Validation rejections (4xx, including an exhausted replay) are excluded from both numerator and denominator because they are not service failures. `/api/health` is intentionally **not** an SLI. It reports process health only and stays green during journey failures.

## Model quality indicators

| Indicator | Where | Meaning |
|---|---|---|
| Offline RMSE / MAE / PHM08 score | Model card (*Recovery evidence*), `/report`, `model.generated.ts` | Error on the 100 held-out FD001 test engines at release |
| Live MAE | `/report` → *Model quality* | Mean absolute error of this workspace's fleet assessments against ground truth |
| Golden-engine error | Every *Verify* step | Absolute error on the reference engine after a repair; must be ≤ 15 cycles |

## Telemetry

Every call to `/api/assessments` or `/api/probe` produces three signals that share one `traceId`:

| Signal | Shape | Example |
|---|---|---|
| Span | `span: rul.assessment`, `spanId`, `durationMs`, `status` | `status: 503, durationMs: 2.4` |
| Structured log | `event: assessment.completed`, `component: rul-service`, `outcome` | `outcome: model_unavailable` |
| Metric | `rul_assessment_journey_total`, `value: 1`, labels `journey` (`operator_assessment` / `synthetic_probe`) and `outcome` (`success` / `unavailable` / `rejected`) | — |

How the signals flow:
- **Collected and stored** per workspace in the database (the last 120), with aggregate counters in `metrics`.
- **Viewable** in the UI under *Assessment telemetry*, with a detail view showing span, log and metric for one trace ID. The same data is in the evidence export.
- **Also emitted** as one-line JSON to stdout with `trace_id`; in the cloud these appear in Cloudflare Workers Logs. Errors emit `api.error` with `trace_id` and a code, never a stack trace or payload.
- **Returned to the client** in the `x-trace-id` header and the JSON body.
- **OpenTelemetry.** `lib/maintenance/otel.ts` encodes the same signals as OTLP/JSON. `GET /api/telemetry/otlp` downloads them. With `OTEL_EXPORTER_OTLP_ENDPOINT` set, each attempt is pushed live to `/v1/traces`, `/v1/logs` and `/v1/metrics` (optional `OTEL_EXPORTER_OTLP_HEADERS`). Export is best-effort.

### Viewing telemetry in Grafana (local)

```bash
docker compose -f compose.yaml -f compose.observability.yaml up --build
```

1. Ingest cycles and run a drill at <http://localhost:3000>.
2. Open Grafana at <http://localhost:3001> → *Explore*.
3. **Tempo:** `service.name = predictive-maintenance-lab` · **Loki:** `{service_name="predictive-maintenance-lab"}` · **Prometheus:** `rul_assessment_journey_total`.

**Redaction rules:** telemetry never contains request bodies, sensor values, cookies, session tokens, token hashes or raw exceptions. This is asserted by integration and OpenTelemetry tests.

## Alert: `RulAssessmentUnavailable`

| Field | Value |
|---|---|
| Condition | Three **consecutive** assessment attempts (operator or probe) return HTTP 5xx in a workspace with an open incident |
| Excluded | 4xx validation errors and exhausted replays; any success resets the streak |
| Severity | Page. Planners cannot get RUL predictions for the fleet. |
| Action | Incident → `alerted`, the triggering trace ID is recorded, the on-call responder is invoked |
| Implementation | `recordAttempt()` in [`lib/maintenance/domain.ts`](../lib/maintenance/domain.ts) |

**Trigger it on purpose:** choose a scenario and click *Run guided recovery drill* (or *Inject fault only*, then ingest three times). From the command line, `scripts/check-deployment.mjs` does exactly this.

## On-call agent runbook

The responder runs automatically after the alert (`ctx.waitUntil`). Its timeline appears in *Recovery timeline*.

| Phase | Tool | What happens | Failure mode |
|---|---|---|---|
| Observe | `read_pipeline_state` | Claims the incident with a unique run ID; reads configuration and the alert | A second invocation finds the incident already claimed and exits |
| Diagnose | `select_allowlisted_repair` | Maps observed state to `restore_model`, `resume_gateway` or `escalate` | Unknown state → escalate |
| Repair | `restore_model` / `resume_gateway` | Revision-checked update of the configuration only | Revision changed (for example by the engineer) → escalate, no write |
| Verify | `exercise_assessment_api` | Golden-engine probe → 201 persisted with error ≤ 15 cycles; invalid-engine probe → 422 | Any mismatch, including an inaccurate prediction → escalate. *Recovered* is never claimed. |

### When the agent escalates
1. Read the timeline: the `Escalate` step states why (unsupported state, changed state or failed verification, including the measured prediction error).
2. Open *Assessment telemetry* and inspect the failing trace IDs.
3. Fix the cause. In the lab, click **Restore manually**, which restores the known-good configuration.
4. The incident closes as **cancelled**, keeping engineer actions distinct from autonomous recoveries.

### Model adviser (vLLM with Qwen2.5-7B-Instruct)

| Where | Adviser | How it is enabled |
|---|---|---|
| Any environment with a vLLM server | **vLLM** serving `Qwen/Qwen2.5-7B-Instruct` through the OpenAI-compatible API, with structured JSON output constrained to the three allowed actions | Set `VLLM_URL` (for example `http://vllm:8000`), optionally `VLLM_MODEL` and `VLLM_API_KEY`. Takes precedence over Workers AI. |
| Docker with an NVIDIA GPU | vLLM container next to the app | `docker compose -f compose.yaml -f compose.vllm.yaml up --build` (pinned `vllm/vllm-openai:v0.32.0`, about 16 GB of GPU memory in bf16) |
| Cloud without a vLLM server | Cloudflare **Workers AI**, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` by default | Automatic `AI` binding; `ENABLE_WORKERS_AI=false` turns it off |
| Neither configured | None: the deterministic policy decides alone | — |

#### On a Mac (Apple silicon)

vLLM runs on the Mac GPU through the official [vllm-metal](https://github.com/vllm-project/vllm-metal) plugin (MLX backend, macOS 15 or later). It serves `mlx-community/Qwen2.5-7B-Instruct-4bit`, the 4-bit MLX build of Qwen2.5-7B-Instruct (about 4.3 GB, comfortable on a 16–24 GB Mac).

```bash
brew tap vllm-project/vllm-metal https://github.com/vllm-project/vllm-metal
brew install vllm-project/vllm-metal/vllm-metal
npm run vllm:mac          # terminal 1: downloads the model on first run, then serves :8000
npm run adviser:check     # terminal 2: all 8 input combinations must agree with the policy
npm run local:qwen        # the app with VLLM_URL=http://127.0.0.1:8000 and the MLX model ID
```

`adviser:check` (`scripts/check-adviser.mjs`) prints each answer and its latency and exits non-zero on any disagreement. It defaults to the server started by `vllm:mac`; set `VLLM_URL` and `VLLM_MODEL` for another one.

**Measured on 2026-11-11** (Apple M5 Pro, 24 GB, vllm-metal with vLLM 0.33): 8/8 agreement with the policy, median 191 ms per answer (1.7 s for the first, cold request). With `local:qwen`, all three drills ran end to end: `model_unavailable` → Qwen proposed `restore_model` → recovered; `gateway_paused` → `resume_gateway` → recovered; `unknown_dependency` → `escalate` → escalated. After a guided drill, the *Diagnose* step reads `vLLM mlx-community/Qwen2.5-7B-Instruct-4bit proposed restore_model; policy selected restore_model`.

#### On a Linux GPU host

Starting vLLM by hand on a GPU host:

```bash
pip install vllm
vllm serve Qwen/Qwen2.5-7B-Instruct --max-model-len 4096 --api-key <optional-key>
VLLM_URL=http://<gpu-host>:8000 VLLM_API_KEY=<optional-key> npm run local
```

The model receives **only three booleans** (model available, gateway streaming, unknown dependency). It never sees sensor data. Its answer is reduced to exactly one allowlisted action; a different, malformed or late answer (20 s for vLLM, 15 s for Workers AI) escalates. A vLLM server that rejects structured output (HTTP 400) is asked again without it. The *Diagnose* step records the model and its proposal, for example `vLLM Qwen/Qwen2.5-7B-Instruct proposed restore_model; policy selected restore_model`.

## Retraining the model

1. Change `scripts/train-model.mjs` (never the generated files).
2. `npm run model:train` and read the printed evaluation.
3. `npm test`: the quality gate (RMSE < 20), the runtime-reproduction test and the golden-engine tolerance must pass.
4. Give the new artifact a new `id` if its behaviour changes, and record the evaluation in the work log.

## Rollback

1. Find the last good version: `npx wrangler deployments list --name <worker-name>`, or Cloudflare dashboard → Workers → your worker → Deployments.
2. GitHub → **Actions → Roll back a deployment → Run workflow**. Choose the environment and paste the version ID.
3. The workflow validates the ID, runs `wrangler rollback`, then runs the deployment check against `DEPLOYMENT_URL`.

Because the model ships inside the Worker, a Worker rollback also rolls back the model. Database migrations are additive.

## Capacity and abuse limits (public demo)

| Limit | Value | Response |
|---|---|---|
| Workspaces | 1,000 concurrent, 24 h expiry | 429 `demo_workspace_limit` |
| Drills per workspace | 12 | 429 `drill_budget_exhausted` |
| Probe assessments per workspace | 80 | 429 `probe_budget_exhausted` |
| Cycles per fleet engine | 12 replayed cycles | 409 `no_cycles_remaining` |
| Request body | 4 KB | 413 |
| Workspace document | 240 KB | 429 |
| Telemetry kept | Last 120 traces | Oldest are dropped |
