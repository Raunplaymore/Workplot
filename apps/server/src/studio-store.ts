import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  runInputSchema,
  runListSchema,
  runSummarySchema,
  storedRunSchema,
  type RunInput,
  type RetryCheckpoint,
  workflowListSchema,
  workflowVersionSchema,
  type WorkflowDefinition,
} from '@studio/contracts';

export class StoreConflict extends Error {}
export class StoreNotFound extends Error {}

export function openStudioStore(db: Database.Database) {
  db.pragma('foreign_keys = ON');
  db.transaction(() => {
    db.exec(
      'CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    const meta = db
      .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
      .pluck();
    const version = meta.get();
    if (version === '2') return;
    if (version !== undefined && version !== '1')
      throw new Error('지원하지 않는 저장소 버전');
    db.exec(`
      CREATE TABLE workflow_versions (
        id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        saved_at TEXT NOT NULL,
        definition TEXT NOT NULL CHECK (json_valid(definition)),
        PRIMARY KEY (id, version)
      ) STRICT;
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_version INTEGER NOT NULL,
        record TEXT NOT NULL CHECK (json_valid(record)),
        FOREIGN KEY (workflow_id, workflow_version) REFERENCES workflow_versions (id, version)
      ) STRICT;
      INSERT INTO app_metadata (key, value) VALUES ('schema_version', '2')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `);
  }).immediate();

  const latest = db.prepare(`
    SELECT id, version, saved_at AS savedAt, definition
    FROM workflow_versions WHERE id = ? ORDER BY version DESC LIMIT 1
  `);
  const exact = db.prepare(`
    SELECT id, version, saved_at AS savedAt, definition FROM workflow_versions
    WHERE id = ? AND version = ?
  `);
  function workflow(id: string, version?: number) {
    const row = (
      version === undefined ? latest.get(id) : exact.get(id, version)
    ) as
      | { id: string; version: number; savedAt: string; definition: string }
      | undefined;
    if (!row) throw new StoreNotFound();
    return workflowVersionSchema.parse({
      ...row,
      definition: JSON.parse(row.definition),
    });
  }

  const insertVersion = db.prepare(
    'INSERT INTO workflow_versions VALUES (?, ?, ?, ?)',
  );
  function insertWorkflow(
    id: string,
    version: number,
    definition: WorkflowDefinition,
  ) {
    const record = workflowVersionSchema.parse({
      id,
      version,
      definition,
      savedAt: new Date().toISOString(),
    });
    insertVersion.run(
      id,
      version,
      record.savedAt,
      JSON.stringify(record.definition),
    );
    return record;
  }
  const updateWorkflow = db.transaction(
    (id: string, baseVersion: number, definition: WorkflowDefinition) => {
      const current = workflow(id);
      if (current.version !== baseVersion) throw new StoreConflict();
      return insertWorkflow(id, baseVersion + 1, definition);
    },
  );

  const list = db.prepare(`
    SELECT w.id, w.version, w.saved_at AS savedAt, json_extract(w.definition, '$.name') AS name
    FROM workflow_versions w JOIN (
      SELECT id, max(version) AS version FROM workflow_versions GROUP BY id
    ) latest USING (id, version)
    ORDER BY w.saved_at DESC, w.id
  `);
  const listRuns = db.prepare(`
    SELECT r.id, r.workflow_version AS workflowVersion,
      json_extract(w.definition, '$.name') AS name,
      json_extract(r.record, '$.summary.recordedAt') AS recordedAt,
      json_extract(r.record, '$.summary.status') AS status
    FROM runs r JOIN workflow_versions w ON w.id = r.workflow_id AND w.version = r.workflow_version
    ORDER BY recordedAt DESC, r.rowid DESC
  `);
  const insertRun = db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)');
  const readRun = db.prepare('SELECT record FROM runs WHERE id = ?').pluck();
  const updateRun = db.prepare('UPDATE runs SET record = ? WHERE id = ?');
  function run(id: string) {
    const raw = readRun.get(id);
    if (typeof raw !== 'string') throw new StoreNotFound();
    const record = storedRunSchema.parse(JSON.parse(raw));
    const directory = `runs/${record.summary.id}`;
    return {
      ...record,
      logRef: `${directory}/events.jsonl`,
      resultRefs: record.results.map((name) => `${directory}/${name}`),
    };
  }

  return {
    workflow,
    listRuns: () => runListSchema.parse(listRuns.all()),
    listWorkflows: () => workflowListSchema.parse(list.all()),
    createWorkflow: (definition: WorkflowDefinition) =>
      insertWorkflow(randomUUID(), 1, definition),
    updateWorkflow: (
      id: string,
      baseVersion: number,
      definition: WorkflowDefinition,
    ) => updateWorkflow.immediate(id, baseVersion, definition),
    // Only the future server runner can supply ownership and session metadata.
    recordRun(input: RunInput, id: string = randomUUID()) {
      const { sessionId, process, results, ...summaryFields } =
        runInputSchema.parse(input);
      workflow(summaryFields.workflowId, summaryFields.workflowVersion);
      const summary = runSummarySchema.parse({
        ...summaryFields,
        id,
        provider: 'codex',
        recordedAt: new Date().toISOString(),
      });
      insertRun.run(
        summary.id,
        summary.workflowId,
        summary.workflowVersion,
        JSON.stringify({ summary, sessionId, process, results }),
      );
      return summary;
    },
    run,
    updateRun(
      id: string,
      patch: Pick<RunInput, 'status' | 'sessionId' | 'process' | 'results'> & {
        retry?: RetryCheckpoint;
      },
    ) {
      const { summary } = run(id);
      const record = storedRunSchema.parse({
        summary: { ...summary, status: patch.status },
        sessionId: patch.sessionId,
        process: patch.process,
        results: patch.results,
        retry: patch.retry,
      });
      updateRun.run(JSON.stringify(record), id);
      return record.summary;
    },
  };
}

export type StudioStore = ReturnType<typeof openStudioStore>;
