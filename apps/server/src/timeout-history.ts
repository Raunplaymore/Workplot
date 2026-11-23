import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export type CommandCheck = {
  key: string;
  label: string;
  status: '진행 중' | '통과' | '실패' | '결과 미확인';
};
export function commandCheck(line: string): CommandCheck | undefined {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const item = event?.item;
  if (
    item?.type !== 'command_execution' ||
    typeof item.command !== 'string' ||
    !['item.started', 'item.completed'].includes(event.type)
  )
    return;
  // Store only a known check label and an opaque command identity. Arguments can contain user data.
  // A shell sequence, pipeline or echo can return success without a passing check.
  const raw = item.command.trim();
  const command = (
    raw.match(/^(?:\/[\w/-]+\/)?(?:bash|zsh|sh)\s+-l?c\s+(['"])(.+)\1$/)?.[2] ??
    raw
  ).trim();
  if (/[;&|$<>\x60\n]/.test(command)) return;
  const match = command.match(
    /^(?:npm\s+(?:run\s+)?(typecheck|lint|build|test:e2e|test|qa:host-isolation)|(?:npx\s+)?(playwright\s+test|vitest|tsc))(?=\s|$)/,
  );
  if (!match) return;
  const status =
    event.type === 'item.started'
      ? '진행 중'
      : typeof item.exit_code !== 'number'
        ? '결과 미확인'
        : item.exit_code === 0
          ? '통과'
          : '실패';
  return {
    key: createHash('sha256').update(item.command).digest('hex'),
    label: match[1] ?? match[2]!,
    status,
  };
}
export type Attempt = {
  begin: number;
  end: number | null;
  outcome: string | null;
  parallel: number | null;
  checks: string | null;
};
type OldEvent = {
  at: string;
  status: string;
  stepId: string | null;
  results?: string[];
  failureReason?: string;
};
export function previousAttempts(events: OldEvent[], step: string): Attempt[] {
  const attempts: Attempt[] = [];
  let attempt: Attempt | undefined;
  for (const e of events) {
    if (e.stepId !== step) {
      attempt = undefined;
      continue;
    }
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) continue;
    if (e.status === 'queued') {
      attempt = undefined;
      continue;
    }
    if (
      e.status === 'running' &&
      !attempt &&
      !e.results?.includes(step + '.md')
    ) {
      attempt = {
        begin: at,
        end: null,
        outcome: null,
        checks: null,
        parallel: null,
      };
      attempts.push(attempt);
    }
    if (
      attempt &&
      !attempt.end &&
      (e.status === 'failed' || e.results?.includes(step + '.md'))
    ) {
      attempt.end = at;
      attempt.outcome =
        e.status === 'failed'
          ? e.failureReason === 'Codex 응답 제한 시간에 도달했습니다.'
            ? 'timeout'
            : 'failed'
          : 'done';
    }
  }
  return attempts;
}
export function openTimeoutHistory(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS step_attempts(
    id INTEGER PRIMARY KEY, run TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, step TEXT NOT NULL,
    begin INTEGER NOT NULL, end INTEGER, outcome TEXT, parallel INTEGER NOT NULL, checks TEXT NOT NULL DEFAULT '[]');
    CREATE INDEX IF NOT EXISTS step_attempt_by_run ON step_attempts(run,step,id);
    CREATE INDEX IF NOT EXISTS timeout_by_step ON step_attempts(step,end) WHERE outcome='timeout';`);
  const insert = db.prepare(
    'INSERT INTO step_attempts(run,step,begin,parallel) VALUES(?,?,?,?)',
  );
  const finish = db.prepare(
    'UPDATE step_attempts SET end=?,outcome=? WHERE id=? AND end IS NULL',
  );
  const save = db.prepare('UPDATE step_attempts SET checks=? WHERE id=?');
  return {
    start(run: string, step: string, parallel: number) {
      return Number(
        insert.run(run, step, Date.now(), parallel).lastInsertRowid,
      );
    },
    save(id: number, checks: CommandCheck[]) {
      save.run(JSON.stringify(checks), id);
    },
    finish(id: number, outcome: string) {
      finish.run(Date.now(), outcome, id);
    },
    attempts(run: string, step: string) {
      return db
        .prepare(
          'SELECT begin,end,outcome,parallel,checks FROM step_attempts WHERE run=? AND step=? ORDER BY id',
        )
        .all(run, step) as Attempt[];
    },
    steps(run: string) {
      return db
        .prepare(
          "SELECT step FROM step_attempts WHERE run=? AND outcome='timeout' UNION SELECT step FROM failure_monitor WHERE source=?",
        )
        .pluck()
        .all(run, run) as string[];
    },
    peers(step: string) {
      return db
        .prepare(
          "SELECT DISTINCT run FROM (SELECT run FROM step_attempts WHERE step=? AND outcome='timeout' ORDER BY end DESC LIMIT 20) UNION SELECT source FROM (SELECT source FROM failure_monitor WHERE step=? ORDER BY rowid DESC LIMIT 20)",
        )
        .pluck()
        .all(step, step) as string[];
    },
  };
}
export function describeTimeouts(attempts: Attempt[]) {
  return attempts.flatMap((a, index) => {
    if (a.outcome !== 'timeout' || a.end === null) return [];
    const retry = attempts[index + 1];
    const done = attempts.slice(index + 1).find((r) => r.outcome === 'done');
    const checks: CommandCheck[] | null =
      a.checks === null ? null : JSON.parse(a.checks);
    const later: CommandCheck[] | null = retry?.checks
      ? JSON.parse(retry.checks)
      : null;
    const completed = new Set(
      checks?.filter((c) => c.status === '통과').map((c) => c.key),
    );
    return [
      {
        begin: a.begin,
        end: a.end,
        elapsedMs: a.end - a.begin,
        parallel: a.parallel,
        lastCheck: checks?.at(-1)
          ? checks.at(-1)!.label + ' · ' + checks.at(-1)!.status
          : null,
        recoveredMs: done?.end ? done.end - a.end : null,
        retryMs: retry?.end ? retry.end - retry.begin : null,
        repeatedChecks:
          checks && later
            ? later.filter((c) => completed.has(c.key)).length
            : null,
      },
    ];
  });
}
