import { dirname } from 'node:path';
import { codexRunner, runCodexJson } from './codex-runner.js';
import { createRunService } from './run-service.js';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import Database from 'better-sqlite3';
import { healthSchema, toolsSchema } from '@studio/contracts';
import { detectTools } from './tools.js';
import { openStudioStore } from './studio-store.js';
import { registerStudioRoutes } from './studio-routes.js';

export async function buildApp(
  databasePath: string,
  webRoot?: string,
  inspectTools = detectTools,
  runner = codexRunner,
  generateProposal = runCodexJson,
) {
  const app = Fastify();
  const db = new Database(databasePath);
  app.addHook('onClose', async () => {
    db.close();
  });

  try {
    db.pragma('journal_mode = WAL');
    const store = openStudioStore(db);
    const runs = createRunService(store, runner, dirname(databasePath));
    app.addHook('preClose', async () => runs.close());
    await app.register(
      async (routes) =>
        registerStudioRoutes(routes, store, runs, generateProposal),
      {
        prefix: '/api',
      },
    );

    app.get('/api/health', async () => {
      db.prepare('SELECT 1').get();
      return healthSchema.parse({
        status: 'ok',
        database: 'ready',
        agent: 'not_connected',
      });
    });

    // One bounded detection per server instance, not one subprocess per request.
    let tools: ReturnType<typeof detectTools> | undefined;
    app.get('/api/tools', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      tools ??= inspectTools();
      return toolsSchema.parse(await tools);
    });

    if (webRoot) await app.register(fastifyStatic, { root: webRoot });
    await app.ready();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
