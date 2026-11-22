import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { workflowDefinitionSchema } from '@studio/contracts';
import { createSessionHistory } from '../src/session-history.js';
import { openStudioStore } from '../src/studio-store.js';

test('retains a complete loop through review, then prunes only unkept details after thirty days, including legacy grace across restarts', () => {
  const root = mkdtempSync(join(tmpdir(), 'workplot-history-')),
    db = new Database(':memory:');
  try {
    const store = openStudioStore(db);
    const def = workflowDefinitionSchema.parse(
      JSON.parse(
        readFileSync(
          new URL(
            '../../../examples/workplot-improvement.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    );
    const wf = store.createWorkflow(def),
      ordinary = store.createWorkflow({
        ...def,
        steps: def.steps.slice(0, 1),
        links: [],
      });
    const names = ['change-evidence.md', 'next-plan.md'];
    function seed(workflowId: string, status: 'waiting' | 'completed') {
      const run = store.recordRun({
        workflowId,
        workflowVersion: 1,
        cliVersion: '1.0.0',
        status,
        results: names,
        sessionId: null,
        process: null,
      });
      const dir = join(root, 'runs', run.id);
      mkdirSync(dir, { recursive: true });
      for (const n of [...names, 'events.jsonl'])
        writeFileSync(join(dir, n), '# 검증\n탐색 개선\n실제 검사: 통과');
      return run.id;
    }
    const day = 86400000,
      rollout = Date.now();
    let time = rollout;
    const legacy = seed(wf.id, 'completed'),
      keepNormal = seed(ordinary.id, 'completed');
    let history = createSessionHistory(db, store, root, () => time);
    const parent = seed(wf.id, 'waiting');
    const child = store.recordNextSession(parent, '검증 자료', () => {
      store.updateRun(parent, {
        status: 'completed',
        results: names,
        sessionId: null,
        process: null,
      });
    });
    store.updateRun(child.id, {
      status: 'waiting',
      results: [],
      sessionId: null,
      process: null,
    });
    expect(history.info(parent)?.expiresAt).toBeNull();
    history.keep(parent, 'next-plan.md');
    history.keep(parent, 'next-plan.md');
    expect(history.info(parent)?.kept).toEqual(['next-plan.md']);
    time = rollout + 30 * day - 1;
    history = createSessionHistory(db, store, root, () => time);
    history.sweep();
    const file = (id: string, name: string) => join(root, 'runs', id, name);
    expect(existsSync(file(legacy, 'events.jsonl'))).toBe(true);
    time += 1;
    history.sweep();
    expect(store.run(legacy).results).toEqual([]);
    expect(existsSync(file(legacy, 'events.jsonl'))).toBe(false);
    expect(existsSync(file(parent, 'events.jsonl'))).toBe(true);
    expect(history.info(keepNormal)).toBeUndefined();
    expect(existsSync(file(keepNormal, 'next-plan.md'))).toBe(true);
    store.updateRun(child.id, {
      status: 'completed',
      results: [],
      sessionId: null,
      process: null,
    });
    // The test clock advances independently of SQLite's real-time status trigger.
    db.prepare('UPDATE session_history SET closed=? WHERE id=?').run(
      time,
      child.id,
    );
    expect(history.info(parent)?.expiresAt).toEqual(
      new Date(time + 30 * day).toISOString(),
    );
    time += 30 * day - 1;
    history.sweep();
    expect(store.run(parent).results).toEqual(names);
    time++;
    history.sweep();
    history.sweep();
    expect(store.run(parent).results).toEqual(['next-plan.md']);
    expect(readFileSync(file(parent, 'next-plan.md'), 'utf8')).toContain(
      '검증',
    );
    expect(existsSync(file(parent, 'change-evidence.md'))).toBe(false);
    expect(existsSync(file(parent, 'events.jsonl'))).toBe(false);
    expect(history.info(parent)).toMatchObject({
      expired: true,
      summary: '탐색 개선 · 실제 검사: 통과 · 다음 세션 시작',
    });
    expect(() => history.release(parent, 'next-plan.md', false)).toThrow();
    history.release(parent, 'next-plan.md', true);
    history.sweep();
    expect(existsSync(file(parent, 'next-plan.md'))).toBe(false);
    expect(history.info(parent)?.summary).toContain('탐색 개선');
    expect(store.workflow(wf.id, 1).definition).toEqual(def);
    expect(() => history.keep(parent, 'change-evidence.md')).toThrow();
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
