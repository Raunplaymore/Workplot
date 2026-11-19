import process from 'node:process';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { buildApp } from '../apps/server/dist/app.js';
import { openStudioStore } from '../apps/server/dist/studio-store.js';
import { codexRunner, runCodexJson } from '../apps/server/dist/codex-runner.js';

const dir = process.env.STUDIO_QA_DIR;
if (!dir) throw new Error('npm run qa 로 실행하세요.');
const file = join(dir, 'studio.sqlite');
const db = new Database(file);
const store = openStudioStore(db);
if (!store.listWorkflows().length)
  store.createWorkflow(
    JSON.parse(
      readFileSync(new URL('./workflow.json', import.meta.url), 'utf8'),
    ),
  );
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
    write(prompt, signal, observe) {
      // The server permits one active run. Record its actual CLI calls separately from UI events.
      const run = store.listRuns().find((row) => row.status === 'running');
      if (!run) throw new Error('실행 ID 확인 실패');
      const { currentStepId: step, priorDocument } = JSON.parse(prompt);
      const log = (event) =>
        appendFileSync(
          join(dir, 'cli.jsonl'),
          JSON.stringify({ run: run.id, step, ...event }) + '\n',
        );
      log({
        event: 'write',
        ...(typeof priorDocument === 'string' && {
          priorDocumentSha256: createHash('sha256')
            .update(priorDocument)
            .digest('hex'),
        }),
      });
      return codexRunner.write(prompt, signal, (info) => {
        if (info.pid) log({ event: 'spawn', pid: info.pid });
        observe(info);
      });
    },
  },
  async (prompt, signal, observe, schema) => {
    const record = (event) =>
      appendFileSync(
        join(dir, 'design-cli.jsonl'),
        JSON.stringify(event) + '\n',
      );
    const { request, clarifications } = JSON.parse(prompt);
    record({ event: 'request', request, clarifications });
    const edits = await runCodexJson(
      prompt,
      signal,
      (info) => {
        if (info.pid) record({ event: 'spawn', pid: info.pid });
        observe(info);
      },
      schema,
    );
    record({ event: 'response', edits });
    return edits;
  },
);
await app.listen({ host: '127.0.0.1', port: 5173 });
process.send?.('ready');
process.once('SIGTERM', async () => {
  await app.close();
  db.close();
});
