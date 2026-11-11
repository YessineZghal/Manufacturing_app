# Architecture decision records

Short records of the decisions that shape the system: what was decided, the alternatives, and why. Records 0001–0005 are adapted from Service Recovery Lab; 0006 is specific to predictive maintenance.

| # | Decision | Status |
|---|---|---|
| [0001](0001-alert-on-operator-impact.md) | Alert on operator-journey impact, not infrastructure metrics | Accepted |
| [0002](0002-bounded-agent-autonomy.md) | Bounded agent autonomy with an advisory language model | Accepted |
| [0003](0003-verification-defines-recovery.md) | Verification against the live journey, including prediction accuracy, defines recovery | Accepted |
| [0004](0004-edge-serverless-runtime.md) | One edge-serverless artifact for local, Docker and cloud | Accepted |
| [0005](0005-opentelemetry-as-evidence-standard.md) | OpenTelemetry as the telemetry and evidence standard | Accepted |
| [0006](0006-explainable-rul-model-trained-offline.md) | An explainable RUL model trained offline and served as weights | Accepted |
