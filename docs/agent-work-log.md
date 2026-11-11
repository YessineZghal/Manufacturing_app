# Agent work log

This log records what each agent session actually did and verified. Entries are not rewritten after the fact. Corrections are added as new entries. Task IDs refer to [`public/tracker.json`](../public/tracker.json).

---

## 2026-11-10 — PML-01 → PML-06 (Product, Implementation and Verification roles, session A)

**Owner request:** review the Service Recovery Lab repository and reuse its architecture, template and components to build a manufacturing application on the NASA C-MAPSS FD001 data.

**Read:** the full template (`README.md`, `AGENTS.md`, `lib/recovery/*`, `app/*`, `tests/*`, `scripts/*`, workflows, docs and ADRs).

**Design mapping** (owner did not specify the domain mapping; the agent chose it):

| Template | This project |
|---|---|
| Visitor reservation journey | Operator RUL assessment journey (ingest the next FD001 sensor cycle) |
| Slots with capacity | Six fleet engines, each with 12 replayable recorded cycles |
| Probe slot | Golden reference engine (test unit 91) |
| `catalog_unavailable` / `adapter_paused` / `unknown_dependency` | `model_unavailable` / `gateway_paused` / `unknown_dependency` |
| Verification 201 / 422 / persisted | Verification 201 / 422 / persisted **+ prediction error ≤ 15 cycles** |

**Data:** downloaded the C-MAPSS archive from the NASA PCoE S3 mirror; committed FD001 files unmodified with SHA-256 checksums (`dataset/README.md`).

**Model:** ridge regression on 30-cycle window means and slopes of 14 sensors plus cycle count, RUL capped at 125. First and only evaluated configuration: FD001 test RMSE 22.80, MAE 18.02, PHM08 1,372.2. No tuning on the test set. The fleet engines were chosen after inspecting test-set predictions so the fleet spans healthy, watch and critical; this selection affects only the demo, not the reported evaluation. The golden engine (unit 91, error 4.9 cycles) was chosen the same way and is documented as such in ADR 0003.

**Changed:** created the project from the template: `lib/maintenance/*` (domain, model runtime, agent, advisers, report, otel, api, repository), generated artifacts, `scripts/train-model.mjs`, UI pages, tests, scripts, workflows, Docker files and docs.

**Verification** (macOS, Node 26.5, npm 11.17):

| Command | Result |
|---|---|
| `npm ci` | passed; npm 11 held back post-install scripts (esbuild, workerd, fsevents, unrs-resolver). Platform binaries came from optional dependencies; the build and runtime worked without approving the scripts. |
| `npm run test:core` | 30/31 at first: one report test expected the word "operators", which had been changed to "maintenance engineers". Test updated → **47/47** after adding the inaccurate-model integration test |
| `npx playwright test` | **6/6** on first run |
| `npm test` (one command) | exit 0: model check, typecheck, 47/47, build, 6/6 |
| `prettier --check .`, `eslint .` | clean |
| `npm run local` + `scripts/check-deployment.mjs` | recovered; verification 201/422/persisted; error 4.9 cycles |
| `scripts/benchmark.mjs` | 48/48, p50 21.2 ms, p95 27.7 ms (`evidence/performance.json`) |
| `scripts/capture-demo.mjs` | 5 screenshots, recovery `recovered`, 0 page errors |
| `docker compose up --build` | **not run**: Docker daemon not running on the machine |

