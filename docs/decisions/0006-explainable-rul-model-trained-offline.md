# 0006 — An explainable RUL model trained offline and served as weights

**Status:** Accepted · **Date:** 2026-11-10

## Context
The product needs remaining-useful-life predictions on NASA C-MAPSS FD001 that are:
- reproducible from the committed data by anyone, with one command;
- cheap to run inside a Cloudflare Worker, with no extra service or native dependency;
- explainable to a maintenance engineer and an auditor;
- accurate enough to be useful, with its error shown, not hidden.

## Decision
- **Features:** 30-cycle window mean and least-squares slope of the 14 FD001 sensors that vary, plus the cycle count.
- **Target:** RUL capped at 125 cycles (piecewise-linear degradation, the common FD001 convention).
- **Model:** closed-form ridge regression (λ = 1) on standardised features.
- **Training:** `scripts/train-model.mjs`, deterministic, dependency-free Node.js. It writes `lib/maintenance/model.generated.ts` and `fleet.generated.ts`.
- **Training examples:** full 30-cycle windows only (see the revision below).
- **Evaluation:** last recorded cycle of each of the 100 test engines vs `RUL_FD001`: RMSE 16.60, MAE 13.52, PHM08 score 417.4 (`rul-fd001-v2`). The test set is never used for training or tuning.
- **Gates:** `npm test` fails if artifacts are stale or if test RMSE is 20 or more; a test proves the TypeScript runtime reproduces the recorded RMSE.

## Alternatives considered
- **LSTM/CNN/transformer.** Published results reach roughly 11–18 RMSE on FD001, but they need a training framework, a model runtime in the Worker (or a separate inference service, which is one more dependency to fail) and are harder to explain.
- **Gradient-boosted trees.** Better accuracy than linear, but a larger artifact and a custom runtime.
- **Calling a hosted ML endpoint.** Adds cost, latency and an external failure mode outside the lab's control.

## Consequences
The model is transparent and runs in microseconds, but it misses part of the critical band: 13 of the 25 test engines with true RUL ≤ 30 are predicted at 31–48 cycles, so they show as *watch*. The UI shows true RUL next to every prediction so the weakness is visible. Replacing the model is a contained change: train a new artifact, register it in `MODELS`, update the verification tolerance if needed, and keep the gates.

## Revision 2026-11-11: `rul-fd001-v2`, full windows only
`rul-fd001-v1` was also trained on the partial windows of each engine's first 29 cycles, where the slopes are unreliable, although the Worker always predicts from a full 30-cycle window. v2 trains on full windows only. Nothing else changed: same features, cap, window, λ and runtime.

The change was chosen by 5-fold cross-validation over the 100 **training** engines (grouped by engine, each held-out engine cut every 3 cycles where its true RUL ≤ 150): RMSE 23.88 → 18.98. Other candidates were rejected on the same validation: cap 115–135 (+0.04 to +0.51), window 20 or 25 (+1.38, +0.58), λ 10 or 100 (−0.02, −0.09, within noise), and squared window means (−0.67, but a runtime change and harder to explain). The test set was scored once, for the chosen model only. `npm run model:cv` (`scripts/cross-validate.mjs`, which never reads the test files) reproduces every number in this paragraph.

| FD001 test set (100 engines) | v1 | v2 |
|---|---|---|
| RMSE | 22.80 | 16.60 |
| RMSE against capped truth | 21.75 | 15.22 |
| MAE | 18.02 | 13.52 |
| PHM08 score | 1,372.2 | 417.4 |
| Correct maintenance band | 68 | 78 |
| True RUL ≤ 30 not flagged critical | 16 / 25 | 13 / 25 |
| Mean error when true RUL ≤ 30 | +21.4 | +4.5 |
| Golden engine (unit 91, true RUL 38) | 33.1 | 47.1 (error 9.1 ≤ 15) |

The quality gate is tightened from RMSE < 25 to RMSE < 20 so the gain cannot regress silently. A stored workspace is pinned to the release that loads it: `upgrade()` in `lib/maintenance/domain.ts` moves any model ID that release does not serve (v1 after this upgrade, or a newer ID after a rollback) to its known-good model, and leaves only the drill's deliberately missing reference broken. Without it such workspaces would answer every assessment with `model_unavailable` and, with no incident open, nothing would repair them.

