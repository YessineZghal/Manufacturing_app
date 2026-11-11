import {
  assess,
  recordAttempt,
  startDrill,
  manualRestore,
  fleet,
  serviceFault,
  traceId,
  uuid,
  VERIFICATION_TOLERANCE,
} from './domain.ts';
import { Repository, RepoError, hashToken, newToken, type Database } from './repository.ts';
import { respond } from './agent.ts';
import { selectAdvisor, type WorkersAI } from './advisers.ts';
import { exportAttempt, toOtlp } from './otel.ts';
import { executiveReport } from './report.ts';
import { MODEL } from './model.generated.ts';
import { REFERENCE } from './fleet.generated.ts';
import { CRITICAL_RUL, WATCH_RUL } from './model.ts';
export interface Environment {
  DB: Database;
  AI?: WorkersAI;
  WORKERS_AI_MODEL?: string;
  VLLM_URL?: string;
  VLLM_MODEL?: string;
  VLLM_API_KEY?: string;
  BUILD_REVISION?: string;
  DEPLOYMENT_STAGE?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
}
export interface Context {
  waitUntil(promise: Promise<unknown>): void;
}
/** What the UI and evidence show about the model: provenance and quality, not the weights. */
const modelCard = {
  id: MODEL.id,
  dataset: MODEL.dataset,
  algorithm: MODEL.algorithm,
  sensors: MODEL.sensors,
  window: MODEL.window,
  rulCap: MODEL.rulCap,
  evaluation: MODEL.evaluation,
  thresholds: { criticalRul: CRITICAL_RUL, watchRul: WATCH_RUL },
  verification: {
    referenceEngine: REFERENCE.label,
    actualRul: REFERENCE.actualRul,
    toleranceCycles: VERIFICATION_TOLERANCE,
  },
};
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
const MAX_BODY_BYTES = 4096;
/** Oversized bodies are read and discarded up to this size, then cancelled. */
const MAX_DRAIN_BYTES = 1024 * 1024;
/**
 * Reads at most MAX_BODY_BYTES. A rejected body is drained before the response is sent: replying
 * while the client is still uploading breaks the next request on the same keep-alive connection
 * in the local workerd runtime.
 */
async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_DRAIN_BYTES) {
      await reader.cancel();
      break;
    }
    if (size <= MAX_BODY_BYTES) chunks.push(value);
  }
  if (size > MAX_BODY_BYTES) throw new RepoError(413, 'request_too_large');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
/** Drains the body of a request rejected before its body is parsed (see readBody). */
const discard = (request: Request) =>
  readBody(request).then(
    () => {},
    () => {},
  );
