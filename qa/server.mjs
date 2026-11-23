import console from 'node:console';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { buildApp } from '../apps/server/dist/app.js';
import { openStudioStore } from '../apps/server/dist/studio-store.js';
import { codexRunner, runCodexJson } from '../apps/server/dist/codex-runner.js';

const dir =
  process.env.STUDIO_QA_DIR ??
  (await mkdtemp(join(tmpdir(), 'workplot-browser-qa-')));
const file = join(dir, 'studio.sqlite');
const db = new Database(file);
const store = openStudioStore(db);
if (!process.env.STUDIO_FIRST_USE && !store.listWorkflows().length)
  store.createWorkflow(
    JSON.parse(
      readFileSync(new URL('./workflow.json', import.meta.url), 'utf8'),
    ),
  );
const qaPort = Number(process.env.WORKPLOT_QA_PORT ?? 5173);
if (
  !Number.isInteger(qaPort) ||
  (qaPort !== 0 && (qaPort < 1024 || qaPort > 65535 || qaPort === 4310))
)
  throw Error('잘못된 QA 포트');
const destination = { root: join(dir, 'skills'), port: qaPort };
const app = await buildApp(
  file,
  resolve('apps/web/dist'),
  undefined,
  {
    ready() {
      appendFileSync(
        join(dir, 'cli.jsonl'),
        JSON.stringify({ event: 'ready' }) + '\n',
      );
      return codexRunner.ready();
    },
    write(prompt, signal, observe, tool, documentOnly) {
      // The server permits one active run. Record its actual CLI calls separately from UI events.
      const run = store.listRuns().find((row) => row.status === 'running');
      if (!run) throw new Error('실행 ID 확인 실패');
      const {
        taskSkill,
        currentStepId: step,
        priorDocument,
        inputDocuments,
        instructions,
        source,
      } = JSON.parse(prompt);
      const log = (event) =>
        appendFileSync(
          join(dir, 'cli.jsonl'),
          JSON.stringify({ run: run.id, step, ...event }) + '\n',
        );
      log({
        event: 'write',
        ...(taskSkill && {
          taskSkill: taskSkill.name,
          skillDigest: createHash('sha256')
            .update(taskSkill.instructions)
            .digest('hex'),
        }),
        ...(inputDocuments && {
          instructions,
          sourceSha256: createHash('sha256').update(source).digest('hex'),
          inputs: inputDocuments.map(({ filename, text }) => ({
            filename,
            sha256: createHash('sha256').update(text).digest('hex'),
          })),
        }),
        ...(typeof priorDocument === 'string' && {
          priorDocumentSha256: createHash('sha256')
            .update(priorDocument)
            .digest('hex'),
        }),
      });
      return codexRunner.write(
        prompt,
        signal,
        (info) => {
          if (info.pid) log({ event: 'spawn', pid: info.pid });
          observe(info);
        },
        tool,
        documentOnly,
      );
    },
  },
  async (prompt, signal, observe, schema) => {
    const payload = JSON.parse(prompt);
    const matching = payload.task === 'workflow_match';
    const record = (event) =>
      appendFileSync(
        join(dir, matching ? 'match-cli.jsonl' : 'design-cli.jsonl'),
        JSON.stringify(event) + '\n',
      );
    const { request, clarifications, skill } = payload;
    if (matching)
      record({
        event: 'request',
        goal: payload.goal,
        catalog: payload.catalog,
      });
    else
      record({
        event: 'request',
        request,
        clarifications,
        ...(typeof skill === 'string' && {
          skillSha256: createHash('sha256').update(skill).digest('hex'),
        }),
        ...(payload.selectedDesignSkill && {
          selectedDesignSkill: {
            id: payload.selectedDesignSkill.id,
            digest: payload.selectedDesignSkill.digest,
            instructionsSha256: createHash('sha256')
              .update(payload.selectedDesignSkill.instructions)
              .digest('hex'),
          },
        }),
      });
    const itemTypes = [];
    const edits = await runCodexJson(
      prompt,
      signal,
      (info) => {
        if (info.pid) record({ event: 'spawn', pid: info.pid });
        observe(info);
      },
      schema,
      (type) => itemTypes.push(type),
    );
    record({ event: 'response', edits, itemTypes });
    return edits;
  },
  async (prompt, signal, observe, schema) => {
    const { criteria, source, original, revision } = JSON.parse(prompt);
    const digest = (text) => createHash('sha256').update(text).digest('hex');
    let pid;
    const result = await runCodexJson(
      prompt,
      signal,
      (info) => {
        if (info.pid) pid = info.pid;
        observe(info);
      },
      schema,
    );
    appendFileSync(
      join(dir, 'comparison-cli.jsonl'),
      JSON.stringify({
        pid,
        criteriaSha256: digest(criteria),
        sourceSha256: digest(source),
        originalSha256: digest(original),
        revisionSha256: digest(revision),
      }) + '\n',
    );
    return result;
  },
  destination,
);
await app.listen({ host: '127.0.0.1', port: qaPort });
destination.port = app.server.address().port;
console.log('Workplot QA port ' + destination.port);
process.send?.('ready');
process.once('SIGTERM', async () => {
  await app.close();
  db.close();
  if (!process.env.STUDIO_QA_DIR)
    await rm(dir, { recursive: true, force: true });
});
