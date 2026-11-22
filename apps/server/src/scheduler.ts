import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  missingInputFields,
  requiredInputFields,
  scheduleConfigSchema,
  type ScheduleConfig,
  type SchedulePanel,
} from '@studio/contracts';
import type { createRunService } from './run-service.js';
import { StoreConflict, type StudioStore } from './studio-store.js';
import { RunnerError } from './codex-runner.js';

const minute = 60_000,
  day = 24 * 60 * minute,
  koreaOffset = 9 * 60 * minute;
export function nextScheduleTime(config: ScheduleConfig, now: number) {
  const local = new Date(now + koreaOffset);
  const [hour, min] = config.time.split(':').map(Number);
  let next =
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate(),
      hour,
      min,
    ) - koreaOffset;
  if (config.weekday !== null)
    next += ((config.weekday - local.getUTCDay() + 7) % 7) * day;
  if (next <= now) next += config.weekday === null ? day : 7 * day;
  return next;
}
export class ScheduleMaterialError extends Error {}
type Row = {
  id: string;
  revision: string;
  config: string;
  nextAt: number | null;
  lastAt: number | null;
  note: string | null;
  runId: string | null;
};

function sourceText(config: ScheduleConfig, folder: string) {
  if (config.material.kind === 'text') return config.material.value;
  try {
    if (!lstatSync(folder).isDirectory()) throw Error();
    const fd = openSync(
      join(folder, config.material.value),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 32000) throw Error();
      const buffer = Buffer.alloc(32001);
      let size = 0;
      while (size < buffer.length) {
        const n = readSync(fd, buffer, size, buffer.length - size, null);
        if (!n) break;
        size += n;
      }
      const value = new TextDecoder('utf-8', { fatal: true })
        .decode(buffer.subarray(0, size))
        .trim();
      if (!value || value.length > 8000 || size > 32000) throw Error();
      return value;
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new ScheduleMaterialError(
      '지정한 UTF-8 자료 파일(최대 8,000자)을 확인하세요.',
    );
  }
}

