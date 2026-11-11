// Live check of the vLLM adviser: sends every combination of the three pipeline booleans to the
// configured server and compares each answer with the bounded policy. Exits non-zero on any
// disagreement, error or timeout.
//   npm run adviser:check                       # the server started by `npm run vllm:mac`
//   VLLM_URL=http://<gpu-host>:8000 VLLM_MODEL=Qwen/Qwen2.5-7B-Instruct npm run adviser:check
import { vllmAdvisor } from '../lib/maintenance/advisers.ts';

// Defaults match `npm run vllm:mac` and `npm run local:qwen`.
const url = process.env.VLLM_URL || 'http://127.0.0.1:8000';
const model = process.env.VLLM_MODEL || 'mlx-community/Qwen2.5-7B-Instruct-4bit';
const advise = vllmAdvisor(url, model, process.env.VLLM_API_KEY);
const expected = o =>
  !o.rulModelAvailable && o.gatewayStreaming && !o.unknownDependency
    ? 'restore_model'
    : o.rulModelAvailable && !o.gatewayStreaming && !o.unknownDependency
      ? 'resume_gateway'
      : 'escalate';

const rows = [];
for (const rulModelAvailable of [true, false])
  for (const gatewayStreaming of [true, false])
    for (const unknownDependency of [false, true]) {
      const observation = { rulModelAvailable, gatewayStreaming, unknownDependency };
      const started = performance.now();
      let answer;
      try {
        answer = await advise(observation);
      } catch (error) {
        answer = `error: ${error instanceof Error ? error.message : error}`;
      }
      rows.push({
        ...observation,
        policy: expected(observation),
        model: answer,
        agrees: answer === expected(observation),
        ms: Math.round(performance.now() - started),
      });
    }
console.table(rows);
const agreed = rows.filter(r => r.agrees).length;
const latencies = rows.map(r => r.ms).sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      server: url,
      model,
      agreement: `${agreed}/${rows.length}`,
      medianMs: latencies[Math.floor(latencies.length / 2)],
      maxMs: latencies.at(-1),
    },
    null,
    2,
  ),
);
if (agreed !== rows.length) process.exitCode = 1;
