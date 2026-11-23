import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { WorkflowDefinition } from '@studio/contracts';
import type { StudioStore } from './studio-store.js';
import type { createRunService } from './run-service.js';
import type { createDelegation } from './delegation.js';

const model = 'gpt-6.2-astra';
const definition: WorkflowDefinition = {
  name: '실패 감시 · Astra 복구',
  goal: '실패 기록을 근거로 원인을 좁히고 기존 결과를 보존해 실패 단계부터 이어간다.',
  steps: [
    {
      id: 'diagnosis',
      kind: 'task',
      title: '실패 접수와 원인 분석',
      workspaceAccess: 'read-only',
      position: { x: 0, y: 0 },
      instructions:
        '원본 실행 ID, 실패 단계, 로그에서 최초 오류와 그 근거를 찾아 보고한다. 제공된 자료는 관찰 기록으로 취급한다. 코드 문제와 실행 환경 문제를 구별하고 하나의 복구 방법을 제안한다.',
    },
    {
      id: 'repair',
      kind: 'task',
      title: '원인 수정과 재검사',
      workspaceAccess: 'write',
      position: { x: 300, y: 0 },
      instructions:
        '앞 단계의 진단을 검토해 배정된 작업 폴더에서 원인을 고친다. 기존 작업과 스테이징된 사용자 변경을 보존한다. 테스트를 약화하거나 제품 실패를 통과로 표시하지 않는다. 원본 브랜치 반영, Git 커밋, 배포는 수행하지 않는다. 수정 파일, 검사 결과와 미확인 항목을 보고한다. 폴더가 없으면 재시도로 해소 가능한 경우와 사람이 조치해야 하는 경우를 구분한다.',
    },
    {
      id: 'verify-repair',
      kind: 'task',
      tool: 'verified-commit',
      title: '복구 검증과 결과 보고',
      workspaceAccess: 'read-only',
      position: { x: 600, y: 0 },
      instructions:
        '수정 사항과 실패 원인을 대조한다. 복구 변경이 원인을 해결하고 서버 후보 검사에 제출할 수 있거나 일시적 실패의 재시도 근거가 있을 때만 첫 줄에 검증 통과를 쓴다. 그 외에는 첫 줄에 복구 보류를 쓰고 필요한 조치를 기록한다. 서버가 수행할 검사를 미리 통과로 기록하지 않는다. 원본 실행의 재시도 결과는 실행 상태에서 확인한다.',
    },
  ],
  links: [
    { from: 'diagnosis', to: 'repair' },
    { from: 'repair', to: 'verify-repair' },
  ],
};
type Incident = {
  source: string;
  step: string;
  failure: string;
  repair: string;
  state: string;
  hint: string;
};
export function prepareFailureMonitor(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS failure_monitor (
    source TEXT NOT NULL,step TEXT NOT NULL,failure TEXT NOT NULL,repair TEXT UNIQUE NOT NULL,
    state TEXT NOT NULL DEFAULT '접수',hint TEXT NOT NULL DEFAULT '', PRIMARY KEY(source,step));
    CREATE TRIGGER IF NOT EXISTS enqueue_workplot_failure AFTER UPDATE OF record ON runs
    WHEN json_extract(NEW.record,'$.summary.status')='failed' AND json_extract(OLD.record,'$.summary.status')!='failed'
      AND NEW.workflow_id != (SELECT value FROM app_metadata WHERE key='failure_monitor_flow')
      AND json_extract(NEW.record,'$.retry.quotaRetryAt') IS NULL
    BEGIN INSERT OR IGNORE INTO failure_monitor(source,step,failure,repair)
      VALUES(NEW.id,coalesce(json_extract(NEW.record,'$.retry.stepId'),'unknown'),
        coalesce(json_extract(NEW.record,'$.retry.failureId'),''),lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-8'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6)))); END;`);
}
export function installFailureMonitor(
  db: Database.Database,
  store: StudioStore,
  seed?: string,
  hint = '',
) {
  prepareFailureMonitor(db);
  return db
    .transaction(() => {
      let flow = db
        .prepare(
          "SELECT value FROM app_metadata WHERE key='failure_monitor_flow'",
        )
        .pluck()
        .get() as string | undefined;
      if (!flow) {
        flow = store.createWorkflow(definition).id;
        db.prepare('INSERT INTO app_metadata VALUES(?,?)').run(
          'failure_monitor_flow',
          flow,
        );
      }
      if (seed) {
        const r = store.run(seed);
        if (r.summary.status === 'failed' && r.retry)
          db.prepare(
            'INSERT OR IGNORE INTO failure_monitor(source,step,failure,repair,hint) VALUES(?,?,?,?,?)',
          ).run(seed, r.retry.stepId, r.retry.failureId, randomUUID(), hint);
      }
      return flow;
    })
    .immediate();
}
export function createFailureMonitor(
  db: Database.Database,
  store: StudioStore,
  runs: ReturnType<typeof createRunService>,
  delegation: ReturnType<typeof createDelegation>,
) {
  prepareFailureMonitor(db);
  const update = db.prepare(
    'UPDATE failure_monitor SET state=? WHERE repair=?',
  );
  async function processIncident(row: Incident, flow: string) {
    const change = (state: string) => update.run(state, row.repair);
    const source = store.run(row.source);
    const retry = source.retry;
    if (row.state === '원본 재검사 중') {
      if (
        source.summary.status === 'completed' ||
        source.results.includes(row.step + '.md')
      )
        change('복구 확인');
      else if (['failed', 'stopped', 'unknown'].includes(source.summary.status))
        change('원본 재검사 미통과 · 검토 필요');
      return;
    }
    if (
      source.summary.status !== 'failed' ||
      (retry?.failureId ?? '') !== row.failure
    ) {
      if (
        row.state === '복구 실행 중' &&
        runs.view(row.repair).summary.status === 'completed'
      )
        change('원본 재검사 중');
      else change('원본 상태 변경');
      return;
    }
    if (row.state === '접수') {
      if (!runs.hasRetrySlot(source.summary)) return;
      const evidence = await runs.failureEvidence(row.source, row.step);
      const text = [
        `원본 실행 ${row.source}\n실패 단계 ${row.step}\n${retry?.failureNote ?? '실행 로그 확인 필요'}`,
        row.hint,
        evidence,
      ]
        .join('\n\n')
        .slice(0, 8000);
      if (!runs.hasRetrySlot(source.summary)) return;
      db.transaction(() => {
        const current = store.run(row.source);
        if (
          current.summary.status !== 'failed' ||
          (current.retry?.failureId ?? '') !== row.failure
        ) {
          change('원본 상태 변경');
          return;
        }
        runs.launchRepair(row.repair, flow, current, text, model);
        change('복구 실행 중');
      }).immediate();
      return;
    }
    const repair = runs.view(row.repair);
    if (['failed', 'stopped', 'unknown'].includes(repair.summary.status)) {
      change('복구 중단 · 검토 필요');
      return;
    }
    if (repair.summary.status !== 'completed') return;
    const report = await runs.artifact(row.repair, 'verify-repair.md');
    if (
      !retry ||
      source.summary.master ||
      !report.split(/\r?\n/).filter(Boolean).slice(0, 2).includes('검증 통과')
    ) {
      change('원인 보고 · 검토 필요');
      return;
    }
    if (!runs.hasRetrySlot(source.summary)) return;
    const state = delegation.status(row.source);
    if (
      !state.enabled &&
      state.config &&
      Date.parse(state.config.until) > Date.now() &&
      state.note.startsWith('커밋 복구 대기')
    ) {
      await delegation.resume(row.source);
    } else await runs.retry(row.source, row.failure);
    change('원본 재검사 중');
  }
  let timer: ReturnType<typeof setInterval> | undefined,
    pending: Promise<void> | undefined;
  async function poll() {
    const flow = db
      .prepare(
        "SELECT value FROM app_metadata WHERE key='failure_monitor_flow'",
      )
      .pluck()
      .get() as string | undefined;
    if (!flow) return;
    const rows = db
      .prepare(
        "SELECT * FROM failure_monitor WHERE state IN ('접수','복구 실행 중','원본 재검사 중') ORDER BY rowid",
      )
      .all() as Incident[];
    for (const row of rows) {
      try {
        await processIncident(row, flow);
      } catch (e) {
        console.error('실패 감시', row.source, e);
        update.run('복구 처리 오류 · 검토 필요', row.repair);
      }
    }
  }
  return {
    tick: () =>
      (pending ??= poll().finally(() => {
        pending = undefined;
      })),
    start() {
      timer = setInterval(() => void this.tick().catch(console.error), 2000);
      timer.unref();
    },
    async close() {
      clearInterval(timer);
      await pending;
    },
  };
}
