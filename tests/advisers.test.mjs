import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { database } from './sqlite-adapter.mjs';
import { handleApi } from '../lib/maintenance/api.ts';
import {
  modelText,
  parseAction,
  selectAdvisor,
  SYSTEM_PROMPT,
  workersAiAdvisor,
  vllmAdvisor,
} from '../lib/maintenance/advisers.ts';

const observation = { rulModelAvailable: false, gatewayStreaming: true, unknownDependency: false };

test('adviser output is reduced to exactly one allowlisted action', () => {
  assert.equal(parseAction('{"action":"restore_model"}'), 'restore_model');
  assert.equal(parseAction('Sure! {"action": "resume_gateway"} is best.'), 'resume_gateway');
  assert.equal(parseAction('I would escalate this.'), 'escalate');
  for (const bad of ['', 'rm -rf /', '{"action":"drop_table"}', 'restore_model or escalate', null])
    assert.throws(() => parseAction(bad), /adviser_output_invalid/);
});

test('Workers AI adviser sends only the three booleans and parses the answer', async () => {
  const calls = [];
  const ai = {
    async run(model, input) {
      calls.push({ model, input });
      return { response: '{"action":"restore_model"}' };
    },
  };
  const advise = workersAiAdvisor(ai, '@cf/test/model');
  assert.equal(await advise(observation), 'restore_model');
  assert.equal(advise.label, 'Workers AI @cf/test/model');
  assert.equal(calls[0].model, '@cf/test/model');
  assert.deepEqual(JSON.parse(calls[0].input.messages[1].content), observation);
  assert.equal(calls[0].input.temperature, 0);
});

test('a slow or malformed model answer is rejected', async () => {
  const slow = workersAiAdvisor({ run: () => new Promise(() => {}) }, 'm', 20);
  await assert.rejects(slow(observation), /adviser_timeout/);
  const chatty = workersAiAdvisor(
    { run: async () => ({ response: 'run this shell script' }) },
    'm',
  );
  await assert.rejects(chatty(observation), /adviser_output_invalid/);
});

test('adviser selection: vLLM, then Workers AI, then deterministic policy only', () => {
  const ai = { run: async () => ({}) };
  assert.equal(
    selectAdvisor({ AI: ai, VLLM_URL: 'http://x' }).label,
    'vLLM Qwen/Qwen2.5-7B-Instruct',
  );
  assert.equal(
    selectAdvisor({ VLLM_URL: 'http://x', VLLM_MODEL: 'Qwen/Qwen2.5-7B-Instruct-AWQ' }).label,
    'vLLM Qwen/Qwen2.5-7B-Instruct-AWQ',
  );
  assert.equal(
    selectAdvisor({ AI: ai }).label,
    'Workers AI @cf/meta/llama-3.3-70b-instruct-fp8-fast',
  );
  assert.equal(selectAdvisor({ AI: ai, WORKERS_AI_MODEL: '@cf/x/y' }).label, 'Workers AI @cf/x/y');
  assert.equal(selectAdvisor({}), undefined);
});

/** A stand-in for `vllm serve` that records requests and answers like the OpenAI-compatible API. */
async function fakeVllm(t, answer) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    requests.push(request);
    const [status, reply] = await answer(request);
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
const chat = content => ({ choices: [{ message: { role: 'assistant', content } }] });

test('vLLM adviser uses the OpenAI-compatible API with structured output and three booleans', async t => {
  const vllm = await fakeVllm(t, async () => [200, chat('{"action":"restore_model"}')]);
  const advise = vllmAdvisor(`${vllm.url}/v1/`, 'Qwen/Qwen2.5-7B-Instruct', 'lab-key');
  assert.equal(await advise(observation), 'restore_model');
  const [request] = vllm.requests;
  assert.equal(request.path, '/v1/chat/completions');
  assert.equal(request.auth, 'Bearer lab-key');
  assert.equal(request.body.model, 'Qwen/Qwen2.5-7B-Instruct');
  assert.equal(request.body.temperature, 0);
  assert.equal(request.body.response_format.type, 'json_schema');
  assert.deepEqual(request.body.response_format.json_schema.schema.properties.action.enum, [
    'restore_model',
    'resume_gateway',
    'escalate',
  ]);
  assert.deepEqual(JSON.parse(request.body.messages[1].content), observation);
});

test('vLLM without structured output falls back; errors and slow answers are rejected', async t => {
  const strictless = await fakeVllm(t, async r =>
    r.body.response_format ? [400, { error: 'unsupported' }] : [200, chat('resume_gateway')],
  );
  assert.equal(await vllmAdvisor(strictless.url, 'm')(observation), 'resume_gateway');
  assert.equal(strictless.requests.length, 2);
  const down = await fakeVllm(t, async () => [500, { error: 'out of memory' }]);
  await assert.rejects(vllmAdvisor(down.url, 'm')(observation), /adviser_unavailable/);
  const slow = await fakeVllm(t, () => new Promise(r => setTimeout(() => r([200, chat('')]), 500)));
  await assert.rejects(vllmAdvisor(slow.url, 'm', undefined, 30)(observation), /adviser_timeout/);
  await assert.rejects(vllmAdvisor('http://127.0.0.1:1', 'm')(observation), /adviser_unavailable/);
  // The fallback shares the first request's deadline instead of starting a new one.
  const stalls = await fakeVllm(t, r =>
    r.body.response_format
      ? new Promise(done => setTimeout(() => done([400, { error: 'unsupported' }]), 40))
      : new Promise(done => setTimeout(() => done([200, chat('escalate')]), 400)),
  );
  const started = performance.now();
  await assert.rejects(
    vllmAdvisor(stalls.url, 'm', undefined, 120)(observation),
    /adviser_timeout/,
  );
  assert.ok(performance.now() - started < 350, 'one deadline for both requests');
});

