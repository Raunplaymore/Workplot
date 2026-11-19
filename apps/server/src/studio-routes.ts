import { codexRunner, runCodexJson, RunnerError } from './codex-runner.js';
import type { createRunService } from './run-service.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  proposalRequestSchema,
  proposalOutputSchema,
  buildProposal,
  buildNewProposal,
  workflowPlan,
  versionSchema,
  runStartSchema,
  runDecisionSchema,
  runRetrySchema,
  workflowDefinitionSchema,
  workflowIdSchema,
  workflowUpdateSchema,
} from '@studio/contracts';
import {
  StoreConflict,
  StoreNotFound,
  type StudioStore,
} from './studio-store.js';

const browserHosts = new Set([
  '127.0.0.1:4310',
  '127.0.0.1:5173',
  'localhost:5173',
]);
const sessionCookie = 'studio_session';

export function registerStudioRoutes(
  app: FastifyInstance,
  store: StudioStore,
  runs: ReturnType<typeof createRunService>,
  generateProposal: typeof runCodexJson,
) {
  const session = randomBytes(32).toString('hex');

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    // Vite preserves Host on its loopback proxy. Never trust forwarded host headers.
    const host = request.headers.host;
    const origin = request.headers.origin;
    if (
      !host ||
      !browserHosts.has(host) ||
      (origin !== undefined && origin !== `http://${host}`) ||
      (request.method !== 'GET' &&
        request.method !== 'HEAD' &&
        origin === undefined)
    ) {
      return reply.code(403).send({ error: 'local_origin_required' });
    }
  });

  app.post('/session', async (request, reply) => {
    if (request.headers['x-studio-client'] !== 'browser') {
      return reply.code(403).send({ error: 'local_origin_required' });
    }
    return reply
      .header(
        'Set-Cookie',
        `${sessionCookie}=${session}; Path=/api; HttpOnly; SameSite=Strict`,
      )
      .code(204)
      .send();
  });

  app.register(async (protectedRoutes) => {
    protectedRoutes.addHook('onRequest', async (request, reply) => {
      const cookies =
        request.headers.cookie?.split(';').map((cookie) => cookie.trim()) ?? [];
      const tokens = cookies
        .filter((cookie) => cookie.startsWith(sessionCookie + '='))
        .map((cookie) => cookie.slice(sessionCookie.length + 1));
      const [token] = tokens;
      if (
        tokens.length !== 1 ||
        token === undefined ||
        !/^[a-f0-9]{64}$/.test(token) ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(session))
      ) {
        return reply.code(401).send({ error: 'local_session_required' });
      }
    });

    protectedRoutes.setErrorHandler((error, _request, reply) => {
      if (error instanceof StoreNotFound)
        return reply.code(404).send({ error: 'not_found' });
      if (error instanceof StoreConflict)
        return reply.code(409).send({ error: 'stale_version' });
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 400 || status === 413 || status === 415) {
        return reply.code(status).send({ error: 'invalid_request' });
      }
      return reply.code(500).send({ error: 'storage_error' });
    });

    protectedRoutes.post('/workflow-proposals', async (request, reply) => {
      const body = proposalRequestSchema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: 'invalid_workflow' });
      const { request: instruction, clarifications } = body.data;
      const clarified = !!clarifications?.length;
      const definition =
        'definition' in body.data ? body.data.definition : null;
      const cancel = new AbortController();
      const abort = () => cancel.abort();
      reply.raw.once('close', abort);
      try {
        await codexRunner.ready();
        const prompt = JSON.stringify({
          task: !definition
            ? '사용자의 짧은 목표를 한국어 이름과 실행 순서대로 배열한 새 직렬 문서 워크플로로 설계하세요. 문서를 생성하거나 업무를 시작하지 마세요. 사용자 승인은 별도의 review 노드로 지정하고 승인이 필요한 후속 작업 앞에 두세요. 작업은 task이고 inputFrom은 필요한 선행 문서의 작업 ID 배열입니다. 승인 노드는 문서를 만들지 않습니다. 각 지침은 실제 실행에 사용할 내용입니다. 나중에 제공할 매장 자료 같은 실행 입력은 만들어내거나 설계 중 요구하지 마세요. 결과 문서 종류가 특정되지 않은 포괄적인 도움 요청이면 임의로 정하지 말고 어떤 문서가 필요한지 한 가지 질문부터 하세요. 설계 자체가 불명확하거나 지원하지 않는 도구나 분기가 꼭 필요하면 clarification에 질문을 쓰고 name과 steps는 비우세요. 설계가 가능하면 clarification은 빈 문자열입니다.'
            : '자연어 요청에 맞게 기존 직렬 흐름의 변경안만 만드세요. 업무 자체를 수행하지 마세요. 기존 사용자 검토는 사람이 승인하는 단계이며 AI 검토는 반드시 별개의 Codex 작업입니다. additions에는 기존 단계 바로 뒤에 삽입할 새 작업만, inputs에는 전달 자료를 바꿀 작업과 그 작업이 받아야 할 모든 선행 문서의 단계 ID를 넣으세요. 새 작업 ID는 고유한 영문 소문자입니다. 요청을 충족할 수 없거나 모호하면 clarification에 한국어 질문을 쓰고 두 배열을 비우세요. 변경안이면 clarification은 빈 문자열입니다.',
          ...(definition && { workflow: workflowPlan(definition) }),
          ...(clarified && {
            clarifications,
            followUp:
              '원래 요청과 확인 질문에 대한 사용자 답변을 함께 반영하세요. 필요한 문서와 절차가 확인되면 같은 질문을 반복하지 말고 설계안을 반환하세요.' +
              (!definition
                ? ' resolvedGoal에 확인된 업무 목표를 한국어로 요약하세요. 추가 질문이 필요하면 빈 문자열입니다.'
                : ''),
          }),
          request: instruction,
        });
        const raw = await generateProposal(
          prompt,
          cancel.signal,
          () => {},
          proposalOutputSchema(definition ? 'edit' : 'create', clarified),
        );
        return definition
          ? buildProposal(definition, raw)
          : buildNewProposal(instruction, raw, clarified);
      } catch (error) {
        return reply.code(422).send({
          error:
            error instanceof RunnerError ? error.reason : 'invalid_proposal',
        });
      } finally {
        reply.raw.off('close', abort);
      }
    });
    protectedRoutes.get('/workflows', async () => store.listWorkflows());
    protectedRoutes.post('/workflows', async (request, reply) => {
      const definition = workflowDefinitionSchema.safeParse(request.body);
      if (!definition.success)
        return reply.code(400).send({ error: 'invalid_workflow' });
      return reply.code(201).send(store.createWorkflow(definition.data));
    });

    protectedRoutes.get<{ Params: { id: string } }>(
      '/workflows/:id',
      async (request, reply) => {
        const id = workflowIdSchema.safeParse(request.params.id);
        if (!id.success)
          return reply.code(400).send({ error: 'invalid_workflow_id' });
        return store.workflow(id.data);
      },
    );

    protectedRoutes.get<{ Params: { id: string; version: string } }>(
      '/workflows/:id/versions/:version',
      async (request, reply) => {
        const id = workflowIdSchema.safeParse(request.params.id);
        const version = versionSchema.safeParse(
          /^[1-9][0-9]*$/.test(request.params.version)
            ? Number(request.params.version)
            : NaN,
        );
        if (!id.success || !version.success)
          return reply.code(400).send({ error: 'invalid_workflow_version' });
        return store.workflow(id.data, version.data);
      },
    );

    protectedRoutes.put<{ Params: { id: string } }>(
      '/workflows/:id',
      async (request, reply) => {
        const id = workflowIdSchema.safeParse(request.params.id);
        const body = workflowUpdateSchema.safeParse(request.body);
        if (!id.success || !body.success)
          return reply.code(400).send({ error: 'invalid_workflow' });
        return store.updateWorkflow(
          id.data,
          body.data.baseVersion,
          body.data.definition,
        );
      },
    );

    protectedRoutes.get('/runs', async () => runs.list());
    protectedRoutes.post('/runs', async (request, reply) => {
      const input = runStartSchema.safeParse(request.body);
      if (!input.success) return reply.code(400).send({ error: 'invalid_run' });
      try {
        const { id, workflowId, workflowVersion } = input.data;
        return await runs.start(id, workflowId, workflowVersion);
      } catch (error) {
        if (!(error instanceof RunnerError)) throw error;
        return reply.code(422).send({ error: error.reason });
      }
    });
    protectedRoutes.get<{ Params: { id: string } }>(
      '/runs/:id/view',
      async (request, reply) => {
        const id = workflowIdSchema.safeParse(request.params.id);
        if (!id.success)
          return reply.code(400).send({ error: 'invalid_run_id' });
        return runs.view(id.data);
      },
    );
    protectedRoutes.get<{ Params: { id: string } }>(
      '/runs/:id/events',
      async (request, reply) => {
        const id = workflowIdSchema.safeParse(request.params.id);
        if (!id.success)
          return reply.code(400).send({ error: 'invalid_run_id' });
        return runs.events(id.data);
      },
    );
    protectedRoutes.post<{ Params: { id: string } }>(
      '/runs/:id/retry',
      async (request, reply) => {
        const id = workflowIdSchema.safeParse(request.params.id);
        const body = runRetrySchema.safeParse(request.body);
        if (!id.success || !body.success)
          return reply.code(400).send({ error: 'invalid_retry' });
        try {
          return await runs.retry(id.data, body.data.failureId);
        } catch (error) {
          if (error instanceof StoreConflict)
            return reply.code(409).send({ error: 'retry_conflict' });
          if (error instanceof RunnerError)
            return reply.code(422).send({ error: error.reason });
          throw error;
        }
      },
    );
    protectedRoutes.post<{ Params: { id: string } }>(
      '/runs/:id/decision',
      async (request, reply) => {
        const id = workflowIdSchema.safeParse(request.params.id);
        const decision = runDecisionSchema.safeParse(request.body);
        if (!id.success || !decision.success)
          return reply.code(400).send({ error: 'invalid_decision' });
        return runs.decide(id.data, decision.data);
      },
    );
    protectedRoutes.post<{ Params: { id: string } }>(
      '/runs/:id/stop',
      async (request, reply) => {
        const id = workflowIdSchema.safeParse(request.params.id);
        if (!id.success)
          return reply.code(400).send({ error: 'invalid_run_id' });
        return runs.stop(id.data);
      },
    );
    protectedRoutes.get<{ Params: { id: string; file: string } }>(
      '/runs/:id/results/:file',
      async (request, reply) => {
        const id = workflowIdSchema.safeParse(request.params.id);
        if (!id.success)
          return reply.code(400).send({ error: 'invalid_run_id' });
        const text = await runs.artifact(id.data, request.params.file);
        return reply
          .type('text/plain; charset=utf-8')
          .header('X-Content-Type-Options', 'nosniff')
          .send(text);
      },
    );
    protectedRoutes.get<{ Params: { id: string } }>(
      '/runs/:id',
      async (request, reply) => {
        const id = workflowIdSchema.safeParse(request.params.id);
        if (!id.success)
          return reply.code(400).send({ error: 'invalid_run_id' });
        return runs.view(id.data).summary;
      },
    );
  });
}
