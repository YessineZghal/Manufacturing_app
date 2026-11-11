# Dataset: NASA C-MAPSS FD001

The files in [`CMAPSS/`](CMAPSS/) are the FD001 subset of the **Turbofan Engine Degradation Simulation Data Set** (C-MAPSS), published by the NASA Ames Prognostics Center of Excellence. They are unmodified copies of the files in `CMAPSSData.zip`.

| File | Contents | SHA-256 |
|---|---|---|
| `train_FD001.txt` | 100 run-to-failure trajectories, 20,631 cycles | `963b5e22825b34d8b21c69e1aeb4af3e647050eb672ee8834ba4b5d91d2de0f8` |
| `test_FD001.txt` | 100 trajectories truncated before failure, 13,096 cycles | `3cda7109ce17bafb5443f2ac926cfcf88154b941b8c4cf95eb55d1ddd6f52851` |
| `RUL_FD001.txt` | True remaining useful life after the last test cycle, one line per test unit | `a19c8ec94931949d0485bdc35118206e9c81c4547b422efb9cf86f4ceddbceca` |
| `readme.txt` | NASA's original description of all four subsets | — |

**FD001:** one operating condition (sea level), one fault mode (high-pressure compressor degradation).

Each row has 26 space-separated columns: unit number, cycle, three operational settings and 21 sensor measurements. The model uses the 14 sensors that vary in FD001: `s2 s3 s4 s7 s8 s9 s11 s12 s13 s14 s15 s17 s20 s21`.

## Source and citation

- Downloaded on 2026-11-10 from the NASA PCoE data set repository mirror: `https://phm-datasets.s3.amazonaws.com/NASA/6.+Turbofan+Engine+Degradation+Simulation+Data+Set.zip`
- Repository: <https://www.nasa.gov/intelligent-systems-division/discovery-and-systems-health/pcoe/pcoe-data-set-repository/>
- A. Saxena, K. Goebel, D. Simon and N. Eklund, "Damage Propagation Modeling for Aircraft Engine Run-to-Failure Simulation", *Proceedings of the 1st International Conference on Prognostics and Health Management (PHM08)*, Denver CO, 2008.

The data is simulated. It contains no personal data.

## How it is used

`npm run model:train` (`scripts/train-model.mjs`) reads these files and writes:
- `lib/maintenance/model.generated.ts`: the RUL model weights, scaler and test-set evaluation.
- `lib/maintenance/fleet.generated.ts`: the replay windows of the six fleet engines and the golden reference engine.

`npm test` fails if those artifacts are not what the script produces from these files (`npm run model:check`). `tests/model.test.mjs` re-evaluates the model on the test set and checks the fleet windows against the raw files.

The dataset is not copied into the Docker image (`.dockerignore`); the runtime only needs the generated artifacts.