async function drill(ai, fault = 'model_unavailable', settings = {}) {
  const storage = database(),
    pending = [];
  const env = { DB: storage.db, AI: ai, ...settings },
    ctx = { waitUntil: p => pending.push(p) };
  const call = (path, cookie, body = {}) =>
    handleApi(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
    );
  const cookie = (await call('/api/session', '')).headers.get('set-cookie').split(';')[0];
  await call('/api/assessments', cookie, { engineId: 'unit-25' });
  await call('/api/drills', cookie, { kind: fault });
  for (let n = 0; n < 3; n++) await call('/api/probe', cookie);
  while (pending.length) await Promise.all(pending.splice(0));
  const state = await (
    await handleApi(
      new Request('http://localhost/api/workspace', { headers: { cookie } }),
      env,
      ctx,
    )
  ).json();
  storage.close();
  return state;
}

test('alert → Workers AI agrees with the policy → verified recovery, reasoner recorded', async () => {
  const state = await drill({ run: async () => ({ response: '{"action":"restore_model"}' }) });
  assert.equal(state.incident.status, 'recovered');
  const diagnosis = state.incident.steps.find(s => s.phase === 'Diagnose');
  assert.match(
    diagnosis.detail,
    /Workers AI @cf\/meta\/llama-3\.3-70b-instruct-fp8-fast proposed restore_model; policy selected restore_model/,
  );
  assert.equal(state.assessments.filter(r => !r.probe).length, 1);
});

test('alert → Workers AI proposes a different repair → escalation, no change', async () => {
  const state = await drill({ run: async () => ({ response: '{"action":"resume_gateway"}' }) });
  assert.equal(state.incident.status, 'escalated');
  assert.equal(state.config.model, 'rul-model-missing');
  assert.equal(state.metrics.recoveries, 0);
});

test('alert → Workers AI unavailable → escalation instead of guessing', async () => {
  const state = await drill({
    run: async () => {
      throw new Error('quota exceeded');
    },
  });
  assert.equal(state.incident.status, 'escalated');
  assert.match(
    state.incident.steps.find(s => s.phase === 'Diagnose').detail,
    /proposed no valid answer \(model_unavailable\)/,
  );
});

test('model answers are read from both Workers AI response shapes', async () => {
  assert.equal(modelText({ response: 'a' }), 'a');
  assert.equal(
    modelText({ choices: [{ message: { content: 'b', reasoning_content: 'c' } }] }),
    'b',
  );
  const advise = workersAiAdvisor(
    {
      run: async () => ({
        choices: [
          {
            message: {
              content: '{"action":"resume_gateway"}',
              reasoning_content: 'restore_model or escalate?',
            },
          },
        ],
      }),
    },
    'm',
  );
  assert.equal(await advise(observation), 'resume_gateway');
  const timed = workersAiAdvisor({ run: () => new Promise(() => {}) }, 'm', 20);
  await assert.rejects(timed(observation), /adviser_timeout/);
});

test('JSON mode is requested, reasoning is ignored, and unsupported JSON mode falls back', async () => {
  assert.equal(
    parseAction('<think>restore_model or escalate?</think>{"action":"escalate"}'),
    'escalate',
  );
  assert.equal(
    parseAction('Considering "action": "resume_gateway"... final: {"action":"restore_model"}'),
    'restore_model',
  );
  assert.equal(parseAction({ action: 'resume_gateway' }), 'resume_gateway');
  const inputs = [];
  const strict = workersAiAdvisor(
    {
      run: async (_, input) => {
        inputs.push(input);
        return { response: { action: 'restore_model' } };
      },
    },
    'm',
  );
  assert.equal(await strict(observation), 'restore_model');
  assert.equal(inputs[0].response_format.type, 'json_schema');
  assert.deepEqual(inputs[0].response_format.json_schema.properties.action.enum, [
    'restore_model',
    'resume_gateway',
    'escalate',
  ]);
  let calls = 0;
  const fallback = workersAiAdvisor(
    {
      run: async (_, input) => {
        calls++;
        if (input.response_format) throw new Error('JSON Mode not supported');
        return { response: '{"action":"resume_gateway"}' };
      },
    },
    'm',
  );
  assert.equal(await fallback(observation), 'resume_gateway');
  assert.equal(calls, 2);
});

test('alert → vLLM Qwen2.5-7B agrees with the policy → verified recovery, reasoner recorded', async t => {
  const vllm = await fakeVllm(t, async () => [200, chat('{"action":"restore_model"}')]);
  const state = await drill(undefined, 'model_unavailable', { VLLM_URL: vllm.url });
  assert.equal(state.incident.status, 'recovered');
  assert.match(
    state.incident.steps.find(s => s.phase === 'Diagnose').detail,
    /vLLM Qwen\/Qwen2\.5-7B-Instruct proposed restore_model; policy selected restore_model/,
  );
  assert.equal(vllm.requests.length, 1);
  assert.ok(!JSON.stringify(vllm.requests).includes('unit-25'), 'no fleet data reaches the model');
  // The agent's observation uses exactly the fields the prompt defines.
  const sent = JSON.parse(vllm.requests[0].body.messages[1].content);
  assert.deepEqual(sent, {
    rulModelAvailable: false,
    gatewayStreaming: true,
    unknownDependency: false,
  });
  for (const field of Object.keys(sent)) assert.ok(SYSTEM_PROMPT.includes(field), field);
});
