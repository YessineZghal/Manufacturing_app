import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { database } from './sqlite-adapter.mjs';
import { handleApi } from '../lib/maintenance/api.ts';
import { Repository, hashToken } from '../lib/maintenance/repository.ts';
import { respond } from '../lib/maintenance/agent.ts';
import { startDrill, recordAttempt, manualRestore } from '../lib/maintenance/domain.ts';
function lab(file) {
  const storage = database(file),
    pending = [];
  const env = { DB: storage.db },
    ctx = {
      waitUntil(p) {
        pending.push(p);
      },
    };
  return {
    storage,
    env,
    ctx,
    async drain() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
    async call(
      path,
      {
        cookie = '',
        body,
        method = body === undefined ? 'GET' : 'POST',
        key = crypto.randomUUID(),
        headers = {},
      } = {},
    ) {
      return handleApi(
        new Request(`http://localhost${path}`, {
          method,
          headers: {
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            cookie,
            'idempotency-key': key,
            ...headers,
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
        env,
        ctx,
      );
    },
  };
}
async function session(l) {
  const r = await l.call('/api/session', { body: {} });
  assert.equal(r.status, 201);
  return r.headers.get('set-cookie').split(';')[0];
}
test('session cookies protect isolated persistent workspaces', async t => {
  const l = lab();
  t.after(() => l.storage.close());
  const a = await session(l),
    b = await session(l);
  assert.match(a, /pml_session=[a-f0-9]{64}/);
  await l.call('/api/assessments', { cookie: a, body: { engineId: 'unit-25' } });
  const sa = await (await l.call('/api/workspace', { cookie: a })).json(),
    sb = await (await l.call('/api/workspace', { cookie: b })).json();
  assert.equal(sa.assessments.length, 1);
  assert.equal(sb.assessments.length, 0);
  assert.notEqual(sa.id, sb.id);
  assert.equal((await l.call(`/api/workspace?id=${sa.id}`, { cookie: b })).status, 200);
  assert.equal((await l.call('/api/workspace')).status, 401);
  assert.equal(
    (await l.call('/api/workspace', { cookie: 'pml_session=' + 'a'.repeat(64) })).status,
    401,
  );
  assert.equal(
    (
      await l.call('/api/drills', {
        cookie: a,
        body: { kind: 'gateway_paused' },
        headers: { origin: 'https://attacker.example' },
      })
    ).status,
    403,
  );
});
test('concurrent API assessments never over-ingest or duplicate an idempotency key', async t => {
  const l = lab();
  t.after(() => l.storage.close());
  const cookie = await session(l);
  const responses = await Promise.all(
    Array.from({ length: 16 }, (_, n) =>
      l.call('/api/assessments', { cookie, body: { engineId: 'unit-25' }, key: `parallel_${n}` }),
    ),
  );
  assert.equal(responses.filter(r => r.status === 201).length, 12);
  assert.ok(responses.every(r => [201, 409].includes(r.status)));
  const c = await session(l);
  const same = await Promise.all(
    Array.from({ length: 6 }, () =>
      l.call('/api/assessments', { cookie: c, body: { engineId: 'unit-71' }, key: 'same_key_001' }),
    ),
  );
  assert.ok(same.every(r => [200, 201].includes(r.status)));
  const state = await (await l.call('/api/workspace', { cookie: c })).json();
  assert.equal(state.assessments.length, 1);
});
for (const fault of ['model_unavailable', 'gateway_paused'])
  test(`alert invokes responder and verifies recovery: ${fault}`, async t => {
    const l = lab();
    t.after(() => l.storage.close());
    const cookie = await session(l);
    const baseline = await (
      await l.call('/api/assessments', {
        cookie,
        body: { engineId: 'unit-25' },
        key: 'baseline_01',
      })
    ).json();
    await l.call('/api/drills', { cookie, body: { kind: fault } });
    assert.equal((await l.call('/api/health')).status, 200);
    for (let n = 0; n < 3; n++)
      assert.equal((await l.call('/api/probe', { cookie, body: {} })).status, 503);
    await l.drain();
    const s = await (await l.call('/api/workspace', { cookie })).json();
    assert.equal(s.incident.status, 'recovered');
    assert.equal(s.incident.verification.positive, 201);
    assert.equal(s.incident.verification.negative, 422);
    assert.equal(s.incident.verification.persisted, true);
    assert.equal(s.incident.verification.accurate, true);
    assert.ok(s.incident.verification.absoluteError <= 15);
    assert.ok(s.assessments.some(r => r.id === baseline.assessment.id));
    assert.equal(s.metrics.recoveries, 1);
    assert.equal(s.engines[0].remaining, 11);
    assert.equal(s.incident.steps.filter(v => v.phase === 'Repair').length, 1);
    assert.equal(s.traces.filter(v => v.status === 503).length, 3);
  });
test('unknown failure escalates without repair; owner can restore', async t => {
  const l = lab();
  t.after(() => l.storage.close());
  const cookie = await session(l);
  await l.call('/api/drills', { cookie, body: { kind: 'unknown_dependency' } });
  for (let n = 0; n < 3; n++) await l.call('/api/probe', { cookie, body: {} });
  await l.drain();
  let s = await (await l.call('/api/workspace', { cookie })).json();
  assert.equal(s.incident.status, 'escalated');
  assert.equal(s.config.unknownFault, true);
  assert.equal(s.metrics.recoveries, 0);
  await l.call('/api/restore', { cookie, body: {} });
  s = await (await l.call('/api/workspace', { cookie })).json();
  assert.equal(s.incident.status, 'cancelled');
  assert.equal(s.serviceAvailable, true);
});
test('telemetry correlates signals and excludes credentials and payload fields', async t => {
  const l = lab();
  t.after(() => l.storage.close());
  const cookie = await session(l);
  const r = await l.call('/api/assessments', {
    cookie,
    body: { engineId: 'unit-25', privateNote: 'DO_NOT_EXPORT_PRIVATE_NOTE' },
  });
  const response = await r.json();
  const evidence = await (await l.call('/api/evidence', { cookie })).json();
  assert.equal(response.traceId, r.headers.get('x-trace-id'));
  assert.equal(evidence.traces[0].traceId, response.traceId);
  assert.equal(evidence.traces[0].metric.value, 1);
  assert.equal(evidence.traces[0].log.outcome, 'assessment_recorded');
  const data = JSON.stringify(evidence);
  assert.ok(!data.includes('DO_NOT_EXPORT_PRIVATE_NOTE'));
  assert.ok(!data.includes(cookie.split('=')[1]));
  assert.ok(!data.includes('token_hash'));
});
test('database survives closing and reopening with the same migration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pml-persistence-')),
    file = join(dir, 'test.sqlite');
  let l = lab(file);
  const cookie = await session(l);
  await l.call('/api/assessments', { cookie, body: { engineId: 'unit-25' } });
  l.storage.close();
  l = lab(file);
  assert.equal((await (await l.call('/api/workspace', { cookie })).json()).assessments.length, 1);
  l.storage.close();
  rmSync(file);
});
test('invalid payloads and oversized bodies fail predictably', async t => {
  const l = lab();
  t.after(() => l.storage.close());
  const cookie = await session(l);
  assert.equal(
    (await l.call('/api/assessments', { cookie, body: { engineId: 'missing' } })).status,
    422,
  );
  const r = await handleApi(
    new Request('http://localhost/api/assessments', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{invalid',
    }),
    l.env,
    l.ctx,
  );
  assert.equal(r.status, 400);
  const large = await l.call('/api/assessments', { cookie, body: { padding: 'x'.repeat(5000) } });
  assert.equal(large.status, 413);
});
test('rejected bodies are always consumed so the connection stays usable', async t => {
  const l = lab();
  t.after(() => l.storage.close());
  const cookie = await session(l);
  const stream = text =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  const send = (body, headers) =>
    new Request('http://localhost/api/assessments', {
      method: 'POST',
      headers: { cookie, 'idempotency-key': 'body_check_001', ...headers },
      body,
      duplex: 'half',
    });
  const declared = send(stream('x'.repeat(5000)), {
    'content-type': 'application/json',
    'content-length': '5000',
  });
  assert.equal((await handleApi(declared, l.env, l.ctx)).status, 413);
  assert.equal(declared.bodyUsed, true);
  const undeclared = send(stream(JSON.stringify({ pad: 'x'.repeat(5000) })), {
    'content-type': 'application/json',
  });
  assert.equal((await handleApi(undeclared, l.env, l.ctx)).status, 413);
  assert.equal(undeclared.bodyUsed, true);
  const wrongType = send(stream('{}'), { 'content-type': 'text/plain' });
  assert.equal((await handleApi(wrongType, l.env, l.ctx)).status, 415);
  assert.equal(wrongType.bodyUsed, true);
  for (const [request, status] of [
    [send(stream('{}'), { 'content-type': 'application/json', cookie: '' }), 401],
    [
      send(stream('{}'), { 'content-type': 'application/json', origin: 'https://evil.example' }),
      403,
    ],
    [
      new Request('http://localhost/api/assessments', {
        method: 'PUT',
        body: stream('{}'),
        duplex: 'half',
      }),
      405,
    ],
  ]) {
    assert.equal((await handleApi(request, l.env, l.ctx)).status, status);
    assert.equal(request.bodyUsed, true, `body consumed before the ${status}`);
  }
  const ok = send(stream(JSON.stringify({ engineId: 'unit-25' })), {
    'content-type': 'application/json',
  });
  assert.equal((await handleApi(ok, l.env, l.ctx)).status, 201);
});
test('actual HTTP boundary supports cookies, assessment and reload', async t => {
  const l = lab();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const response = await handleApi(
      new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: req.headers,
        ...(body.length ? { body } : {}),
      }),
      l.env,
      l.ctx,
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise(r => server.close(r));
    l.storage.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const first = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const cookie = first.headers.get('set-cookie').split(';')[0];
  const assessment = await fetch(`${base}/api/assessments`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'idempotency-key': 'http_boundary_1' },
    body: JSON.stringify({ engineId: 'unit-25' }),
  });
  assert.equal(assessment.status, 201);
  assert.equal(
    (await (await fetch(`${base}/api/workspace`, { headers: { cookie } })).json()).assessments
      .length,
    1,
  );
});
async function alerted(l) {
  const cookie = await session(l);
  const repo = new Repository(l.storage.db),
    hash = await hashToken(cookie.split('=')[1]),
    s = await repo.byToken(hash);
  await repo.mutate(s.id, state => {
    startDrill(state, 'model_unavailable');
    for (let n = 0; n < 3; n++)
      recordAttempt(state, { status: 503, code: 'model_unavailable' }, true, `fault${n}`, 1);
  });
  return { repo, id: s.id };
}
test('failed verification never reports recovered', async t => {
  const l = lab();
  t.after(() => l.storage.close());
  const { repo, id } = await alerted(l);
  await respond(repo, id, async () => ({ status: 503 }));
  const s = await repo.read(id);
  assert.equal(s.incident.status, 'escalated');
  assert.equal(s.metrics.recoveries, 0);
});
test('an inaccurate model fails verification even when every probe returns 2xx/4xx as expected', async t => {
  const l = lab();
  t.after(() => l.storage.close());
  const { repo, id } = await alerted(l);
  await repo.mutate(id, s => {
    s.assessments.push({
      id: 'drifted-probe',
      engineId: 'reference',
      key: 'drifted_probe_01',
      createdAt: Date.now(),
      probe: true,
      cycle: 1,
      predictedRul: 120,
      actualRul: 38,
      health: 'healthy',
    });
  });
  await respond(repo, id, async negative =>
    negative ? { status: 422 } : { status: 201, assessmentId: 'drifted-probe' },
  );
  const s = await repo.read(id);
  assert.equal(s.incident.status, 'escalated');
  assert.equal(s.incident.verification.persisted, true);
  assert.equal(s.incident.verification.accurate, false);
  assert.equal(s.incident.verification.absoluteError, 82);
  assert.equal(s.metrics.recoveries, 0);
});
test('adviser disagreement cannot authorize a different repair', async t => {
  const l = lab();
  t.after(() => l.storage.close());
  const { repo, id } = await alerted(l);
  await respond(
    repo,
    id,
    async () => ({ status: 201 }),
    async () => 'resume_gateway',
  );
  const s = await repo.read(id);
  assert.equal(s.incident.status, 'escalated');
  assert.equal(s.config.model, 'rul-model-missing');
});
test('stale agent action cannot overwrite an owner restore', async t => {
  const l = lab();
  t.after(() => l.storage.close());
  const { repo, id } = await alerted(l);
  await respond(
    repo,
    id,
    async () => ({ status: 201 }),
    async () => {
      await repo.mutate(id, manualRestore);
      return 'restore_model';
    },
  );
  const s = await repo.read(id);
  assert.equal(s.incident.status, 'cancelled');
  assert.equal(s.config.model, 'rul-fd001-v2');
  assert.equal(s.metrics.recoveries, 0);
});
test('concurrent responder invocations claim a single repair', async t => {
  const l = lab();
  t.after(() => l.storage.close());
  const { repo, id } = await alerted(l);
  let calls = 0;
  await Promise.all([
    respond(repo, id, async () => {
      calls++;
      return { status: 503 };
    }),
    respond(repo, id, async () => {
      calls++;
      return { status: 503 };
    }),
  ]);
  const s = await repo.read(id);
  assert.equal(s.incident.steps.filter(v => v.phase === 'Repair').length, 1);
  assert.equal(calls, 2);
});
test('a failed responder run never escalates an incident another run is repairing', async t => {
  const l = lab();
  t.after(() => l.storage.close());
  // The run's first write (its claim) fails, as under heavy contention.
  const failingClaim = (repo, beforeFailing) => {
    let first = true;
    return Object.assign(Object.create(repo), {
      async mutate(id, change) {
        if (!first) return repo.mutate(id, change);
        first = false;
        await beforeFailing();
        throw new Error('workspace_busy_retry');
      },
    });
  };
  const claimed = await alerted(l);
  await respond(
    failingClaim(claimed.repo, () =>
      claimed.repo.mutate(claimed.id, s => {
        s.incident.status = 'diagnosing';
        s.incident.runId = 'winning-run';
      }),
    ),
    claimed.id,
    async () => ({ status: 503 }),
  );
  assert.equal((await claimed.repo.read(claimed.id)).incident.status, 'diagnosing');
  const unclaimed = await alerted(l);
  await respond(
    failingClaim(unclaimed.repo, async () => {}),
    unclaimed.id,
    async () => ({ status: 503 }),
  );
  const s = await unclaimed.repo.read(unclaimed.id);
  assert.equal(s.incident.status, 'escalated');
  assert.equal(s.incident.steps.at(-1).tool, 'agent_error');
});
