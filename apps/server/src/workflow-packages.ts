import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  workflowPackageSchema,
  workflowIdSchema,
  versionSchema,
  type WorkflowPackage,
  type WorkflowDefinition,
} from '@studio/contracts';
import { expandWorkflow } from './linked-workflow.js';
import { type StudioStore, StoreConflict } from './studio-store.js';

type Entry = WorkflowPackage['workflows'][number];
type Ref = WorkflowPackage['root'];
type Installation = {
  id: string;
  version: number;
  localId: string;
  localVersion: number;
  digest: string;
};
const key = (r: Ref) => r.id + '/' + r.version;
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
class PackageError extends Error {}

function portable(def: WorkflowDefinition): WorkflowDefinition {
  const clean = structuredClone(def);
  delete clean.input;
  delete clean.projectFolder;
  for (const step of clean.steps) delete step.templateOrigin;
  return clean;
}
function refs(def: WorkflowDefinition) {
  return def.steps.flatMap((step) =>
    step.kind === 'task' && step.workflowRef ? [step.workflowRef] : [],
  );
}
function checkedEntries(bundle: WorkflowPackage) {
  const entries = new Map(bundle.workflows.map((e) => [key(e), e]));
  const root = entries.get(key(bundle.root));
  if (!root || entries.size !== bundle.workflows.length)
    throw new PackageError('패키지의 루트 또는 버전 목록을 확인하세요.');
  const needed = new Set(refs(root.definition).map(key));
  needed.add(key(root));
  if (needed.size !== entries.size || [...needed].some((k) => !entries.has(k)))
    throw new PackageError(
      '하위 흐름의 고정 버전과 파일 목록이 일치하지 않습니다.',
    );
  for (const entry of entries.values()) {
    if (
      entry.definition.input !== undefined ||
      entry.definition.projectFolder ||
      entry.definition.steps.some((s) => s.templateOrigin)
    )
      throw new PackageError('로컬 작업 자료나 폴더 연결이 포함된 파일입니다.');
  }
  expandWorkflow(root.id, root.definition, (id, version) => {
    const e = entries.get(key({ id, version }));
    if (!e) throw new PackageError('하위 흐름이 없습니다.');
    return e;
  });
  return [
    ...bundle.workflows
      .filter((e) => e !== root)
      .sort((a, b) => a.version - b.version),
    root,
  ];
}
function difference(before: unknown, after: unknown, path: string): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object'
  ) {
    const a = before as Record<string, unknown>,
      b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) =>
      difference(a[k], b[k], path + '.' + k),
    );
  }
  return [
    path +
      ' · ' +
      (JSON.stringify(before) ?? '∅') +
      ' → ' +
      (JSON.stringify(after) ?? '∅'),
  ];
}
export function openWorkflowPackages(
  db: Database.Database,
  store: StudioStore,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_imports (
    id TEXT NOT NULL, version INTEGER NOT NULL, localId TEXT NOT NULL, localVersion INTEGER NOT NULL, digest TEXT NOT NULL,
    PRIMARY KEY(id,version), UNIQUE(localId,localVersion),
    FOREIGN KEY(localId,localVersion) REFERENCES workflow_versions(id,version)
  ) STRICT`);
  function exact(ref: Ref) {
    const installed = db
      .prepare('SELECT * FROM workflow_imports WHERE id=? AND version=?')
      .get(ref.id, ref.version) as Installation | undefined;
    if (installed) return installed;
    const native = db
      .prepare('SELECT 1 FROM workflow_versions WHERE id=? AND version=?')
      .get(ref.id, ref.version);
    if (native)
      return {
        ...ref,
        localId: ref.id,
        localVersion: ref.version,
        digest: digest(
          upstreamDefinition(store.workflow(ref.id, ref.version).definition),
        ),
      };
    return undefined;
  }
  function latest(id: string) {
    return db
      .prepare(
        'SELECT * FROM workflow_imports WHERE id=? ORDER BY version DESC LIMIT 1',
      )
      .get(id) as Installation | undefined;
  }
  function modified(row: Installation) {
    return (
      digest(portable(store.workflow(row.localId).definition)) !==
      digest(portable(store.workflow(row.localId, row.localVersion).definition))
    );
  }
  function origin(localId: string) {
    const row = db
      .prepare(
        'SELECT * FROM workflow_imports WHERE localId=? ORDER BY localVersion DESC LIMIT 1',
      )
      .get(localId) as Installation | undefined;
    return row
      ? {
          id: row.id,
          version: row.version,
          localVersion: row.localVersion,
          modified: modified(row),
        }
      : null;
  }
  function pack(id: string, version: number): WorkflowPackage {
    const entries = new Map<string, Entry>();
    function add(ref: Ref): Ref {
      const mapped = originalRef(ref);
      if (entries.has(key(mapped))) return mapped;
      const definition = portable(
        store.workflow(ref.id, ref.version).definition,
      );
      entries.set(key(mapped), { ...mapped, definition });
      for (const step of definition.steps) {
        if (step.kind === 'task' && step.workflowRef)
          step.workflowRef = add(step.workflowRef);
      }
      return mapped;
    }
    const root = add({ id, version });
    return { format: 'workplot/1', root, workflows: [...entries.values()] };
  }
  function originalRef(ref: Ref): Ref {
    return (
      (db
        .prepare(
          'SELECT id,version FROM workflow_imports WHERE localId=? AND localVersion=?',
        )
        .get(ref.id, ref.version) as Ref | undefined) ?? ref
    );
  }
  function upstreamDefinition(def: WorkflowDefinition) {
    const clean = portable(def);
    for (const step of clean.steps) {
      if (step.kind !== 'task' || !step.workflowRef) continue;
      step.workflowRef = originalRef(step.workflowRef);
    }
    return clean;
  }
  function preview(bundle: WorkflowPackage) {
    const entries = checkedEntries(bundle);
    const changes: string[] = [];
    const heads = entries.map((e) => {
      const found = exact(e),
        current = latest(e.id);
      if (found && found.digest !== digest(e.definition))
        throw new PackageError(
          '동일 출처의 같은 버전이 이미 다른 내용으로 등록되어 있습니다.',
        );
      if (
        !found &&
        !current &&
        db.prepare('SELECT 1 FROM workflow_versions WHERE id=?').get(e.id)
      )
        throw new PackageError(
          '로컬에서 작성한 흐름과 출처가 충돌합니다. 별도의 복사본으로 내보내세요.',
        );
      const head = current ? store.workflow(current.localId) : null;
      if (!found) {
        if (
          current &&
          e.version < current.version &&
          key(e) === key(bundle.root)
        )
          throw new PackageError('이미 더 높은 출처 버전을 설치했습니다.');
        if (head && current && e.version >= current.version) {
          changes.push(
            ...difference(
              upstreamDefinition(head.definition),
              e.definition,
              e.definition.name,
            ),
          );
        } else changes.push('Add ' + e.definition.name + ' · v' + e.version);
      }
      return [key(e), current?.localId, head?.version, found?.localVersion];
    });
    const row = latest(bundle.root.id) ?? exact(bundle.root);
    return {
      revision: digest([bundle, heads]),
      localVersion: row ? store.workflow(row.localId).version : null,
      modified: row ? modified(row) : false,
      installed: !!exact(bundle.root),
      changes,
    };
  }
  const install = db.transaction(
    (bundle: WorkflowPackage, expected: number | null, revision: string) => {
      const check = preview(bundle);
      const existing = exact(bundle.root);
      if (existing) return store.workflow(existing.localId);
      if (check.localVersion !== expected || check.revision !== revision)
        throw new StoreConflict();
      for (const e of checkedEntries(bundle)) {
        if (exact(e)) continue;
        const definition = structuredClone(e.definition);
        for (const step of definition.steps) {
          if (step.kind !== 'task' || !step.workflowRef) continue;
          const child = exact(step.workflowRef);
          if (!child)
            throw new PackageError('하위 버전을 연결하지 못했습니다.');
          step.workflowRef = { id: child.localId, version: child.localVersion };
        }
        const prev = latest(e.id);
        const head =
          prev && e.version > prev.version
            ? store.workflow(prev.localId)
            : null;
        if (head) {
          definition.input = head.definition.input;
          definition.projectFolder = head.definition.projectFolder;
        }
        const item = head
          ? store.updateWorkflow(head.id, head.version, definition)
          : store.createWorkflow(definition);
        db.prepare('INSERT INTO workflow_imports VALUES(?,?,?,?,?)').run(
          e.id,
          e.version,
          item.id,
          item.version,
          digest(e.definition),
        );
      }
      const result = exact(bundle.root)!;
      return store.workflow(result.localId, result.localVersion);
    },
  ).immediate;
  return { pack, origin, preview, install };
}
export function registerWorkflowPackages(
  app: FastifyInstance,
  db: Database.Database,
  store: StudioStore,
) {
  const packages = openWorkflowPackages(db, store);
  app.get<{ Params: { id: string; version: string } }>(
    '/workflows/:id/versions/:version/package',
    (req, reply) => {
      const version = versionSchema.safeParse(Number(req.params.version));
      if (
        !workflowIdSchema.safeParse(req.params.id).success ||
        !version.success
      )
        return reply.code(400).send({ error: 'invalid_request' });
      return packages.pack(req.params.id, version.data);
    },
  );
  app.get<{ Params: { id: string } }>(
    '/workflows/:id/package-origin',
    (req, reply) => {
      if (!workflowIdSchema.safeParse(req.params.id).success)
        return reply.code(400).send({ error: 'invalid_request' });
      return reply
        .type('application/json')
        .send(JSON.stringify(packages.origin(req.params.id)));
    },
  );
  const preview = z.strictObject({ bundle: workflowPackageSchema });
  const install = preview.extend({
    expectedLocalVersion: versionSchema.nullable(),
    revision: z.string().length(64),
  });
  app.register(async (endpoints) => {
    endpoints.setErrorHandler((err, _req, reply) => {
      if (err instanceof PackageError)
        return reply
          .code(400)
          .send({ error: 'invalid_package', detail: err.message });
      throw err;
    });
    const limit = { bodyLimit: 32 * 1024 * 1024 };
    endpoints.post('/workflow-packages/preview', limit, (req, reply) => {
      const parsed = preview.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: 'invalid_package',
          detail: '지원되는 Workplot 공유 파일인지 확인하세요.',
        });
      return packages.preview(parsed.data.bundle);
    });
    endpoints.post('/workflow-packages/import', limit, (req, reply) => {
      const parsed = install.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ error: 'invalid_request' });
      return packages.install(
        parsed.data.bundle,
        parsed.data.expectedLocalVersion,
        parsed.data.revision,
      );
    });
  });
}
