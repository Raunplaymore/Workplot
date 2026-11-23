import { createGitPromotions } from './git-promotion.js';
import { createDelegation } from './delegation.js';
import { createSessionHistory } from './session-history.js';
import { createScheduler } from './scheduler.js';
import { createComparisons } from './comparisons.js';
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
  evaluateDocuments = runCodexJson,
  skillDestination?: { root: string; port: number },
) {
  const app = Fastify();
  const db = new Database(databasePath);
  app.addHook('onClose', async () => {
    db.close();
  });

  try {
    db.pragma('journal_mode = WAL');
    const store = openStudioStore(db);
    const promotions = createGitPromotions(db, store);
    app.addHook('onListen', async () => promotions.recover());
    const history = createSessionHistory(db, store, dirname(databasePath));
    const runs = createRunService(
      store,
      runner,
      dirname(databasePath),
      history.expired,
    );
    let cleanupTimer: ReturnType<typeof setInterval> | undefined;
    app.addHook('onListen', async () => {
      const clean = () => {
        try {
          history.sweep();
        } catch (err) {
          app.log.error({ err }, '세션 기록 정리 실패');
        }
      };
      clean();
      cleanupTimer = setInterval(clean, 60_000);
      cleanupTimer.unref();
    });
    app.addHook('onClose', async () => clearInterval(cleanupTimer));
    await runs.restoreReview();
    app.addHook('onListen', async () => runs.recoverIntegrations());
    const delegation = createDelegation(db, store, runs, generateProposal);
    app.addHook('onListen', async () => delegation.start());
    const scheduler = createScheduler(db, store, runs, dirname(databasePath));
    app.addHook('onListen', async () => scheduler.start());
    app.addHook('preClose', async () => {
      await delegation.close();
      await scheduler.close();
      await runs.close();
    });
    await app.register(
      async (routes) =>
        registerStudioRoutes(
          routes,
          store,
          runs,
          generateProposal,
          createComparisons(db, store, runs.artifact, evaluateDocuments),
          scheduler,
          db,
          history,
          delegation,
          promotions,
          skillDestination,
        ),
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
