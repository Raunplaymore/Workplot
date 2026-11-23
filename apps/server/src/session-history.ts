import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { workflowIdSchema } from '@studio/contracts';
import {
  StoreConflict,
  StoreNotFound,
  type StudioStore,
} from './studio-store.js';

const lifetime = 30 * 86400000;
const terminal = "('completed','stopped','failed')";
type Row = {
  id: string;
  closed: number | null;
  next: string | null;
  kept: string;
  digest: string | null;
  expired: number;
};

export function createSessionHistory(
  db: Database.Database,
  store: StudioStore,
  root: string,
  now = Date.now,
) {
  const clock = "CAST(unixepoch('subsec')*1000 AS INTEGER)";
  const eligible = (row: string) =>
    `EXISTS (SELECT 1 FROM workflow_versions w, json_each(w.definition,'$.steps') step WHERE w.id=${row}.workflow_id AND w.version=${row}.workflow_version AND json_extract(step.value,'$.startNextSession')=1)`;
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS session_history (
      id TEXT PRIMARY KEY REFERENCES runs(id), closed INTEGER, kept TEXT NOT NULL DEFAULT '[]',
      digest TEXT, expired INTEGER NOT NULL DEFAULT 0, pending TEXT
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS session_history_insert AFTER INSERT ON runs WHEN ${eligible('NEW')}
    BEGIN INSERT INTO session_history(id,closed) VALUES (NEW.id,CASE WHEN json_extract(NEW.record,'$.summary.status') IN ${terminal} THEN ${clock} END); END;
    CREATE TRIGGER IF NOT EXISTS session_history_update AFTER UPDATE OF record ON runs
    WHEN json_extract(NEW.record,'$.summary.status') != json_extract(OLD.record,'$.summary.status')
    BEGIN UPDATE session_history SET closed=CASE WHEN json_extract(NEW.record,'$.summary.status') IN ${terminal} THEN ${clock} END,
    digest=NULL WHERE id=NEW.id AND expired=0; END;`);
    // Initialize legacy sessions once. Their full grace period starts on installation.
    db.prepare(
      `INSERT OR IGNORE INTO session_history(id,closed)
      SELECT r.id, CASE WHEN json_extract(r.record,'$.summary.status') IN ${terminal} THEN ? END
      FROM runs r WHERE NOT EXISTS(SELECT 1 FROM session_history h WHERE h.id=r.id) AND ${eligible('r')}`,
    ).run(now());
  }).immediate();
  const select =
    db.prepare(`SELECT h.*,json_extract(record,'$.summary.nextSessionId') AS next
    FROM session_history h JOIN runs r USING(id) WHERE h.id=?`);
  function deadline(row: Row) {
    const seen = new Set<string>();
    let latest = 0,
      current: Row | undefined = row;
    while (current && current.closed !== null && !seen.has(current.id)) {
      seen.add(current.id);
      latest = Math.max(latest, current.closed);
      if (!current.next) return latest + lifetime;
      current = select.get(current.next) as Row | undefined;
    }
    return null;
  }
  function directory(id: string) {
    workflowIdSchema.parse(id);
    const path = join(realpathSync(resolve(root)), 'runs', id);
    try {
      if (realpathSync(path) !== path) throw new StoreConflict();
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  function summary(row: Row) {
    if (row.digest !== null) return row.digest;
    const run = store.run(row.id);
    const dir = directory(row.id);
    let detail = '';
    const name = ['change-evidence.md', 'session-review.md'].find((n) =>
      run.results.includes(n),
    );
    if (name && dir) {
      let fd;
      try {
        fd = openSync(
          join(dir, name),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const stat = fstatSync(fd);
        if (stat.isFile() && stat.nlink === 1 && stat.size <= 128000) {
          const lines = (
            store.reviewEdits(row.id, name).at(-1)?.text ??
            readFileSync(fd, 'utf8')
          )
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
          const change = lines.find(
            (s) => !s.startsWith('#') && !s.startsWith('변경 파일:'),
          );
          const checks = lines.find((s) => s.startsWith('실제 검사:'));
          detail = [change?.slice(0, 180), checks].filter(Boolean).join(' · ');
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    const decision = row.next
      ? '다음 세션 시작'
      : (
          { completed: '세션 완료', failed: '실패', stopped: '중단' } as Record<
            string,
            string
          >
        )[run.summary.status];
    const text = [detail || '생성 문서 ' + run.results.length + '개', decision]
      .filter(Boolean)
      .join(' · ');
    db.prepare('UPDATE session_history SET digest=? WHERE id=?').run(
      text,
      row.id,
    );
    return text;
  }
  function info(id: string) {
    const row = select.get(id) as Row | undefined;
    if (!row) return undefined;
    const end = deadline(row);
    return {
      expiresAt: end === null ? null : new Date(end).toISOString(),
      kept: JSON.parse(row.kept) as string[],
      expired: !!row.expired,
      summary: row.closed === null ? null : summary(row),
    };
  }
  const keep = db.transaction((id: string, name: string) => {
    const row = select.get(id) as Row | undefined;
    if (!row || !store.run(id).results.includes(name))
      throw new StoreNotFound();
    const kept = JSON.parse(row.kept) as string[];
    if (kept.includes(name)) return;
    if (row.expired || (deadline(row) ?? Infinity) <= now())
      throw new StoreConflict();
    db.prepare('UPDATE session_history SET kept=? WHERE id=?').run(
      JSON.stringify([...kept, name]),
      id,
    );
  }).immediate;
  const expire = db.transaction((id: string) => {
    const row = select.get(id) as Row;
    if (row.expired || (deadline(row) ?? Infinity) > now()) return;
    summary(row);
    db.prepare('DELETE FROM session_requests WHERE run=?').run(id);
    const run = store.run(id),
      kept = JSON.parse(row.kept) as string[];
    const snapshot = run.summary.snapshotId;
    const discard = run.results.filter((n) => !kept.includes(n));
    for (const file of discard)
      db.prepare('DELETE FROM review_edits WHERE run=? AND file=?').run(
        id,
        file,
      );
    db.prepare('UPDATE session_history SET expired=1,pending=? WHERE id=?').run(
      JSON.stringify([...discard, 'events.jsonl']),
      id,
    );
    db.prepare(
      `UPDATE runs SET record=json_remove(json_set(record,'$.results',json(?)),'$.retry','$.completedHashes') WHERE id=?`,
    ).run(JSON.stringify(run.results.filter((n) => kept.includes(n))), id);
    if (snapshot)
      db.prepare(
        `DELETE FROM request_snapshots WHERE id=? AND NOT EXISTS (
      SELECT 1 FROM runs r LEFT JOIN session_history h ON h.id=r.id
      WHERE json_extract(r.record,'$.summary.snapshotId')=? AND coalesce(h.expired,0)=0)`,
      ).run(snapshot, snapshot);
  }).immediate;
  function sweep() {
    for (const id of db
      .prepare(
        'SELECT id FROM session_history WHERE closed IS NOT NULL AND digest IS NULL',
      )
      .pluck()
      .all() as string[]) {
      const row = select.get(id) as Row;
      summary(row);
    }
    const candidates = db
      .prepare('SELECT id FROM session_history WHERE expired=0 AND closed<=?')
      .pluck()
      .all(now() - lifetime) as string[];
    for (const id of candidates) expire(id);
    const pending = db
      .prepare(
        'SELECT id,pending FROM session_history WHERE pending IS NOT NULL',
      )
      .all() as { id: string; pending: string }[];
    for (const row of pending) {
      const dir = directory(row.id);
      if (dir)
        for (const name of JSON.parse(row.pending) as string[]) {
          if (
            name !== 'events.jsonl' &&
            !/^[a-z0-9][a-z0-9-]{0,63}\.md$/.test(name)
          )
            throw new StoreConflict();
          rmSync(join(dir, name), { force: true });
        }
      db.prepare('UPDATE session_history SET pending=NULL WHERE id=?').run(
        row.id,
      );
    }
  }
  return {
    info,
    keep,
    release: db.transaction((id: string, name: string, remove: boolean) => {
      const row = select.get(id) as Row | undefined;
      if (!row) throw new StoreNotFound();
      const kept = JSON.parse(row.kept) as string[];
      if (!kept.includes(name)) return;
      if (
        !!row.expired !== remove ||
        (!row.expired && (deadline(row) ?? Infinity) <= now())
      )
        throw new StoreConflict();
      const next = JSON.stringify(kept.filter((n) => n !== name));
      db.prepare('UPDATE session_history SET kept=? WHERE id=?').run(next, id);
      if (remove) {
        db.prepare('DELETE FROM review_edits WHERE run=? AND file=?').run(
          id,
          name,
        );
        db.prepare(
          "UPDATE session_history SET pending=json_insert(coalesce(pending,'[]'),'$[#]',?) WHERE id=?",
        ).run(name, id);
        const remaining = store.run(id).results.filter((n) => n !== name);
        db.prepare(
          "UPDATE runs SET record=json_set(record,'$.results',json(?)) WHERE id=?",
        ).run(JSON.stringify(remaining), id);
      }
    }).immediate,
    sweep,
    list: () =>
      new Map(
        (
          db
            .prepare('SELECT id,digest,expired FROM session_history')
            .all() as Pick<Row, 'id' | 'digest' | 'expired'>[]
        ).map((row) => [row.id, row]),
      ),
    expired: (id: string) => !!(select.get(id) as Row | undefined)?.expired,
  };
}
