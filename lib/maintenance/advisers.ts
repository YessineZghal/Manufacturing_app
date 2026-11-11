import type { Advisor, Observation } from './agent.ts';

/** Default Workers AI model (supports JSON mode). Override with the WORKERS_AI_MODEL variable. */
export const DEFAULT_WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** The only answers an adviser may give. Anything else counts as no answer. */
export const ALLOWED_ACTIONS = ['restore_model', 'resume_gateway', 'escalate'] as const;

export const SYSTEM_PROMPT = [
  'You are the second-opinion reasoner for an on-call agent in a predictive-maintenance plant.',
  'The user message is a JSON object with three booleans about the remaining-useful-life (RUL) pipeline:',
  '- rulModelAvailable: the RUL model referenced by the pipeline exists in the model registry.',
  '- gatewayStreaming: the sensor gateway is delivering engine sensor cycles.',
  '- unknownDependency: an unrecognised plant dependency is failing.',
  'Choose exactly one action:',
  '- restore_model: rulModelAvailable is false, gatewayStreaming is true, unknownDependency is false.',
  '- resume_gateway: gatewayStreaming is false, rulModelAvailable is true, unknownDependency is false.',
  '- escalate: any other combination.',
  'Answer only with JSON: {"action":"<one action>"}. Never suggest code or other actions.',
].join('\n');

/** JSON Schema for structured output (Workers AI JSON mode, vLLM): exactly one allowlisted action. */
export const ACTION_SCHEMA = {
  type: 'object',
  properties: { action: { type: 'string', enum: [...ALLOWED_ACTIONS] } },
  required: ['action'],
};

/** Extracts one allowed action from model output, or throws. Reasoning blocks are ignored. */
export function parseAction(output: unknown): string {
  const raw = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const keyed = [...text.matchAll(/"action"\s*:\s*"([a-z_]+)"/g)].map(m => m[1]);
  const last = keyed.at(-1);
  if (last && (ALLOWED_ACTIONS as readonly string[]).includes(last)) return last;
  const found = ALLOWED_ACTIONS.filter(action => text.includes(action));
  if (found.length === 1) return found[0];
  throw new Error('adviser_output_invalid');
}

/**
 * Extracts the answer text from the response shapes Workers AI models use: `{ response }` or the
 * OpenAI-compatible `{ choices: [{ message: { content } }] }`. Reasoning traces are ignored.
 */
export function modelText(result: unknown): unknown {
  const r = result as {
    response?: unknown;
    choices?: { message?: { content?: unknown } }[];
  } | null;
  if (r && typeof r === 'object') {
    if (r.response !== undefined && r.response !== null) return r.response;
    const content = r.choices?.[0]?.message?.content;
    if (content !== undefined && content !== null) return content;
  }
  return result;
}

export interface WorkersAI {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Cloudflare Workers AI (free daily allocation). Used automatically when the AI binding exists. */
export function workersAiAdvisor(ai: WorkersAI, model: string, timeoutMs = 15000): Advisor {
  const advise: Advisor = async (observation: Observation) => {
    const request = {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(observation) },
      ],
      max_tokens: 256,
      temperature: 0,
    };
    // One deadline covers both calls, so the fallback cannot double the wait.
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('adviser_timeout')), timeoutMs),
    );
    const timed = (call: Promise<unknown>) => Promise.race([call, deadline]);
    let result: unknown;
    try {
      // JSON mode constrains the answer to the action schema on models that support it.
      result = await timed(
        ai.run(model, {
          ...request,
          response_format: { type: 'json_schema', json_schema: ACTION_SCHEMA },
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'adviser_timeout') throw error;
      result = await timed(ai.run(model, request)); // model without JSON mode support
    }
    return parseAction(modelText(result));
  };
  advise.label = `Workers AI ${model}`;
  return advise;
}

/** Default model served by vLLM. Override with the VLLM_MODEL variable. */
export const DEFAULT_VLLM_MODEL = 'Qwen/Qwen2.5-7B-Instruct';

/**
 * A vLLM server (`vllm serve Qwen/Qwen2.5-7B-Instruct`) through its OpenAI-compatible API.
 * Structured output constrains the answer to the action schema; a server that rejects the
 * schema request is asked again without it, and the answer is still parsed against the allowlist.
 */
export function vllmAdvisor(
  baseUrl: string,
  model: string,
  apiKey?: string,
  timeoutMs = 20000,
): Advisor {
  const endpoint = `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`;
  const request = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: '' },
    ],
    max_tokens: 64,
    temperature: 0,
  };
  const call = async (body: Record<string, unknown>, signal: AbortSignal) => {
    try {
      return await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        signal,
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'adviser_timeout'
          : 'adviser_unavailable',
      );
    }
  };
  const advise: Advisor = async (observation: Observation) => {
    // One deadline covers the structured request and its fallback.
    const signal = AbortSignal.timeout(timeoutMs);
    const body = {
      ...request,
      messages: [request.messages[0], { role: 'user', content: JSON.stringify(observation) }],
    };
    let response = await call(
      {
        ...body,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'repair_action', schema: ACTION_SCHEMA, strict: true },
        },
      },
      signal,
    );
    if (response.status === 400) {
      await response.body?.cancel(); // server without structured output: ask again without it
      response = await call(body, signal);
    }
    if (!response.ok) throw new Error('adviser_unavailable');
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new Error('adviser_output_invalid');
    }
    return parseAction(modelText(result));
  };
  advise.label = `vLLM ${model}`;
  return advise;
}

export interface AdviserSettings {
  AI?: WorkersAI;
  WORKERS_AI_MODEL?: string;
  VLLM_URL?: string;
  VLLM_MODEL?: string;
  VLLM_API_KEY?: string;
}

/** vLLM when configured, otherwise Workers AI in the cloud, otherwise the deterministic policy alone. */
export function selectAdvisor(env: AdviserSettings): Advisor | undefined {
  if (env.VLLM_URL)
    return vllmAdvisor(env.VLLM_URL, env.VLLM_MODEL || DEFAULT_VLLM_MODEL, env.VLLM_API_KEY);
  if (env.AI) return workersAiAdvisor(env.AI, env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL);
  return undefined;
}
