import { expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ScheduleConfig, scheduleConfigSchema } from '@studio/contracts';
import { openStudioStore, StoreConflict } from '../src/studio-store.js';
import {
  createScheduler,
  nextScheduleTime,
  ScheduleMaterialError,
} from '../src/scheduler.js';
import type { createRunService } from '../src/run-service.js';

const cfg: ScheduleConfig = {
  version: 1,
  enabled: true,
  time: '09:00',
  weekday: 1,
  material: { kind: 'text', value: '원본' },
};
test('Seoul daily and weekly times advance across midnight and an exact occurrence', () => {
  const now = Date.parse('2026-11-22T23:59:59Z'),
    monday = Date.parse('2026-11-23T00:00:00Z');
  expect(nextScheduleTime(cfg, now)).toBe(monday);
  expect(nextScheduleTime(cfg, monday)).toBe(monday + 7 * 86400000);
  expect(
    nextScheduleTime({ ...cfg, weekday: null, time: '00:00' }, monday),
  ).toBe(Date.parse('2026-11-23T15:00:00Z'));
});
test('pinned version, fresh file, single claim, busy skip, pause and restart persist', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'schedule-test-'));
  const db = new Database(join(folder, 'test.db'));
  const store = openStudioStore(db);
  const start = vi.fn<ReturnType<typeof createRunService>['start']>();
  const s = createScheduler(db, store, { start }, folder);
  try {
    const f = store.createWorkflow({
      name: '문서',
      inputFields: [],
      steps: [
        {
          id: 'draft',
          kind: 'task',
          title: '작성',
          position: { x: 0, y: 0 },
          instructions: '작성해줘',
        },
      ],
      links: [],
    });
    mkdirSync(s.panel(f.id).folder);
    const file = join(s.panel(f.id).folder, '자료.md');
    writeFileSync(file, '지난 자료');
    const config: ScheduleConfig = {
      ...cfg,
      material: { kind: 'file', value: '자료.md' },
    };
    const now = Date.parse('2026-11-22T23:59:59Z');
    const saved = s.save(f.id, null, config, now).schedule!;
    expect(() => s.save(f.id, null, cfg, now)).toThrow(StoreConflict);
    store.updateWorkflow(f.id, 1, { ...f.definition, name: '새 버전' });
    writeFileSync(file, '이번 자료');
    const due = saved.nextAt!;
    await Promise.all([s.tick(due), s.tick(due)]);
    await s.tick(due + 3000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.any(String), f.id, 1, {
      name: '문서 · 예약',
      source: '이번 자료',
    });
    start.mockRejectedValueOnce(new StoreConflict());
    await s.tick(s.panel(f.id).schedule!.nextAt!);
    expect(s.panel(f.id).schedule?.note).toContain('건너뜀');
    const paused = s.save(
      f.id,
      saved.revision,
      { ...config, enabled: false },
      now,
    ).schedule!;
    expect(paused.nextAt).toBeNull();
    expect(() => s.remove(f.id, saved.revision)).toThrow(StoreConflict);
    symlinkSync(file, join(s.panel(f.id).folder, 'link.md'));
    expect(() =>
      s.save(
        f.id,
        paused.revision,
        { ...config, material: { kind: 'file', value: 'link.md' } },
        now,
      ),
    ).toThrow(ScheduleMaterialError);
    expect(
      scheduleConfigSchema.safeParse({
        ...config,
        material: { kind: 'file', value: '../자료.md' },
      }).success,
    ).toBe(false);
    const again = s.save(
      f.id,
      paused.revision,
      config,
      Date.parse('2020-01-01'),
    ).schedule!;
    s.start();
    expect(s.panel(f.id).schedule?.note).toContain('꺼져');
    expect(s.panel(f.id).schedule!.nextAt!).toBeGreaterThan(Date.now());
    expect(start).toHaveBeenCalledTimes(2);
    expect(s.remove(f.id, again.revision).schedule).toBeNull();
  } finally {
    await s.close();
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
test('archive preserves schedule, trash pauses it atomically and restore keeps it paused', async () => {
  const db = new Database(':memory:'),
    store = openStudioStore(db),
    s = createScheduler(db, store, { start: vi.fn() }, tmpdir());
  try {
    const w = store.createWorkflow({
      name: '보관 검증',
      steps: [
        {
          kind: 'task',
          id: 'write',
          title: '작성',
          instructions: '작성',
          position: { x: 0, y: 0 },
        },
      ],
      links: [],
    });
    const before = s.save(w.id, null, cfg).schedule!;
    const pause = () => s.pause(w.id);
    store.move(w.id, 'active', 'archive', pause);
    expect(s.panel(w.id).schedule).toEqual(before);
    expect(() => store.move(w.id, 'active', 'trash', pause)).toThrow(
      StoreConflict,
    );
    store.move(w.id, 'archived', 'trash', pause);
    const after = s.panel(w.id).schedule!;
    expect(after.config.enabled).toBe(false);
    expect(after.nextAt).toBeNull();
    expect(() => s.save(w.id, after.revision, cfg)).toThrow(StoreConflict);
    expect(store.move(w.id, 'trash', 'restore', pause)).toBe('archived');
    expect(s.panel(w.id).schedule).toEqual(after);
    expect(store.workflow(w.id, 1).definition).toEqual(w.definition);
  } finally {
    await s.close();
    db.close();
  }
});
