import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  editorRecoverySchema,
  linkWorkflowStep,
  workflowDefinitionSchema,
  workflowIdSchema,
} from '@studio/contracts';
import { expandWorkflow, InvalidWorkflowLink } from './linked-workflow.js';
import { StoreNotFound, type StudioStore } from './studio-store.js';

const requestSchema = z.strictObject({
  parent: workflowIdSchema.nullable(),
  step: z.string().max(64),
  draft: editorRecoverySchema.shape.draft,
});

export function registerWorkflowLinks(
  routes: FastifyInstance,
  store: StudioStore,
  db: Database.Database,
) {
  routes.post('/workflow-links/candidates', (request, reply) => {
    const body = requestSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: 'invalid_workflow' });
    const { parent, step, draft } = body.data;
    const selected = draft.steps.find((s) => s.id === step);
    if (selected?.kind !== 'task')
      return reply.code(400).send({ error: 'invalid_node' });
    const cache = new Map<string, ReturnType<typeof store.workflow>>();
    const lookup = (id: string, version: number) => {
      const key = id + '/' + version;
      let record = cache.get(key);
      if (!record) {
        record = store.workflow(id, version);
        cache.set(key, record);
      }
      return record;
    };
    return store
      .listWorkflows()
      .filter((row) => row.id !== parent)
      .map((row) => {
        const candidate = {
          ...draft,
          steps: draft.steps.map((s) =>
            s.id === step ? linkWorkflowStep(selected, row) : s,
          ),
        };
        let reason: string | null = null;
        if (!workflowDefinitionSchema.safeParse(candidate).success)
          reason = 'Finish the current draft first';
        else
          try {
            expandWorkflow(parent ?? '', candidate, lookup);
          } catch (e) {
            if (e instanceof InvalidWorkflowLink) reason = e.message;
            else if (e instanceof StoreNotFound)
              reason = 'Referenced workflow version unavailable';
            else throw e;
          }
        return { id: row.id, version: row.version, name: row.name, reason };
      })
      .sort((a, b) => Number(!!a.reason) - Number(!!b.reason));
  });
  const usages = db.prepare(`
    SELECT w.id,w.version,json_extract(w.definition,'$.name') AS name,
           json_extract(s.value,'$.title') AS step,json_extract(s.value,'$.workflowRef.version') AS pinned,
           coalesce(l.location,'active') AS location
    FROM workflow_versions w JOIN (SELECT id,max(version) AS version FROM workflow_versions GROUP BY id) v USING(id,version)
    LEFT JOIN workflow_locations l ON l.id=w.id, json_each(w.definition,'$.steps') s
    WHERE json_extract(s.value,'$.workflowRef.id')=? ORDER BY name,w.id,s.key
  `);
  routes.get<{ Params: { id: string } }>(
    '/workflows/:id/used-by',
    (req, reply) => {
      if (!workflowIdSchema.safeParse(req.params.id).success)
        return reply.code(400).send({ error: 'invalid_workflow_id' });
      store.workflow(req.params.id);
      return usages.all(req.params.id);
    },
  );
}
