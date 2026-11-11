// Runs the app with the vLLM adviser pointed at a local vllm-metal server (Apple silicon).
// Start the model first with `npm run vllm:mac`, then run `npm run local:qwen`.
process.env.VLLM_URL ??= 'http://127.0.0.1:8000';
process.env.VLLM_MODEL ??= 'mlx-community/Qwen2.5-7B-Instruct-4bit';
await import('./local.mjs');
