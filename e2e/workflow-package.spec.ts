import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../apps/server/src/app.js';
import {
  type WorkflowDefinition,
  type WorkflowPackage,
} from '@studio/contracts';

test('downloads a linked workflow and previews, installs and reopens it in another Library', async ({
  browser,
}) => {
  const dir = await mkdtemp(join(tmpdir(), 'workplot-share-'));
  async function station(name: string) {
    const prompts: string[] = [];
    const destination = { root: join(dir, name + '-skills'), port: 0 };
    const app = await buildApp(
      join(dir, name + '.sqlite'),
      resolve('apps/web/dist'),
      async () => [
        {
          id: 'codex',
          status: 'detected',
          version: '0.166.0',
          authentication: 'unchecked',
        },
      ],
      {
        ready: async () => '0.166.0',
        write: async (raw) => {
          prompts.push(JSON.parse(raw).instructions);
          return { kind: 'document', text: 'Verified team result' };
        },
      },
      undefined,
      undefined,
      destination,
    );
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    destination.port = Number(new URL(url).port);
    const headers = { origin: url, 'x-studio-client': 'browser' };
    const session = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { ...headers, host: new URL(url).host },
    });
    const cookie = String(session.headers['set-cookie']).split(';')[0]!;
    async function create(def: WorkflowDefinition) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/workflows',
        headers: { ...headers, host: new URL(url).host, cookie },
        payload: def,
      });
      expect(response.statusCode).toBe(201);
      return response.json();
    }
    const get = async (path: string) =>
      (
        await app.inject({
          method: 'GET',
          url: '/api' + path,
          headers: { ...headers, host: new URL(url).host, cookie },
        })
      ).json();
    async function update(id: string, goal: string) {
      const current = await get('/workflows/' + id);
      const response = await app.inject({
        method: 'PUT',
        url: '/api/workflows/' + id,
        headers: { ...headers, host: new URL(url).host, cookie },
        payload: {
          baseVersion: current.version,
          definition: { ...current.definition, goal },
        },
      });
      expect(response.statusCode).toBe(200);
      return response.json();
    }
    return { app, url, create, prompts, get, update };
  }
  const sender = await station('sender');
  const receiver = await station('receiver');
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    const step = {
      id: 'check',
      kind: 'task' as const,
      title: 'Read change',
      instructions: 'Compare both revisions.',
      position: { x: 0, y: 0 },
      workspaceAccess: 'read-only' as const,
    };
    const child = await sender.create({
      name: 'Reusable review',
      input: 'private prompt input',
      steps: [step],
      links: [],
    });
    const parent = await sender.create({
      name: 'Review pipeline',
      input: 'private project notes',
      steps: [
        {
          ...step,
          instructions: 'Run the linked flow.',
          workflowRef: { id: child.id, version: child.version },
        },
        {
          id: 'approval',
          title: 'Team approval',
          kind: 'review',
          position: { x: 260, y: 0 },
        },
      ],
      links: [{ from: step.id, to: 'approval' }],
    });
    const p = await context.newPage();
    await p.goto(sender.url + '/#/library/' + parent.id);
    await p
      .getByRole('button', { name: 'Review pipeline · Menu', exact: true })
      .click();
    const download = p.waitForEvent('download');
    await p
      .getByRole('menuitem', { name: 'Export workflow', exact: true })
      .click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.workplot\.json$/);
    const path = join(dir, file.suggestedFilename());
    await file.saveAs(path);
    const content = await readFile(path, 'utf8');
    const payload = JSON.parse(content) as WorkflowPackage;
    expect(payload.workflows).toHaveLength(2);
    expect(content).not.toContain('private');
    await p.goto(receiver.url + '/#/library');
    const upload = p.getByLabel('Workflow package', { exact: true });
    await upload.setInputFiles(path);
    const dialog = p.getByRole('dialog', {
      name: 'Import workflow',
      exact: true,
    });
    await expect(
      dialog.getByText('Reusable review · v1', { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText(/Tools & access.*Read only/).first(),
    ).toBeVisible();
    await dialog
      .getByRole('button', { name: 'Import workflow', exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      p.getByRole('heading', { name: 'Review pipeline', exact: true }),
    ).toBeVisible();
    await expect(
      p.getByText('Imported from v1 · Matches imported version'),
    ).toBeVisible();
    const received = p.url();
    expect(received.split('#')[1]).not.toContain(parent.id);
    await upload.setInputFiles(path);
    await dialog
      .getByRole('button', { name: 'Open installed workflow' })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(p.url()).toBe(received);
    await expect(p.getByRole('button', { name: / · Menu$/ })).toHaveCount(2);
    await p.getByRole('button', { name: 'New input', exact: true }).click();
    await p.getByLabel('이번 작업 자료').fill('New material on the receiver');
    const started = p.waitForRequest(
      (req) =>
        req.method() === 'POST' && new URL(req.url()).pathname === '/api/runs',
    );
    await p.getByRole('button', { name: 'Start run', exact: true }).click();
    const runId = (await started).postDataJSON().id;
    await expect
      .poll(
        async () =>
          (await receiver.get('/runs/' + runId + '/view')).summary.status,
      )
      .toBe('waiting');
    const run = await receiver.get('/runs/' + runId + '/view');
    expect(run.results).toEqual(['check.md']);
    expect(run.gate).toBeTruthy();
    expect(run.stepId).toBe('approval');
    expect(receiver.prompts).toEqual([step.instructions]);
    expect(sender.prompts).toEqual([]);
    const receiverId = new URL(received).hash.split('/').at(-1)!;
    await receiver.update(receiverId, 'Local review criteria');
    const update = await sender.update(parent.id, 'Published review criteria');
    const newer = await sender.get(
      '/workflows/' + parent.id + '/versions/' + update.version + '/package',
    );
    const uploadUpdate = () =>
      upload.setInputFiles({
        name: 'review-v2.workplot.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(newer)),
      });
    await p.goto(received);
    await expect(
      p.getByText('Imported from v1 · Locally modified'),
    ).toBeVisible();
    await uploadUpdate();
    const changes = dialog.getByRole('region', { name: 'Changes' });
    await expect(changes).toContainText('Local review criteria');
    await expect(changes).toContainText('Published review criteria');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    expect(
      (await receiver.get('/workflows/' + receiverId)).definition.goal,
    ).toBe('Local review criteria');
    await uploadUpdate();
    await dialog
      .getByRole('button', { name: 'Update workflow', exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      p.getByText('Imported from v2 · Matches imported version'),
    ).toBeVisible();
    expect(
      (await receiver.get('/workflows/' + receiverId)).definition.goal,
    ).toBe('Published review criteria');
    expect(
      (await receiver.get('/runs/' + runId + '/view')).summary.workflowVersion,
    ).toBe(1);
  } finally {
    await context.close();
    await receiver.app.close();
    await sender.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