**Not done / open:**
- Independent verification by a separate session (PML-06's separation-of-review rule) has not happened yet.
- No push, no CI run and no cloud deployment yet (PML-07 stays `in_progress`).

## 2026-11-10 — Component audit against the template (Verification role, session A)

The owner asked whether every template component had been adapted.

- **File-by-file comparison** with the template's tracked files (`lib/recovery/` mapped to `lib/maintenance/`). Missing: `drizzle/0000_legal_bloodstrike.sql` and `docs/decisions/0001-alert-on-journey-impact.md` (renamed on purpose to `0000_initial_workspaces.sql` and `0001-alert-on-operator-impact.md`), and `docs/screenshots/demo.gif`, which was then generated from `evidence/local-demo.webm` with `ffmpeg` (fps 8, 960 px, 96-colour palette).
- **Search for template vocabulary** (reservation, booking, slot, catalog, adapter, customer, SRL, appointment) in all new files: no leftovers except the intentional mapping table above and "visitor" meaning a website visitor.
- **Components not exercised before, now run:** `scripts/sync-tracker-issues.mjs --dry-run` (7 `[PML-0N]` issues planned); `scripts/cloud-prepare.mjs development` with placeholder IDs (worker name, `-db` database, `pml_migrations`, `AI` binding and stage variables correct; the generated file was deleted); `drizzle-kit check` ("Everything's fine").
- **Still unverified:** Docker image and Compose (daemon not running), GitHub Actions and Cloudflare deployment (nothing pushed).

## 2026-11-10 — vLLM adviser and wording cleanup (Implementation and Verification roles, session A)

Owner request: use vLLM with a Qwen 7B model instead of Ollama, and remove "verdict", "smoke" and similar generated-sounding wording.

- **Adviser:** `ollamaAdvisor` replaced by `vllmAdvisor` (OpenAI-compatible `/v1/chat/completions`, default `Qwen/Qwen2.5-7B-Instruct`, `json_schema` structured output with a fallback on HTTP 400, optional bearer key). Selection order is now vLLM → Workers AI → deterministic policy. Settings `VLLM_URL`, `VLLM_MODEL`, `VLLM_API_KEY` in the Worker, `scripts/local.mjs`, `compose.yaml`, `config/environment.example`, `scripts/cloud-prepare.mjs` and the deploy workflows (key stored as a Worker secret). Added `compose.vllm.yaml` (pinned `vllm/vllm-openai:v0.32.0`, NVIDIA GPU required).
- **Tests:** three new vLLM tests against a local HTTP server that imitates the vLLM API; adviser suite 9 → 12, core 47 → 50.
- **Not verified:** a real vLLM server with Qwen2.5-7B-Instruct. This Mac has no NVIDIA GPU, so the model was not run; only the API contract was tested.
- **Wording:** "verdict" did not occur in the project. `scripts/smoke.mjs` renamed to `scripts/check-deployment.mjs` (`npm run check:deployment`) and every reference updated, including the earlier entry of this log at the owner's request. Phrases such as "earned the right to act", "lives the same moment", "trustworthy", "honest", "defend/defensible", "journey-level" and "guardrails" replaced with plain wording.

## 2026-11-10 — End-to-end review (Verification role, session A)

Owner request: review the app and make sure everything works correctly.

**Method:** a 62-check exploratory API script and a 19-check exploratory browser script (scratch files, not committed) against the running production build, then the container, plus a code read of the API, agent, adviser and UI.

**Defects found and fixed**

1. *Request after a 413 failed with 503* ("Your worker restarted mid-request") in the local and Docker runtimes, because the API replied before reading an oversized body. Inherited from the template. Cancelling the body did **not** help (checked against the running server); the fix reads and discards the body up to 1 MB before replying (`readBody` in `lib/maintenance/api.ts`). New integration test; the failing sequence was replayed against the rebuilt server.
2. *"← Maintenance workspace" links did nothing*: vinext 1.0.0-beta.5 client navigation through `next/link` throws `e is not a function`, and its prefetch logged console errors on `/report`, `/guide` and `/tracker`. Also inherited; no test clicked those links. Replaced with plain `<a>` links, disabled `@next/next/no-html-link-for-pages` with a comment, added a browser test that clicks every link and fails on console errors.
3. *Ambiguous adviser input for Qwen2.5-7B*: the prompt did not name the three fields, and `modelAvailable` could be read as being about the language model itself. Renamed to `rulModelAvailable`; the prompt now defines each field and the exact combination for each action. A test checks that the agent's observation uses exactly the prompt's field names.
4. *vLLM fallback doubled the timeout* (two 20 s timers). One deadline now covers both requests, the rejected response body is released, and an unreadable JSON body maps to `adviser_output_invalid`. Test added.
5. *`/report` logged a 401 on first visit* (report requested before the session). The page now creates or reuses the session first.
6. *Capped predictions displayed as "125"* although the model cannot see beyond its 125-cycle cap (T-25's true RUL is 156). Shown as "≥ 125". The threshold badge no longer capitalises "cycles".
7. `scripts/train-model.mjs` exported functions although importing it would retrain; exports removed.

**Docker:** Docker Desktop started; `docker compose up --build` verified (see testing.md). The review containers and volume were removed afterwards.

**Still not verified:** a real vLLM server with Qwen2.5-7B-Instruct (no NVIDIA GPU here), GitHub Actions and the Cloudflare deployment (nothing pushed).

## 2026-11-10 — Design update and Qwen on macOS (Implementation role, session A)

Owner request: run the vLLM + Qwen 7B part end to end on macOS, and improve the design with the same palette.

**Design** (palette kept; new chart and status steps validated with the dataviz skill's `validate_palette.js`):
- *RUL trajectory* chart for the selected engine: predicted RUL (`#0a8a76`, one step brighter than the UI teal because `#126d62` is below the chroma floor) against actual RUL (`#8fa3aa`, de-emphasis grey; its contrast warning is relieved by direct end labels and a data table). Threshold hairlines at 30 and 80 with haloed labels, crosshair tooltip, arrow-key reading, data table in a disclosure.
- *Fleet health summary* (critical, watch, healthy, not assessed) and *RUL meters* on the maintenance board.
- *Status colours* healthy `#0a8a76`, watch `#d9a021`, critical `#b8433a`: the first green/amber/red attempt failed the normal-vision floor (amber↔red ΔE 14.6) and colour-blind separation (green↔red ΔE 5–6); teal for healthy passes every check (worst ΔE 8.6). Status always carries an icon and a label; watch and critical use different icon shapes.
- Defects found while checking the render: the chart measured an element that did not exist on first render, so it stayed 720 px wide and overflowed the 390 px page by 365 px; fixed by measuring an always-rendered frame.

**Qwen on macOS:** `brew install` of vllm-metal was **blocked by the session's permission policy**, so the model was not run. Prepared `npm run vllm:mac` (`mlx-community/Qwen2.5-7B-Instruct-4bit`), `npm run local:qwen`, and `npm run adviser:check`, a live check of all 8 input combinations against the policy (verified only against no server: 0/8, every call `adviser_unavailable`, as expected).

## 2026-11-10 — First push of the full application and CI (Implementation role, session A)

Owner request: commit and push under the owner's name.

- Before committing: `npm run format:check` and `npm run lint` clean; `npm test` passed (model check, typecheck, 51/51, build, 7/7 browser).
- Committed and pushed to `main`. The history was later squashed into a single commit under Yessine Zghal; the CI run below is from before the squash, on the same application code.
- GitHub Actions *Quality gate* [run 42895135910](https://github.com/YessineZghal/Manufacturing_app/actions/runs/42895135910): `verify` and `container` jobs passed. *Deploy development* was skipped as designed: the repository variable `DEPLOY_ENABLED` and the Cloudflare secrets are not configured yet.

**Still not verified:** the Cloudflare deployment (needs the owner's Cloudflare account and GitHub secrets, see `docs/deployment.md`) and Qwen on vllm-metal (install awaiting the owner).

## 2026-11-11 — RUL model v2: train on full windows only (Implementation role, session A)

Owner request: improve the RUL model while the Qwen and Cloudflare steps wait on the owner (the vllm-metal install was blocked again by the session's permission policy).

**Found:** `rul-fd001-v1` was trained on every cycle, including the partial windows of each engine's first 29 cycles, whose slopes are unreliable. The Worker always predicts from a full 30-cycle window, so training and serving disagreed.

**Model selection without the test set:** 5-fold cross-validation over the 100 training engines, grouped by engine, each held-out engine cut every 3 cycles where its true RUL ≤ 150 (4,824 cuts). Full windows only: RMSE 23.88 → 18.98. Rejected on the same validation: cap 115–135, window 20/25, λ 10/100, squared window means (−0.7, but a runtime change and harder to explain). *Correction (independent review, same day): the original note said "all within ±0.6", but window 20 is +1.38; the script is now committed as `scripts/cross-validate.mjs` (`npm run model:cv`).*

**Test set, scored once for the chosen model** (`rul-fd001-v2`): RMSE 22.80 → 16.60, MAE 18.02 → 13.52, PHM08 1,372.2 → 417.4; correct maintenance band 68 → 78 of 100; mean error when true RUL ≤ 30 +21.4 → +4.5. Still weak: 13 of the 25 engines with true RUL ≤ 30 are predicted at 31–48 and shown as *watch*. Thresholds were **not** moved, because choosing them from these numbers would be tuning on the test set. On the fleet, T-63 (true 72) is now predicted 86.8, *healthy* instead of *watch*. The golden engine moves from 33.1 to 47.1 (error 9.1, within the 15-cycle tolerance; the engine was not re-chosen).

**Changed:** `scripts/train-model.mjs` (full windows, ID `rul-fd001-v2`), regenerated artifacts; quality gate RMSE < 25 → < 20; `SUPERSEDED_MODELS` and `upgrade()` so workspaces saved under v1 move to v2 on load (without it they answer every assessment with 503 and, with no incident open, nothing repairs them) plus a unit test; ADR 0006 revision, ADR 0003, README, architecture, operations, testing, strategy, product spec, tracker.

**Verified:** `npm test` (model check, typecheck, 52/52, build, 7/7 browser), lint and format clean. Against a v2 server on port 3200 sharing the local database: a workspace created on the running v1 server recorded an assessment (201) and now references `rul-fd001-v2`; `scripts/check-deployment.mjs` recovered with a golden-engine error of 9.1 cycles; `scripts/capture-demo.mjs` 5 screenshots, 0 page errors; GIF rebuilt with `ffmpeg`. Stopping the old server on port 3000 was blocked by the permission policy, so it still runs the v1 build.

## 2026-11-11 — First cloud deployment and Qwen 7B on macOS (Delivery and Implementation roles, session A)

**Cloudflare (owner ran `npx wrangler login`).** Created the D1 databases `predictive-maintenance-lab-dev-db` and `predictive-maintenance-lab-db`, applied the migration to the development database, and deployed `predictive-maintenance-lab-dev` (241 KiB gzip, startup 12 ms). The first deploy failed because the account had no `workers.dev` subdomain; the owner chose `yessine-zghal`, which was registered through the Cloudflare API, then the deploy succeeded. `scripts/check-deployment.mjs` against the live URL: recovered, 201/422/persisted, error 9.1. A live `model_unavailable` drill was diagnosed by Workers AI (Llama 3.3 70B) in agreement with the policy. **Not done yet:** the GitHub-driven deploy (needs a Cloudflare API token and the repository variables), production and rollback; PML-07 stays in progress.

**Qwen (owner installed vllm-metal).** `npm run vllm:mac` downloaded and served `mlx-community/Qwen2.5-7B-Instruct-4bit`. Defect found: `npm run adviser:check`, as documented, failed with "Set VLLM_URL"; it now defaults to the `vllm:mac` server and model. Result: 8/8 agreement, median 191 ms. With `npm run local:qwen` (port 3200): model and gateway drills recovered, the unknown dependency escalated, and every Diagnose step recorded Qwen's proposal matching the policy. Screenshots, evidence and the demo GIF were recaptured from this run (0 page errors).

## 2026-11-11 — Production promotion and repository reset (Delivery role, session A)

- **Repository:** at the owner's request the git history was replaced by one first commit under Yessine Zghal <yessine.zghal.1@ulaval.ca>; the owner deleted and recreated `YessineZghal/Manufacturing_app`, and the commit was pushed there. Before pushing: format, lint and `npm test` (52/52, 7/7) passed. The first *Quality gate* run in the new repository passed (verify and container jobs).
- **Production:** my own attempt to deploy production was blocked by the session's permission policy (production needs the owner's explicit approval), so the owner ran `cloud:prepare production`, the D1 migration and `wrangler deploy`. Checked afterwards: `scripts/check-deployment.mjs` recovered (201/422/persisted, error 9.1); the four pages answer 200; a live `gateway_paused` drill was diagnosed by Workers AI in agreement with the policy; a browser walkthrough had no page errors (the three console errors are the drill's intentional 503s).
- **PML-07 stays in progress:** Docker and both public deployments are verified, but the GitHub deploy, promotion and rollback workflows have not run, because the new repository has no Cloudflare token or environment variables yet.

## 2026-11-11 — Independent review and fixes (Review role: a fresh agent; fixes: session A)

At the owner's request a separate agent with no memory of the implementation reviewed the repository read-only (correctness, security, ML integrity, docs, UI). It found no security issues and confirmed every published model figure. Each finding below was re-checked against the code before fixing.

| Finding | Fix | Test |
|---|---|---|
| Report recommended expanding autonomy from manual restores alone (3 restores → `expand_autonomy`, "0/0") | Evidence counts only agent-handled incidents | `manual restores are never evidence for expanding autonomy` |
| UI stuck after a failed verification with a healthy configuration (drills blocked, *Restore manually* disabled) | *Restore manually* stays available while an incident is open | Browser: `an escalation after a failed verification can still be closed by an engineer` |
| A rollback after a model upgrade would leave workspaces on an unknown model ID (503, no alert) | `upgrade()` moves any model ID the serving release does not know to its known-good model; the drill's missing reference is kept | `workspaces move to the serving release model after an upgrade or a rollback` |
| Replayed idempotency keys reset the alert streak and counted as successes during an outage | Replays are traced but neutral | `replayed idempotency keys during an outage neither count as success nor hide the alert` |
| A responder run's error handler could escalate another run's incident | Error handling moved into the agent; it escalates only its own or an unclaimed incident | `a failed responder run never escalates an incident another run is repairing` |
| Bodies rejected with 401, 403 or 405 were not drained | Drained like other rejections | Extended `rejected bodies are always consumed…` |
| Workers AI fallback could take 30 s instead of 15 s (found while checking the docs finding) | One deadline for both calls | Extended adviser fallback test |
| Production workflow could be dispatched from any branch | Job runs only for `refs/heads/main` | — |
| Model-selection script not committed; my ADR said "all within ±0.6" but window 20 is +1.38 | `scripts/cross-validate.mjs` (`npm run model:cv`) reproduces every CV number; ADR and work log corrected | — |
| Stale docs: "not deployed", test counts, `npm run local` "builds" | Updated | — |
| Status notice not always in the accessibility tree; nav without active state | Always-mounted `role="status"`; `aria-current` | — |

Not changed: the agent's invalid-engine check still uses the operator endpoint on purpose (it verifies operator validation); this is now documented in operations.md.

**Verified:** `npm test` (model check, typecheck, **55/55**, build, **8/8**), lint and format clean; `capture-demo` from the rebuilt Qwen-backed app: 0 page errors, page heights unchanged.
