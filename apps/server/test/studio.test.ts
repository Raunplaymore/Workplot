import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  workflowVersionSchema,
  type RunInput,
  type WorkflowDefinition,
} from '@studio/contracts';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { openStudioStore, StoreNotFound } from '../src/studio-store.js';

const host = '127.0.0.1:4310';
const origin = 'http://' + host;
const browser = { host, origin, 'x-studio-client': 'browser' };
const definition: WorkflowDefinition = {
  name: '매장 소개 작업',
  steps: [
    {
      id: 'draft',
      title: '초안 작성',
      kind: 'task',
      instructions: '가상 자료로 초안을 작성한다.',
      position: { x: 0, y: 0 },
    },
    {
      id: 'review',
      title: '검토',
      kind: 'review',
      position: { x: 200, y: 30 },
    },
  ],
  links: [{ from: 'draft', to: 'review' }],
};
let directory: string;
let path: string;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'studio-t02-'));
  path = join(directory, 'studio.sqlite');
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(directory, { recursive: true, force: true });
});
async function session(server: Awaited<ReturnType<typeof buildApp>>) {
  const response = await server.inject({
    method: 'POST',
    url: '/api/session',
    headers: browser,
  });
  expect(response.statusCode).toBe(204);
  expect(response.headers['cache-control']).toBe('no-store');
  const cookie = String(response.headers['set-cookie']);
  expect(cookie).toMatch(
    /^studio_session=[a-f0-9]{64}; Path=\/api; HttpOnly; SameSite=Strict$/,
  );
  return { ...browser, cookie: cookie.slice(0, cookie.indexOf(';')) };
}

