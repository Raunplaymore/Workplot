import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  nodeTemplateSchema,
  shelfEntrySchema,
  fitSchema,
  fitContext,
  workflowDefinitionSchema,
  versionSchema,
} from '@studio/contracts';
import { runCodexJson, RunnerError } from './codex-runner.js';
import { StoreConflict, StoreNotFound } from './studio-store.js';

export function registerNodeShelf(
  app: FastifyInstance,
  db: Database.Database,
  generate: typeof runCodexJson,
) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS node_shelf (id TEXT PRIMARY KEY, version INTEGER NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, template TEXT NOT NULL)',
  );
  const saveSchema = z.strictObject({
    template: nodeTemplateSchema,
    origin: z.strictObject({ id: z.uuid(), version: versionSchema }).optional(),
  });
  function entries() {
    return db
      .prepare('SELECT * FROM node_shelf ORDER BY favorite DESC, rowid DESC')
      .all()
      .map((row) => {
        const r = row as { template: string; favorite: number };
        return shelfEntrySchema.parse({
          ...r,
          template: JSON.parse(r.template),
          favorite: !!r.favorite,
        });
      });
  }
  app.get('/node-shelf', async () => entries());
  app.post('/node-shelf', async (req, reply) => {
    const body = saveSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_node' });
    const { template, origin } = body.data;
    const id = origin?.id ?? randomUUID();
    if (origin) {
      if (
        !db
          .prepare(
            'UPDATE node_shelf SET template=?,version=version+1 WHERE id=? AND version=?',
          )
          .run(JSON.stringify(template), id, origin.version).changes
      )
        throw new StoreConflict();
    } else
      db.prepare(
        'INSERT INTO node_shelf(id,version,template) VALUES(?,1,?)',
      ).run(id, JSON.stringify(template));
    return entries().find((n) => n.id === id);
  });
  app.patch<{ Params: { id: string } }>(
    '/node-shelf/:id',
    async (req, reply) => {
      const patch = z
        .strictObject({ favorite: z.boolean() })
        .safeParse(req.body);
      if (!patch.success)
        return reply.code(400).send({ error: 'invalid_node' });
      if (
        !db
          .prepare('UPDATE node_shelf SET favorite=? WHERE id=?')
          .run(Number(patch.data.favorite), req.params.id).changes
      )
        throw new StoreNotFound();
      return { ok: true };
    },
  );
  app.delete<{ Params: { id: string; version: string } }>(
    '/node-shelf/:id/:version',
    async (req) => {
      if (
        !db
          .prepare('DELETE FROM node_shelf WHERE id=? AND version=?')
          .run(req.params.id, req.params.version).changes
      )
        throw new StoreConflict();
      return { ok: true };
    },
  );
  app.post('/node-fit', async (req, reply) => {
    const body = z
      .strictObject({
        definition: workflowDefinitionSchema,
        after: z.string(),
        template: nodeTemplateSchema,
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_node' });
    const { definition, after, template } = body.data;
    const controller = new AbortController();
    const abort = () => controller.abort();
    reply.raw.once('close', abort);
    try {
      const context = fitContext(definition, after);
      if (template.kind === 'review') return { fit: null };
      const skill = await readFile(
        new URL(
          '../../../.agents/skills/workplot-node-fit/SKILL.md',
          import.meta.url,
        ),
        'utf8',
      );
      const raw = await generate(
        JSON.stringify({
          task: 'node_fit',
          request: template.title,
          skill,
          context,
          template,
        }),
        controller.signal,
        () => {},
        {
          type: 'object',
          additionalProperties: false,
          required: ['instructions', 'reason', 'sources'],
          properties: {
            instructions: { type: 'string' },
            reason: { type: 'string' },
            sources: {
              type: 'array',
              items: {
                type: ['string', 'null'],
                enum: [...context.sources.map((n) => n.id), '@source', null],
              },
            },
          },
        },
      );
      const fit = fitSchema.parse(raw);
      if (
        fit.sources.length !== template.needs.length ||
        fit.sources.some(
          (id) =>
            id !== null &&
            id !== '@source' &&
            !context.sources.some((n) => n.id === id),
        )
      )
        throw new Error('mapping');
      return { fit };
    } catch (error) {
      return reply.code(422).send({
        error: error instanceof RunnerError ? error.reason : 'invalid_node_fit',
      });
    } finally {
      reply.raw.off('close', abort);
    }
  });
}
