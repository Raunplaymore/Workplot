import type Database from 'better-sqlite3';
import type { GitIntegrationEntry } from '@studio/contracts';

export function openGitQueue(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS git_batches(master TEXT PRIMARY KEY REFERENCES master_runs(id));
    CREATE TABLE IF NOT EXISTS git_queue(
      sequence INTEGER PRIMARY KEY, master TEXT NOT NULL REFERENCES git_batches(master),
      run TEXT NOT NULL UNIQUE REFERENCES runs(id), task TEXT NOT NULL, lane TEXT NOT NULL,
      base TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      parent TEXT, candidate TEXT, detail TEXT NOT NULL DEFAULT '', files TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS git_queue_lane ON git_queue(lane, sequence);`);
  db.exec(
    'CREATE TABLE IF NOT EXISTS team_check_receipts(base TEXT NOT NULL,candidate TEXT NOT NULL,policy TEXT NOT NULL,PRIMARY KEY(base,candidate))',
  );
  function entries(where: string, value: string) {
    const rows = db
      .prepare('SELECT * FROM git_queue WHERE ' + where + ' ORDER BY sequence')
      .all(value) as (Omit<GitIntegrationEntry, 'files'> & {
      files: string;
      lane: string;
      master: string;
    })[];
    return rows.map((r) => ({ ...r, files: JSON.parse(r.files) as string[] }));
  }
  return {
    recordTeamCheck: (r: { base: string; candidate: string; policy: string }) =>
      db
        .prepare('INSERT OR REPLACE INTO team_check_receipts VALUES(?,?,?)')
        .run(r.base, r.candidate, r.policy),
    teamPolicy: (base: string, candidate: string) =>
      db
        .prepare(
          'SELECT policy FROM team_check_receipts WHERE base=? AND candidate=?',
        )
        .pluck()
        .get(base, candidate) as string | undefined,
    register: (id: string) =>
      db.prepare('INSERT OR IGNORE INTO git_batches VALUES(?)').run(id),
    batches: () =>
      db
        .prepare(
          `SELECT master FROM git_batches
      WHERE NOT EXISTS(SELECT 1 FROM master_stops WHERE id=master)
      AND NOT EXISTS(SELECT 1 FROM git_queue q WHERE q.master=git_batches.master)`,
        )
        .pluck()
        .all() as string[],
    registered: (id: string) =>
      !!db.prepare('SELECT 1 FROM git_batches WHERE master=?').get(id),
    list: (id: string) => entries('master=?', id),
    enqueue: db.transaction(
      (
        master: string,
        lane: string,
        jobs: { run: string; task: string; source: string; base: string }[],
      ) => {
        const add = db.prepare(
          'INSERT INTO git_queue(master,lane,run,task,base,source) VALUES(?,?,?,?,?,?) ON CONFLICT(run) DO NOTHING',
        );
        for (const j of jobs)
          add.run(master, lane, j.run, j.task, j.base, j.source);
      },
    ).immediate,
    queuedLanes: () =>
      db
        .prepare("SELECT DISTINCT lane FROM git_queue WHERE status='queued'")
        .pluck()
        .all() as string[],
    next: (lane: string) => entries("status='queued' AND lane=?", lane)[0],
    lastVerified: (lane: string) =>
      db
        .prepare(
          "SELECT candidate FROM git_queue WHERE lane=? AND status='verified' ORDER BY sequence DESC LIMIT 1",
        )
        .pluck()
        .get(lane) as string | undefined,
    setParent: (id: number, parent: string) =>
      db
        .prepare(
          "UPDATE git_queue SET parent=? WHERE sequence=? AND status='checking'",
        )
        .run(parent, id),
    claim: (id: number, parent: string) =>
      db
        .prepare(
          `UPDATE git_queue SET status='checking',parent=? WHERE sequence=? AND status='queued'
      AND NOT EXISTS(SELECT 1 FROM git_queue other WHERE other.lane=git_queue.lane AND other.status='checking')`,
        )
        .run(parent, id).changes === 1,
    finish: (
      id: number,
      status: GitIntegrationEntry['status'],
      candidate: string | null,
      files: string[],
      detail: string,
    ) =>
      db
        .prepare(
          "UPDATE git_queue SET status=?,candidate=?,files=?,detail=? WHERE sequence=? AND status='checking'",
        )
        .run(status, candidate, JSON.stringify(files), detail, id),
    recover: () =>
      db
        .prepare("UPDATE git_queue SET status='queued' WHERE status='checking'")
        .run(),
    stop: (master: string) =>
      db
        .prepare(
          "UPDATE git_queue SET status='stopped' WHERE master=? AND status IN ('queued','checking')",
        )
        .run(master),
  };
}