export function createScheduler(
  db: Database.Database,
  store: StudioStore,
  runs: Pick<ReturnType<typeof createRunService>, 'start'>,
  directory: string,
) {
  const folder = join(directory, 'schedule-inputs');

  db.exec(`CREATE TABLE IF NOT EXISTS workflow_schedules(id TEXT PRIMARY KEY, revision TEXT NOT NULL,config TEXT NOT NULL,nextAt INTEGER,lastAt INTEGER,note TEXT,runId TEXT) STRICT;
 CREATE INDEX IF NOT EXISTS workflow_schedules_due ON workflow_schedules(nextAt) WHERE nextAt IS NOT NULL;`);
  const row = (id: string) =>
    db.prepare('SELECT * FROM workflow_schedules WHERE id=?').get(id) as
      Row | undefined;
  function panel(id: string): SchedulePanel {
    const r = row(id);
    return {
      folder,
      schedule: r
        ? {
            revision: r.revision,
            config: scheduleConfigSchema.parse(JSON.parse(r.config)),
            nextAt: r.nextAt,
            lastAt: r.lastAt,
            note: r.note,
            runId:
              r.runId &&
              db.prepare('SELECT 1 FROM runs WHERE id=?').get(r.runId)
                ? r.runId
                : null,
          }
        : null,
    };
  }
  function material(id: string, config: ScheduleConfig) {
    const flow = store.workflow(id, config.version);
    const source = sourceText(config, folder);
    if (missingInputFields(requiredInputFields(flow.definition), source).length)
      throw new ScheduleMaterialError('필수 자료가 빠졌습니다.');
    return { name: (flow.definition.name + ' · 예약').slice(0, 100), source };
  }
  const save = db.transaction(
    (
      id: string,
      expected: string | null,
      config: ScheduleConfig,
      now = Date.now(),
    ) => {
      if ((row(id)?.revision ?? null) !== expected) throw new StoreConflict();
      store.allowUse(id);
      store.workflow(id, config.version);
      if (config.enabled) material(id, config);
      db.prepare(
        `INSERT INTO workflow_schedules(id,revision,config,nextAt) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config=excluded.config,nextAt=excluded.nextAt`,
      ).run(
        id,
        randomUUID(),
        JSON.stringify(config),
        config.enabled ? nextScheduleTime(config, now) : null,
      );
      return panel(id);
    },
  );
  function remove(id: string, revision: string) {
    if (
      !db
        .prepare('DELETE FROM workflow_schedules WHERE id=? AND revision=?')
        .run(id, revision).changes
    )
      throw new StoreConflict();
    return panel(id);
  }
  const due = db.prepare(
    'SELECT * FROM workflow_schedules WHERE nextAt<=? ORDER BY nextAt,id',
  );
  const claim = db.prepare(
    'UPDATE workflow_schedules SET nextAt=?,lastAt=?,note=?,runId=? WHERE id=? AND revision=? AND nextAt=?',
  );
  const finish = db.prepare(
    'UPDATE workflow_schedules SET note=? WHERE id=? AND lastAt=? AND runId=?',
  );
  let timer: NodeJS.Timeout | undefined,
    inFlight: Promise<void> | undefined,
    closed = false;
  async function dispatch(now: number) {
    for (const r of due.all(now) as Row[]) {
      if (closed || r.nextAt === null) break;
      const config = scheduleConfigSchema.parse(JSON.parse(r.config));
      const expired = now - r.nextAt >= minute;
      const runId = randomUUID();
      if (
        !claim.run(
          nextScheduleTime(config, now),
          r.nextAt,
          expired ? '서버가 준비되지 않아 건너뜀' : '시작 요청',
          expired ? null : runId,
          r.id,
          r.revision,
          r.nextAt,
        ).changes ||
        expired
      )
        continue;
      let note = '실행 시작';
      try {
        await runs.start(runId, r.id, config.version, material(r.id, config));
      } catch (e) {
        note =
          e instanceof StoreConflict
            ? '기존 작업이 진행 중이어서 건너뜀'
            : e instanceof ScheduleMaterialError
              ? e.message
              : e instanceof RunnerError
                ? 'Codex 시작 실패 · ' + e.reason
                : '예약 실행 실패';
      }
      finish.run(note, r.id, r.nextAt, runId);
    }
  }
  function tick(now = Date.now()) {
    return (inFlight ??= dispatch(now).finally(() => {
      inFlight = undefined;
    }));
  }
  return {
    pause(id: string) {
      const r = row(id);
      if (!r) return;
      const config = scheduleConfigSchema.parse(JSON.parse(r.config));
      if (config.enabled)
        db.prepare(
          'UPDATE workflow_schedules SET revision=?,config=?,nextAt=NULL,note=? WHERE id=?',
        ).run(
          randomUUID(),
          JSON.stringify({ ...config, enabled: false }),
          '휴지통 이동으로 예약 정지',
          id,
        );
    },
    panel,
    save: save.immediate,
    remove,
    tick,
    start() {
      mkdirSync(folder, { mode: 0o700, recursive: true });
      db.prepare(
        "UPDATE workflow_schedules SET note='시작 상태 미확인 · 다시 실행하지 않음' WHERE note='시작 요청' AND runId NOT IN (SELECT id FROM runs)",
      ).run();
      const now = Date.now();
      for (const r of due.all(now) as Row[]) {
        const config = scheduleConfigSchema.parse(JSON.parse(r.config));
        claim.run(
          nextScheduleTime(config, now),
          r.nextAt,
          '서버가 꺼져 있어 건너뜀',
          null,
          r.id,
          r.revision,
          r.nextAt,
        );
      }
      timer = setInterval(() => {
        void tick().catch((e) => console.error('Workplot 예약 확인 실패', e));
      }, 2000);
      timer.unref();
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