async function parse(request: Request) {
  const json = request.headers.get('content-type')?.startsWith('application/json');
  const text = await readBody(request);
  if (!json) throw new RepoError(415, 'json_required');
  try {
    return JSON.parse(text);
  } catch {
    throw new RepoError(400, 'invalid_json');
  }
}
export async function handleApi(
  request: Request,
  env: Environment,
  ctx: Context,
): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname,
    tid = traceId();
  try {
    if (request.method !== 'GET' && request.method !== 'POST') {
      await discard(request);
      return reply({ error: 'method_not_allowed' }, 405);
    }
    if (request.method === 'GET' && path === '/api/health')
      return reply({
        status: 'ok',
        service: 'predictive-maintenance-lab',
        revision: env.BUILD_REVISION || 'development',
        scope: 'process-health; not an RUL assessment journey check',
      });
    if (request.method === 'POST') {
      const origin = request.headers.get('origin');
      if (
        (origin && origin !== url.origin) ||
        request.headers.get('sec-fetch-site') === 'cross-site'
      ) {
        await discard(request);
        return reply({ error: 'origin_not_allowed' }, 403);
      }
    }
    if (!env.DB) throw new RepoError(503, 'database_unavailable');
    const repo = new Repository(env.DB);
    const token = request.headers
      .get('cookie')
      ?.match(/(?:^|;\s*)pml_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    const current = token ? await repo.byToken(await hashToken(token)) : null;
    if (path === '/api/session' && request.method === 'POST') {
      await parse(request);
      if (current) return reply({ workspaceId: current.id });
      const raw = newToken();
      const s = await repo.create(await hashToken(raw));
      return reply({ workspaceId: s.id }, 201, {
        'set-cookie': `pml_session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${url.protocol === 'https:' ? '; Secure' : ''}`,
      });
    }
    if (!current) {
      await discard(request);
      return reply({ error: 'workspace_required' }, 401);
    }
    if (request.method === 'GET' && (path === '/api/workspace' || path === '/api/evidence')) {
      const s = await repo.read(current.id);
      const snapshot = {
        ...s,
        engines: fleet(s),
        serviceAvailable: !serviceFault(s),
        model: modelCard,
      };
      return reply(
        path === '/api/evidence'
          ? {
              format: 'predictive-maintenance-evidence/v1',
              exportedAt: new Date().toISOString(),
              dataClassification: 'public-benchmark',
              scope:
                'one authenticated workspace; controlled lab replay of NASA C-MAPSS FD001, not production plant resilience',
              ...snapshot,
            }
          : snapshot,
        200,
        path === '/api/evidence'
          ? { 'content-disposition': 'attachment; filename="maintenance-recovery-evidence.json"' }
          : {},
      );
    }
    if (request.method === 'GET' && path === '/api/report') {
      return reply(executiveReport(await repo.read(current.id)));
    }
    if (request.method === 'GET' && path === '/api/telemetry/otlp') {
      const s = await repo.read(current.id);
      return reply(
        {
          format: 'otlp-json',
          note: 'POST each section to <collector>/v1/traces, /v1/logs and /v1/metrics',
          ...toOtlp(s, s.traces, env.DEPLOYMENT_STAGE || 'local'),
        },
        200,
        { 'content-disposition': 'attachment; filename="assessment-telemetry.otlp.json"' },
      );
    }
    if (request.method !== 'POST') return reply({ error: 'not_found' }, 404);
    const body = await parse(request);
    if (path === '/api/drills') {
      const { result } = await repo.mutate(current.id, s => startDrill(s, body?.kind));
      return reply(result, result.status);
    }
    if (path === '/api/restore') {
      const { result } = await repo.mutate(current.id, manualRestore);
      return reply(result, result.status);
    }
    if (path === '/api/assessments' || path === '/api/probe') {
      const probe = path === '/api/probe',
        started = performance.now();
      const key = request.headers.get('idempotency-key') || '';
      const { result } = await repo.mutate(current.id, s =>
        assess(s, probe ? { engineId: 'reference' } : body, key, probe),
      );
      const { state } = await repo.mutate(current.id, s =>
        recordAttempt(s, result, probe, tid, performance.now() - started),
      );
      const attempt = state.traces.at(-1);
      if (attempt?.traceId === tid && env.OTEL_EXPORTER_OTLP_ENDPOINT)
        ctx.waitUntil(exportAttempt(env, state, attempt).catch(() => {}));
      console.log(
        JSON.stringify({
          event: 'assessment.completed',
          trace_id: tid,
          status: result.status,
          outcome: result.code,
          journey: probe ? 'synthetic_probe' : 'operator_assessment',
        }),
      );
      if (state.incident?.status === 'alerted') {
        const advisor = selectAdvisor(env);
        ctx.waitUntil(
          respond(
            repo,
            current.id,
            async negative => {
              const verified = await handleApi(
                new Request(new URL(negative ? '/api/assessments' : '/api/probe', url), {
                  method: 'POST',
                  headers: {
                    cookie: request.headers.get('cookie') || '',
                    'content-type': 'application/json',
                    'idempotency-key': `agent_${uuid()}`,
                  },
                  body: JSON.stringify(negative ? { engineId: 'invalid-engine' } : {}),
                }),
                env,
                ctx,
              );
              const data = (await verified.json()) as { assessment?: { id: string } };
              return { status: verified.status, assessmentId: data.assessment?.id };
            },
            advisor,
          ).catch(() => {}),
        );
      }
      return reply({ ...result, traceId: tid }, result.status, { 'x-trace-id': tid });
    }
    return reply({ error: 'not_found' }, 404);
  } catch (error) {
    const known = error instanceof RepoError;
    console.error(
      JSON.stringify({
        event: 'api.error',
        trace_id: tid,
        code: known ? error.code : 'internal_error',
      }),
    );
    return reply(
      { error: known ? error.code : 'internal_error', traceId: tid },
      known ? error.status : 500,
      { 'x-trace-id': tid },
    );
  }
}
