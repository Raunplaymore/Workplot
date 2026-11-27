import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openStudioStore } from '../src/studio-store.js';
import { openWorkflowPackages } from '../src/workflow-packages.js';
import type { WorkflowDefinition, WorkflowPackage } from '@studio/contracts';

function workspace() {
  const db = new Database(':memory:');
  const store = openStudioStore(db);
  const packages = openWorkflowPackages(db, store);
  function install(bundle: WorkflowPackage) {
    const p = packages.preview(bundle);
    return packages.install(bundle, p.localVersion, p.revision);
  }
  return { db, store, packages, install };
}
const task = {
  kind: 'task' as const,
  id: 'draft',
  title: 'Draft',
  instructions: 'Review evidence',
  position: { x: 0, y: 0 },
};
const def: WorkflowDefinition = {
  name: 'Review',
  input: 'private input',
  projectFolder: {
    service: 'team',
    serviceId: 'ae129161-1e5f-40bc-9d85-78fdd33ea444',
    folder: 'local',
    branch: 'main',
    checkoutId: 'c'.repeat(64),
    folderKey: 'a'.repeat(64),
  },
  steps: [task],
  links: [],
};
function sample() {
  const a = workspace(),
    b = workspace();
  const child = a.store.createWorkflow(def);
  const parent = a.store.createWorkflow({
    ...def,
    steps: [
      { ...task, workflowRef: { id: child.id, version: 1 } },
      {
        kind: 'review',
        id: 'approve',
        title: 'Approve',
        position: { x: 1, y: 0 },
      },
    ],
    links: [{ from: 'draft', to: 'approve' }],
  });
  const pack = a.packages.pack(parent.id, 1);
  return { a, b, child, parent, pack };
}
describe('portable workflows', () => {
  it('reconstructs the same executable plan in an empty workspace, without sender bindings or duplicate installations', () => {
    const { a, b, parent, pack } = sample();
    expect(JSON.stringify(pack)).not.toContain('private input');
    expect(JSON.stringify(pack)).not.toContain('projectFolder');
    const row = b.install(pack);
    expect(row.id).not.toBe(parent.id);
    expect(b.store.executionDefinition(row.id, row.version)).toEqual({
      ...a.store.executionDefinition(parent.id, 1),
      projectFolder: undefined,
      input: undefined,
    });
    expect(b.install(pack).id).toBe(row.id);
    expect(b.store.listWorkflows()).toHaveLength(2);
    expect(b.packages.pack(row.id, row.version)).toEqual(pack);
    expect(a.install(pack).id).toBe(parent.id);
    expect(a.store.listWorkflows()).toHaveLength(2);
  });
  it('previews and updates pinned dependencies; detects changes after preview and preserves local input and older versions', () => {
    const { a, b, child, parent, pack } = sample();
    const installed = b.install(pack);
    const edit = b.store.updateWorkflow(installed.id, 1, {
      ...installed.definition,
      name: 'custom',
      input: 'local',
      projectFolder: def.projectFolder,
    });
    expect(b.packages.origin(installed.id)?.modified).toBe(true);
    expect(b.install(pack)).toEqual(edit);
    const nextChild = a.store.updateWorkflow(child.id, 1, {
      ...def,
      steps: [{ ...task, instructions: 'New check' }],
    });
    const revision = structuredClone(parent.definition);
    const call = revision.steps[0];
    if (call?.kind !== 'task') throw Error();
    call.workflowRef = { id: child.id, version: nextChild.version };
    a.store.updateWorkflow(parent.id, 1, revision);
    const next = a.packages.pack(parent.id, 2),
      preview = b.packages.preview(next);
    expect(preview.changes.join(' ')).toContain('New check');
    const pinned = installed.definition.steps[0];
    if (pinned?.kind !== 'task' || !pinned.workflowRef) throw Error();
    b.store.updateWorkflow(pinned.workflowRef.id, 1, {
      ...def,
      name: 'child local',
    });
    expect(() =>
      b.packages.install(next, preview.localVersion, preview.revision),
    ).toThrow();
    const updated = b.install(next);
    expect(updated.id).toBe(installed.id);
    expect(updated.version).toBe(3);
    expect(updated.definition.input).toBe('local');
    expect(updated.definition.projectFolder).toEqual(def.projectFolder);
    expect(b.store.workflow(installed.id, 1)).toEqual(installed);
    expect(b.packages.origin(updated.id)).toMatchObject({
      modified: false,
      version: 2,
    });
    expect(b.packages.pack(updated.id, updated.version)).toEqual(next);
  });
  it('rejects missing dependencies, unsolicited members, injected bindings and conflicting immutable revisions', () => {
    const { b, pack } = sample();
    expect(() =>
      b.install({ ...pack, workflows: pack.workflows.slice(0, 1) }),
    ).toThrow();
    const first = pack.workflows[0]!;
    expect(() =>
      b.install({
        ...pack,
        workflows: [...pack.workflows, { ...first, version: 12 }],
      }),
    ).toThrow();
    const unsafe = structuredClone(pack);
    unsafe.workflows[0]!.definition.projectFolder = def.projectFolder;
    expect(() => b.install(unsafe)).toThrow();
    expect(b.store.listWorkflows()).toHaveLength(0);
    b.install(pack);
    const changed = structuredClone(pack);
    changed.workflows[1]!.definition.name = 'unexpected';
    expect(() => b.install(changed)).toThrow();
    expect(b.store.listWorkflows()).toHaveLength(2);
  });
});
