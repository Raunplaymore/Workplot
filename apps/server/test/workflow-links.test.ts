import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { expect, test } from 'vitest';
import {
  linkWorkflowStep,
  type LinkCandidate,
  type WorkflowDefinition,
} from '@studio/contracts';
import { registerWorkflowLinks } from '../src/workflow-link-routes.js';
import { openStudioStore } from '../src/studio-store.js';

function chain(name: string, length = 1): WorkflowDefinition {
  const steps = Array.from({ length }, (_, i) => ({
    id: 'step-' + i,
    title: 'Task ' + i,
    kind: 'task' as const,
    position: { x: 10 * i, y: 0 },
    instructions: 'Write.',
  }));
  return {
    name,
    steps,
    links: steps.slice(1).map((s, i) => ({ from: steps[i]!.id, to: s.id })),
  };
}

test('link choices validate the composed draft and usage tracks current parents with exact pinned child versions', async () => {
  const db = new Database(':memory:'),
    app = Fastify();
  try {
    const store = openStudioStore(db);
    registerWorkflowLinks(app, store, db);
    const child = store.createWorkflow(chain('Child')),
      large = store.createWorkflow(chain('Oversized', 32));
    const bad = chain('Approval', 2);
    bad.steps[1] = {
      id: 'step-1',
      title: 'Confirm',
      kind: 'review',
      position: { x: 10, y: 0 },
    };
    const approval = store.createWorkflow(bad);
    const parent = store.createWorkflow(chain('Parent', 2));
    const linked = structuredClone(parent.definition),
      original = linked.steps[0]!;
    if (original.kind !== 'task') throw Error('invalid fixture');
    linked.steps[0] = linkWorkflowStep(original, {
      ...child,
      name: child.definition.name,
    });
    store.updateWorkflow(parent.id, 1, linked);
    store.updateWorkflow(child.id, 1, {
      ...child.definition,
      name: 'Child renamed',
    });
    const request = async (
      draft: WorkflowDefinition,
      parentId: string | null,
    ) => {
      const res = await app.inject({
        method: 'POST',
        url: '/workflow-links/candidates',
        payload: { parent: parentId, draft, step: 'step-0' },
      });
      expect(res.statusCode).toBe(200);
      return res.json<LinkCandidate[]>();
    };
    const options = await request(linked, parent.id);
    expect(options.find((c) => c.id === child.id)).toMatchObject({
      version: 2,
      reason: null,
    });
    expect(options.find((c) => c.id === large.id)?.reason).toMatch(/32 steps/);
    expect(options.find((c) => c.id === approval.id)?.reason).toMatch(
      /approval/,
    );
    expect(options.some((c) => c.id === parent.id)).toBe(false);
    expect(
      (await request(chain('New'), null)).find((c) => c.id === parent.id)
        ?.reason,
    ).toMatch(/linked workflow/);
    const usages = () =>
      app.inject({ url: '/workflows/' + child.id + '/used-by' });
    expect((await usages()).json()).toEqual([
      {
        id: parent.id,
        version: 2,
        name: 'Parent',
        step: 'Child',
        pinned: 1,
        location: 'active',
      },
    ]);
    store.updateWorkflow(parent.id, 2, parent.definition);
    expect((await usages()).json()).toEqual([]);
  } finally {
    await app.close();
    db.close();
  }
});