test('migrates v1 and restores distinct workflow versions and pinned runtime metadata in a new process', async () => {
  const previous = new Database(path);
  previous.exec(`
    CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO app_metadata VALUES ('schema_version', '1'), ('existing_setting', 'preserved');
  `);
  previous.close();

  app = await buildApp(path);
  const headers = await session(app);
  const created = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: definition,
    headers,
  });
  expect(created.statusCode).toBe(201);
  const v1 = workflowVersionSchema.parse(created.json());
  const url = '/api/workflows/' + v1.id;
  const update = {
    baseVersion: 1,
    definition: { ...definition, name: '수정한 작업 흐름' },
  };
  const updates = await Promise.all([
    app.inject({ method: 'PUT', url, headers, payload: update }),
    app.inject({ method: 'PUT', url, headers, payload: update }),
  ]);
  expect(updates.map((res) => res.statusCode).sort()).toEqual([200, 409]);
  const v2 = workflowVersionSchema.parse(
    updates.find((response) => response.statusCode === 200)?.json(),
  );
  expect(v2.version).toBe(2);
  expect(v1.definition).toEqual(definition);

  const db = new Database(path);
  const store = openStudioStore(db);
  const input: RunInput = {
    workflowId: v1.id,
    workflowVersion: 1,
    status: 'completed',
    cliVersion: '0.166.0',
    sessionId: 'fixture-session',
    process: { ownerId: randomUUID(), pid: 4321 },
    results: ['draft.md', 'revised.md'],
  };
  const run = store.recordRun(input);
  expect(() => store.recordRun({ ...input, workflowVersion: 3 })).toThrow(
    StoreNotFound,
  );
  expect(() => store.recordRun({ ...input, workflowId: randomUUID() })).toThrow(
    StoreNotFound,
  );
  db.close();
  await app.close();
  app = undefined;

  const verify = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import Database from 'better-sqlite3';
    import { buildApp } from './apps/server/src/app.ts';
    import { openStudioStore } from './apps/server/src/studio-store.ts';
    const [path, url, runId, oldCookie] = process.argv.slice(1);
    const headers = { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310' };
    const app = await buildApp(path);
    let response = await app.inject({ url, headers: { ...headers, cookie: oldCookie } });
    if (response.statusCode !== 401) throw Error('expired session accepted');
    response = await app.inject({ method: 'POST', url: '/api/session',
      headers: { ...headers, 'x-studio-client': 'browser' } });
    headers.cookie = response.headers['set-cookie'].split(';')[0];
    async function read(url) {
      const result = await app.inject({ url, headers });
      if (result.statusCode !== 200) throw Error('read failed: ' + result.statusCode);
      return result.json();
    }
    const db = new Database(path);
    const runtime = openStudioStore(db).run(runId);
    const settings = db.prepare('SELECT key, value FROM app_metadata ORDER BY key').all();
    db.close();
    console.log(JSON.stringify({
      old: await read(url + '/versions/1'), latest: await read(url),
      list: await read('/api/workflows'), run: await read('/api/runs/' + runId), runtime, settings,
    }));
    await app.close();
  `,
      path,
      url,
      run.id,
      headers.cookie,
    ],
    {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  expect(verify.status, verify.stderr).toBe(0);
  expect(JSON.parse(verify.stdout)).toEqual({
    old: v1,
    latest: v2,
    list: [
      { id: v2.id, version: 2, name: v2.definition.name, savedAt: v2.savedAt },
    ],
    run,
    runtime: {
      summary: run,
      sessionId: input.sessionId,
      process: input.process,
      results: input.results,
      logRef: `runs/${run.id}/events.jsonl`,
      resultRefs: input.results.map((file) => `runs/${run.id}/${file}`),
    },
    settings: [
      { key: 'existing_setting', value: 'preserved' },
      { key: 'schema_version', value: '2' },
    ],
  });
}, 15_000);

test('blocks unauthenticated writes, untrusted origins and rebinding hosts before mutation', async () => {
  app = await buildApp(path);
  const headers = await session(app);
  const save = (headers: Record<string, string | undefined>) =>
    app!.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: definition,
      headers,
    });
  expect((await save(browser)).statusCode).toBe(401);
  expect(
    (await save({ ...browser, cookie: 'studio_session=' + 'a'.repeat(64) }))
      .statusCode,
  ).toBe(401);
  expect(
    (await save({ ...headers, origin: 'https://untrusted.example' }))
      .statusCode,
  ).toBe(403);
  expect((await save({ host, cookie: headers.cookie })).statusCode).toBe(403);
  expect(
    (
      await save({
        ...headers,
        host: 'untrusted.example',
        'x-forwarded-host': host,
      })
    ).statusCode,
  ).toBe(403);
  const bootstrap = await app.inject({
    method: 'POST',
    url: '/api/session',
    headers: { host, origin },
  });
  expect(bootstrap.statusCode).toBe(403);
  expect(bootstrap.headers['set-cookie']).toBeUndefined();
  const dev = await app.inject({
    method: 'POST',
    url: '/api/session',
    headers: {
      ...browser,
      host: '127.0.0.1:5173',
      origin: 'http://127.0.0.1:5173',
    },
  });
  expect(dev.statusCode).toBe(204);
  expect((await app.inject({ url: '/api/workflows', headers })).json()).toEqual(
    [],
  );
});

test('rejects cycles, missing references, disconnected steps, and unexpected fields', async () => {
  app = await buildApp(path);
  const headers = await session(app);
  for (const payload of [
    {
      ...definition,
      links: [...definition.links, { from: 'review', to: 'draft' }],
    },
    { ...definition, links: [{ from: 'draft', to: 'missing' }] },
    { ...definition, links: [] },
    { ...definition, token: 'fixture-credential' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      headers,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_workflow' });
  }
  expect((await app.inject({ url: '/api/workflows', headers })).json()).toEqual(
    [],
  );
});

test('rejects artifact path escapes and arbitrary CLI credentials at the server storage boundary', () => {
  const db = new Database(path);
  try {
    const store = openStudioStore(db);
    const workflow = store.createWorkflow(definition);
    const input: RunInput = {
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      cliVersion: '0.166.0',
      status: 'completed',
      sessionId: null,
      process: null,
      results: [],
    };
    for (const artifact of [
      '../outside.md',
      '/tmp/file.md',
      'folder/file.md',
      'folder\\file.md',
      '%2e%2e%2foutside.md',
    ]) {
      expect(() =>
        store.recordRun({ ...input, results: [artifact] }),
      ).toThrow();
    }
    const extra = { ...input, token: 'fixture-credential' };
    expect(() => store.recordRun(extra)).toThrow();
    expect(db.prepare('SELECT count(*) FROM runs').pluck().get()).toBe(0);
  } finally {
    db.close();
  }
});

test('an actual SQLite write failure preserves the previous version and returns no raw error', async () => {
  app = await buildApp(path);
  const headers = await session(app);
  const created = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: definition,
    headers,
  });
  const saved = workflowVersionSchema.parse(created.json());
  const adversary = new Database(path);
  adversary.exec(`
    CREATE TRIGGER fail_writes BEFORE INSERT ON workflow_versions
      WHEN NEW.version > 1
      BEGIN SELECT RAISE(ABORT, 'fixture storage diagnostic'); END;
  `);
  adversary.close();
  const url = '/api/workflows/' + saved.id;
  const rejected = await app.inject({
    method: 'PUT',
    url,
    headers,
    payload: {
      baseVersion: 1,
      definition: { ...definition, name: '저장 실패해야 함' },
    },
  });
  expect(rejected.statusCode).toBe(500);
  expect(rejected.json()).toEqual({ error: 'storage_error' });
  expect((await app.inject({ url, headers })).json()).toEqual(saved);
  expect(
    (await app.inject({ url: url + '/versions/2', headers })).statusCode,
  ).toBe(404);
});
