import { openGitQueue } from './git-queue-store.js';
import type { Reference } from './request-files.js';
import { expandWorkflow } from './linked-workflow.js';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  masterPlanSchema,
  type RunMaterial,
  type GitTarget,
  runInputSchema,
  runListSchema,
  runSummarySchema,
  storedRunSchema,
  type RunInput,
  type ReviewReceipt,
  type RetryCheckpoint,
  type PausedReview,
  workflowListSchema,
  workflowVersionSchema,
  type WorkflowDefinition,
} from '@studio/contracts';

export class StoreConflict extends Error {}
export class RetrySlotBusy extends StoreConflict {}
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

  db.exec(
    'CREATE TABLE IF NOT EXISTS workflow_favorites (workflow_id TEXT PRIMARY KEY) STRICT',
  );
  db.exec(
    'CREATE TABLE IF NOT EXISTS workflow_locations(id TEXT PRIMARY KEY, location TEXT NOT NULL, restore_to TEXT NOT NULL) STRICT',
  );
  const locationRow = db.prepare(
    'SELECT location,restore_to FROM workflow_locations WHERE id=?',
  );
  function placement(id: string) {
    return (
      (locationRow.get(id) as
        { location: string; restore_to: string } | undefined) ?? {
        location: 'active',
        restore_to: 'active',
      }
    );
  }
  function allowUse(id: string) {
    if (placement(id).location === 'trash') throw new StoreConflict();
  }
  const library = db.prepare(`
    SELECT w.id, w.version, w.saved_at AS savedAt, json_extract(w.definition,'$.name') AS name,
           coalesce(json_extract(w.definition,'$.goal'),'') AS goal, coalesce(l.location,'active') AS location, f.workflow_id IS NOT NULL AS favorite
    FROM workflow_versions w JOIN (SELECT id,max(version) AS version FROM workflow_versions GROUP BY id) latest USING (id,version)
    LEFT JOIN workflow_locations l ON l.id=w.id LEFT JOIN workflow_favorites f ON f.workflow_id=w.id ORDER BY w.saved_at DESC
  `);
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
    expandWorkflow(id, record.definition, workflow);
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
      allowUse(id);
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
    WHERE NOT EXISTS(SELECT 1 FROM workflow_locations l WHERE l.id=w.id AND l.location!='active') ORDER BY w.saved_at DESC, w.id
  `);
  const listRuns = db.prepare(`
    SELECT r.id, r.workflow_id AS workflowId, r.workflow_version AS workflowVersion,
      coalesce(nullif(json_extract(r.record,'$.material.name'),''),json_extract(w.definition, '$.name')) AS name,
      json_extract(r.record, '$.summary.recordedAt') AS recordedAt,
      json_extract(r.record, '$.summary.status') AS status,
      json_extract(r.record,'$.retry.quotaRetryAt') AS quotaRetryAt,
      CASE WHEN json_extract(r.record,'$.summary.isolatedGit') THEN json_extract(r.record,'$.summary.developmentTaskId') END AS isolatedTask,
      json_extract(r.record,'$.summary.master.runId') AS masterRunId,
      json_extract(r.record,'$.summary.requestFiles.handoff.runId') AS handoffRunId,
      json_extract(r.record,'$.summary.previousSessionId') AS previousSessionId,
      (json_array_length(r.record,'$.results') > 1 OR json_type(r.record,'$.summary.origin') IS NOT NULL) AS comparable
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

  function recordRun(input: RunInput, id: string = randomUUID()) {
    const { sessionId, process, results, material, ...summaryFields } =
      runInputSchema.parse(input);
    if (!summaryFields.previousSessionId) allowUse(summaryFields.workflowId);
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
      JSON.stringify({ summary, sessionId, process, results, material }),
    );
    return summary;
  }

  db.exec(`CREATE TABLE IF NOT EXISTS master_runs (
    id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, children TEXT NOT NULL CHECK(json_valid(children))
  ) STRICT`);
  db.exec(`CREATE TABLE IF NOT EXISTS master_ui_sources (
    id TEXT PRIMARY KEY REFERENCES master_runs(id), baseline TEXT NOT NULL, report TEXT
  ) STRICT`);
  db.exec(`CREATE TABLE IF NOT EXISTS master_ui_steps (
    run_id TEXT NOT NULL REFERENCES runs(id), step TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(run_id,step)
  ) STRICT`);
  db.exec(
    'CREATE TABLE IF NOT EXISTS master_stops (id TEXT PRIMARY KEY REFERENCES master_runs(id)) STRICT',
  );
  function masterRun(id: string) {
    const row = db
      .prepare('SELECT plan_id,children FROM master_runs WHERE id=?')
      .get(id) as { plan_id: string; children: string } | undefined;
    return (
      row && {
        id,
        planId: row.plan_id,
        children: JSON.parse(row.children) as {
          taskId: string;
          runId: string;
        }[],
      }
    );
  }
  function masterPlan(id: string) {
    const row = db
      .prepare('SELECT definition FROM master_plans WHERE id=?')
      .get(id) as { definition: string } | undefined;
    if (!row) throw new StoreNotFound();
    return masterPlanSchema.parse(JSON.parse(row.definition));
  }
  db.exec(
    'CREATE TABLE IF NOT EXISTS request_snapshots(id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  );
  db.exec(`CREATE TABLE IF NOT EXISTS development_services(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS git_bindings(service_id TEXT NOT NULL REFERENCES development_services(id),checkout_id TEXT NOT NULL,path TEXT NOT NULL,repo_id TEXT NOT NULL, PRIMARY KEY(service_id,checkout_id,path));
    CREATE TABLE IF NOT EXISTS development_worktrees(task TEXT PRIMARY KEY,directory TEXT NOT NULL,path TEXT NOT NULL,branch TEXT NOT NULL,base TEXT NOT NULL,head TEXT NOT NULL,dirty_hash TEXT,pending TEXT,ready INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS run_model_calls(id INTEGER PRIMARY KEY, run TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, step TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS run_model_calls_run ON run_model_calls(run);
    CREATE TABLE IF NOT EXISTS development_calls(id INTEGER PRIMARY KEY,run TEXT NOT NULL REFERENCES runs(id),step TEXT NOT NULL,pid INTEGER NOT NULL,session TEXT,observedAt TEXT NOT NULL);`);
  const gitQueue = openGitQueue(db);
  function bindings() {
    return db
      .prepare(
        'SELECT s.name AS service,s.id AS serviceId,b.checkout_id AS checkoutId,b.repo_id AS repositoryId,b.path FROM development_services s JOIN git_bindings b ON b.service_id=s.id ORDER BY s.name,b.path',
      )
      .all() as Pick<
      GitTarget,
      'service' | 'serviceId' | 'checkoutId' | 'repositoryId' | 'path'
    >[];
  }
  db.exec(
    'CREATE TABLE IF NOT EXISTS qa_port_checks(run TEXT PRIMARY KEY REFERENCES runs(id), evidence TEXT NOT NULL, token TEXT NOT NULL, passed INTEGER NOT NULL, reason TEXT NOT NULL)',
  );
  db.exec(`CREATE TABLE IF NOT EXISTS review_edits (
    run TEXT NOT NULL REFERENCES runs(id), gate TEXT PRIMARY KEY, file TEXT NOT NULL,
    expected TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS review_edits_file ON review_edits(run,file);`);
  return {
    bindings,
    portResult(run: string, evidence: string) {
      return db
        .prepare(
          'SELECT token,passed,reason FROM qa_port_checks WHERE run=? AND evidence=?',
        )
        .get(run, evidence) as
        { token: string; passed: number; reason: string } | undefined;
    },
    savePortResult(
      run: string,
      evidence: string,
      token: string,
      passed: boolean,
      reason: string,
    ) {
      db.prepare('INSERT OR REPLACE INTO qa_port_checks VALUES(?,?,?,?,?)').run(
        run,
        evidence,
        token,
        Number(passed),
        reason,
      );
    },
    editedFiles(id: string) {
      return db
        .prepare('SELECT DISTINCT file FROM review_edits WHERE run=?')
        .pluck()
        .all(id) as string[];
    },
    reviewEdits(id: string, file: string) {
      return db
        .prepare(
          'SELECT expected,text,at FROM review_edits WHERE run=? AND file=? ORDER BY rowid',
        )
        .all(id, file) as { expected: string; text: string; at: string }[];
    },
    slotLimit() {
      return Number(
        db
          .prepare(
            "SELECT value FROM app_metadata WHERE key='development_slots'",
          )
          .pluck()
          .get(),
      );
    },
    setSlotLimit(limit: number) {
      db.prepare(
        "INSERT INTO app_metadata(key,value) VALUES('development_slots',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(String(limit));
    },
    gitQueue,
    worktree(task: string) {
      return db
        .prepare(
          'SELECT directory,path,branch,base,head,dirty_hash AS dirtyHash,pending,ready FROM development_worktrees WHERE task=?',
        )
        .get(task) as
        | {
            directory: string;
            path: string;
            branch: string;
            base: string;
            head: string;
            dirtyHash: string | null;
            pending: string | null;
            ready: number;
          }
        | undefined;
    },
    planWorktree(
      task: string,
      v: { directory: string; path: string; branch: string; base: string },
    ) {
      db.prepare(
        'INSERT OR IGNORE INTO development_worktrees(task,directory,path,branch,base,head) VALUES(?,?,?,?,?,?)',
      ).run(task, v.directory, v.path, v.branch, v.base, v.base);
    },
    saveWorktreeChanges(task: string, digest: string | null) {
      db.prepare(
        'UPDATE development_worktrees SET dirty_hash=? WHERE task=?',
      ).run(digest, task);
    },
    prepareCheckpoint(task: string, head: string, next: string) {
      if (
        !db
          .prepare(
            'UPDATE development_worktrees SET pending=? WHERE task=? AND head=? AND pending IS NULL',
          )
          .run(next, task, head).changes
      )
        throw new StoreConflict();
    },
    finishWorktree(task: string, head: string) {
      db.prepare(
        'UPDATE development_worktrees SET head=?,dirty_hash=NULL,pending=NULL,ready=1 WHERE task=?',
      ).run(head, task);
    },
    bind: db.transaction(
      (service: string, location: Omit<GitTarget, 'service' | 'serviceId'>) => {
        db.prepare(
          'INSERT INTO development_services VALUES(?,?) ON CONFLICT(name) DO NOTHING',
        ).run(randomUUID(), service);
        const serviceId = db
          .prepare('SELECT id FROM development_services WHERE name=?')
          .pluck()
          .get(service) as string;
        db.prepare(
          'INSERT INTO git_bindings VALUES(?,?,?,?) ON CONFLICT(service_id,checkout_id,path) DO UPDATE SET repo_id=excluded.repo_id',
        ).run(
          serviceId,
          location.checkoutId,
          location.path,
          location.repositoryId,
        );
        return { service, serviceId, ...location };
      },
    ).immediate,
    recordModel(run: string, step: string, model: string, effort: string) {
      db.prepare(
        'INSERT INTO run_model_calls(run,step,model,effort) VALUES(?,?,?,?)',
      ).run(run, step, model, effort);
    },
    modelCalls(run: string) {
      return db
        .prepare(
          'SELECT step,model,effort FROM run_model_calls WHERE run=? ORDER BY id',
        )
        .all(run);
    },
    startCall(run: string, step: string, pid: number) {
      return Number(
        db
          .prepare(
            'INSERT INTO development_calls(run,step,pid,observedAt) VALUES(?,?,?,?)',
          )
          .run(run, step, pid, new Date().toISOString()).lastInsertRowid,
      );
    },
    identifyCall(id: number, session: string) {
      db.prepare('UPDATE development_calls SET session=? WHERE id=?').run(
        session,
        id,
      );
    },
    calls(run: string) {
      return db
        .prepare(
          'SELECT step,pid,session,observedAt FROM development_calls WHERE run=? ORDER BY id',
        )
        .all(run);
    },
    recordWithSnapshot: db.transaction(
      (
        input: RunInput,
        id: string,
        data: { workspace?: string; refs: Reference[] },
      ) => {
        const summary = recordRun(input, id);
        db.prepare('INSERT INTO request_snapshots VALUES(?,?)').run(
          id,
          JSON.stringify(data),
        );
        return summary;
      },
    ).immediate,
    requestSnapshot(id: string) {
      const raw = db
        .prepare('SELECT data FROM request_snapshots WHERE id=?')
        .pluck()
        .get(id);
      if (typeof raw !== 'string') throw new StoreNotFound();
      return JSON.parse(raw) as { workspace?: string; refs: Reference[] };
    },
    workflow,
    masterRun,
    masterPlan,
    masterStopped: (id: string) =>
      Boolean(db.prepare('SELECT 1 FROM master_stops WHERE id=?').get(id)),
    closeMaster: (id: string) =>
      db
        .prepare(
          'INSERT INTO master_stops(id) VALUES(?) ON CONFLICT DO NOTHING',
        )
        .run(id),
    recordUiDigest(runId: string, step: string, digest: string) {
      db.prepare(
        'INSERT INTO master_ui_steps VALUES(?,?,?) ON CONFLICT(run_id,step) DO NOTHING',
      ).run(runId, step, digest);
      if (this.uiDigest(runId, step) !== digest) throw new StoreConflict();
    },
    uiDigest(runId: string, step: string) {
      return db
        .prepare('SELECT digest FROM master_ui_steps WHERE run_id=? AND step=?')
        .pluck()
        .get(runId, step);
    },
    unreportedUiMasters: () =>
      db
        .prepare(
          `SELECT s.id FROM master_ui_sources s JOIN master_runs m ON s.id=m.id
      WHERE s.report IS NULL AND NOT EXISTS (SELECT 1 FROM master_stops WHERE id=m.id) AND NOT EXISTS (
        SELECT 1 FROM json_each(m.children) c LEFT JOIN runs r ON r.id=json_extract(c.value,'$.runId')
        WHERE json_extract(r.record,'$.summary.status') IS NOT 'completed'
      )`,
        )
        .pluck()
        .all() as string[],
    hasMasterSources: (id: string) =>
      Boolean(db.prepare('SELECT 1 FROM master_ui_sources WHERE id=?').get(id)),
    masterSources(id: string) {
      const row = db
        .prepare('SELECT baseline FROM master_ui_sources WHERE id=?')
        .pluck()
        .get(id) as string | undefined;
      return row ? (JSON.parse(row) as Record<string, string>) : undefined;
    },
    integrationReport(id: string) {
      const row = db
        .prepare('SELECT report FROM master_ui_sources WHERE id=?')
        .pluck()
        .get(id) as string | null | undefined;
      return row
        ? (JSON.parse(row) as {
            status: string;
            branch?: string;
            verifiedStage?: string;
            directory?: string;
            reason?: string;
            files?: string[];
          })
        : null;
    },
    saveIntegration(
      id: string,
      report: {
        status: string;
        directory?: string;
        reason?: string;
        files?: string[];
      },
    ) {
      db.prepare('UPDATE master_ui_sources SET report=? WHERE id=?').run(
        JSON.stringify(report),
        id,
      );
    },
    recordMasterRun: db.transaction(
      (
        id: string,
        planId: string,
        cliVersion: string,
        branches: {
          taskId: string;
          workflowId: string;
          version: number;
          material?: RunMaterial;
        }[],
        baseline?: Record<string, string>,
        gitTarget?: GitTarget,
      ) => {
        const children = branches.map((b) => {
          const childId = randomUUID();
          const summary = recordRun(
            {
              ...(gitTarget && {
                developmentTaskId: childId,
                isolatedGit: true,
                requestFiles: {
                  references: [],
                  workspace: gitTarget.path,
                  gitTarget,
                },
              }),
              master: { runId: id, planId, taskId: b.taskId },
              workflowId: b.workflowId,
              workflowVersion: b.version,
              cliVersion,
              status: 'queued',
              material: b.material,
              sessionId: null,
              process: null,
              results: [],
            },
            childId,
          );
          return { taskId: b.taskId, runId: summary.id };
        });
        db.prepare('INSERT INTO master_runs VALUES(?,?,?)').run(
          id,
          planId,
          JSON.stringify(children),
        );
        if (gitTarget) gitQueue.register(id);
        if (baseline)
          db.prepare(
            'INSERT INTO master_ui_sources(id,baseline) VALUES(?,?)',
          ).run(id, JSON.stringify(baseline));
        return { id, planId, children };
      },
    ).immediate,
    executionDefinition: (id: string, version: number) =>
      expandWorkflow(id, workflow(id, version).definition, workflow),
    allowUse,
    move: db.transaction(
      (
        id: string,
        from: string,
        action: 'archive' | 'trash' | 'restore',
        pause: () => void,
      ) => {
        workflow(id);
        const old = placement(id);
        if (
          from !== old.location ||
          (action === 'archive' && from !== 'active') ||
          (action === 'trash' && from === 'trash') ||
          (action === 'restore' && from === 'active')
        )
          throw new StoreConflict();
        const next =
          action === 'archive'
            ? 'archived'
            : action === 'trash'
              ? 'trash'
              : from === 'trash'
                ? old.restore_to
                : 'active';
        if (next === 'trash') pause();
        db.prepare(
          'INSERT OR REPLACE INTO workflow_locations VALUES (?,?,?)',
        ).run(id, next, next === 'trash' ? from : 'active');
        return next;
      },
    ).immediate,
    listLibrary: () =>
      library.all().map((row) => ({
        ...(row as Record<string, unknown>),
        favorite: Boolean((row as { favorite: number }).favorite),
      })),
    favorite(id: string, on: boolean) {
      workflow(id);
      db.prepare(
        on
          ? 'INSERT OR IGNORE INTO workflow_favorites VALUES (?)'
          : 'DELETE FROM workflow_favorites WHERE workflow_id=?',
      ).run(id);
    },
    listRuns: () => runListSchema.parse(listRuns.all()),
    listWorkflows: () => workflowListSchema.parse(list.all()),
    createWorkflow: (definition: WorkflowDefinition) =>
      insertWorkflow(randomUUID(), 1, definition),
    saveLinkedInstructions: db.transaction(
      (
        id: string,
        baseVersion: number,
        definition: WorkflowDefinition,
        stepId: string,
        childDefinition: WorkflowDefinition,
      ) => {
        const step = definition.steps.find((s) => s.id === stepId);
        if (
          step?.kind !== 'task' ||
          !step.workflowRef ||
          step.workflowRef.id === id
        )
          throw new StoreConflict();
        const child = updateWorkflow(
          step.workflowRef.id,
          step.workflowRef.version,
          childDefinition,
        );
        return updateWorkflow(id, baseVersion, {
          ...definition,
          steps: definition.steps.map((s) =>
            s.id === stepId
              ? {
                  ...step,
                  workflowRef: { id: child.id, version: child.version },
                }
              : s,
          ),
        });
      },
    ).immediate,
    updateWorkflow: (
      id: string,
      baseVersion: number,
      definition: WorkflowDefinition,
    ) => updateWorkflow.immediate(id, baseVersion, definition),
    recordRun,
    sessionMission(id: string) {
      let first = run(id);
      const seen = new Set<string>([id]);
      while (first.summary.previousSessionId) {
        const parentId = first.summary.previousSessionId;
        if (seen.has(parentId)) throw new StoreConflict();
        seen.add(parentId);
        const parent = run(parentId);
        if (
          parent.summary.nextSessionId !== first.summary.id ||
          parent.summary.workflowId !== first.summary.workflowId ||
          parent.summary.workflowVersion !== first.summary.workflowVersion
        )
          throw new StoreConflict();
        first = parent;
      }
      if (first.summary.taskRequest) return first.summary.taskRequest;
      if (first.material?.source.trim()) return first.material.source;
      const { definition } = workflow(
        first.summary.workflowId,
        first.summary.workflowVersion,
      );
      return definition.input?.trim() || definition.goal || '';
    },
    recordNextSession: db.transaction(
      (
        parentId: string,
        source: string,
        finish: (childId: string) => void,
        newTask = false,
        parentStatus: 'waiting' | 'completed' = 'waiting',
      ) => {
        const parent = run(parentId);
        if (
          parent.summary.status !== parentStatus ||
          parent.summary.nextSessionId
        )
          throw new StoreConflict();
        const { workflowId, workflowVersion, cliVersion } = parent.summary;
        const child = recordRun({
          workflowId,
          workflowVersion,
          cliVersion,
          previousSessionId: parentId,
          isolatedGit: parent.summary.isolatedGit,
          developmentTaskId: parent.summary.developmentTaskId
            ? newTask
              ? randomUUID()
              : parent.summary.developmentTaskId
            : undefined,
          modelSettings: parent.summary.modelSettings,
          taskRequest: parent.summary.taskRequest,
          snapshotId: parent.summary.snapshotId,
          requestFiles: parent.summary.requestFiles,
          status: 'queued',
          material: { name: '', source },
          sessionId: null,
          process: null,
          results: [],
        });
        db.prepare(
          "UPDATE runs SET record=json_set(record,'$.summary.nextSessionId',?) WHERE id=?",
        ).run(child.id, parentId);
        finish(child.id);
        return child;
      },
    ).immediate,
    recordRerun: db.transaction(
      (
        input: RunInput,
        baseVersion: number,
        definition: WorkflowDefinition,
      ) => {
        updateWorkflow(input.workflowId, baseVersion, definition);
        return recordRun(input);
      },
    ).immediate,
    run,
    pausedReviews: () =>
      db
        .prepare(
          "SELECT id FROM runs WHERE json_extract(record,'$.summary.status')='waiting' AND json_type(record,'$.pausedReview')='object'",
        )
        .pluck()
        .all() as string[],
    saveReview(id: string, checkpoint: PausedReview) {
      const result = db
        .prepare(
          "UPDATE runs SET record=json_set(record,'$.pausedReview',json(?),'$.process',NULL) WHERE id=? AND json_extract(record,'$.summary.status')='waiting'",
        )
        .run(JSON.stringify(checkpoint), id);
      if (!result.changes) throw new StoreConflict();
    },
    recordReviewDecision: db.transaction(
      (
        id: string,
        receipt: ReviewReceipt,
        restored: boolean,
        edit?: { file: string; expected: string; text: string },
      ) => {
        const result = db
          .prepare(
            "UPDATE runs SET record=json_set(json_remove(record,'$.pausedReview'),'$.summary.lastReview',json(?)) WHERE id=? AND json_extract(record,'$.summary.status')='waiting' AND (?=0 OR json_extract(record,'$.pausedReview.gateId')=?)",
          )
          .run(JSON.stringify(receipt), id, Number(restored), receipt.gateId);
        if (!result.changes) throw new StoreConflict();
        if (edit)
          db.prepare('INSERT INTO review_edits VALUES(?,?,?,?,?,?)').run(
            id,
            receipt.gateId,
            edit.file,
            edit.expected,
            edit.text,
            receipt.at,
          );
      },
    ).immediate,
    updateRun(
      id: string,
      patch: Pick<RunInput, 'status' | 'sessionId' | 'process' | 'results'> & {
        retry?: RetryCheckpoint;
        completedHashes?: string[];
      },
    ) {
      const { summary, material } = run(id);
      const record = storedRunSchema.parse({
        summary: { ...summary, status: patch.status },
        material,
        sessionId: patch.sessionId,
        process: patch.process,
        results: patch.results,
        retry: patch.retry,
        completedHashes: patch.completedHashes,
      });
      updateRun.run(JSON.stringify(record), id);
      return record.summary;
    },
  };
}

export type StudioStore = ReturnType<typeof openStudioStore>;
