import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, GitBranch, GitMerge } from 'lucide-react';
import {
  workflowIdSchema,
  type MasterPlan,
  type RunView,
  type RunList,
} from '@studio/contracts';
import { localRequest } from './local-request';
import styles from './MasterRun.module.css';

export function routeMaster() {
  const match = /^#\/masters\/([^/]+)$/.exec(location.hash);
  return match && workflowIdSchema.safeParse(match[1]).success
    ? match[1]!
    : null;
}
export function MasterLinks({ rows }: { rows: RunList }) {
  const groups = new Map<string, string[]>();
  for (const row of rows)
    if (row.masterRunId) {
      const names = groups.get(row.masterRunId) ?? [];
      if (!names.includes(row.name)) names.push(row.name);
      groups.set(row.masterRunId, names);
    }
  if (!groups.size) return null;
  return (
    <section>
      <h3>마스터 실행</h3>
      <ul className={styles.links}>
        {[...groups].map(([id, names]) => (
          <li key={id}>
            <a href={'#/masters/' + id}>
              <GitBranch size={15} /> {names.join(' · ')}{' '}
              <small>{id.slice(0, 8)}</small>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
type Report = {
  status: string;
  files?: string[];
  reason?: string;
  branch?: string;
  verifiedStage?: string;
};
type Master = {
  id: string;
  plan: MasterPlan;
  integrating: boolean;
  stopped: boolean;
  hasUiIntegration: boolean;
  children: { runId: string; taskId: string; view: RunView }[];
  integration: Report | null;
};
const states: Record<RunView['summary']['status'], string> = {
  queued: '시작 대기',
  running: '실행 중',
  waiting: '사용자 확인 대기',
  failed: '실패',
  stopped: '중단',
  completed: '완료',
  unknown: '상태 미확인',
};
const reports: Record<string, string> = {
  verified: '검증 통과',
  failed: '검증 실패',
  conflict: '파일 충돌',
  unchanged: '변경 없음',
};
function RunAction({
  path,
  body,
  label,
  refresh,
}: {
  path: string;
  body?: { failureId: string };
  label: string;
  refresh: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function retry() {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await localRequest(path, 'POST', body);
    } catch (e) {
      setError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다.');
    } finally {
      setPending(false);
      refresh();
    }
  }
  return (
    <>
      <button type="button" disabled={pending} onClick={() => void retry()}>
        {pending ? '처리 중…' : label}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
export function MasterRun({ id }: { id: string }) {
  const [data, setData] = useState<Master | null>(null),
    [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [shot, setShot] = useState('1440-document.png');
  useEffect(() => {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const result = await (
          await localRequest('/master-runs/' + id, 'GET', undefined, ac.signal)
        ).json();
        if (!ac.signal.aborted) {
          setData(result);
          setError('');
        }
      } catch (e) {
        if (!ac.signal.aborted)
          setError(e instanceof Error ? e.message : '조회 실패');
      } finally {
        if (!ac.signal.aborted) timer = setTimeout(read, 2000);
      }
    }
    void read();
    return () => {
      ac.abort();
      clearTimeout(timer);
    };
  }, [id, refreshKey]);
  const report = data?.integration;
  const complete = data?.children.every(
    (c) => c.view.summary.status === 'completed',
  );
  const active = (s: RunView['summary']['status']) =>
    ['queued', 'waiting', 'running'].includes(s);
  const hasActive = data?.children.some((c) => active(c.view.summary.status));
  const halted = data?.children.some(
    (c) => c.view.summary.status === 'stopped',
  );
  const unknown = data?.children.some(
    (c) => c.view.summary.status === 'unknown',
  );
  const refresh = () => setRefreshKey((n) => n + 1);
  const status = data?.stopped
    ? unknown
      ? '종료 상태 미확인'
      : hasActive || data.integrating
        ? '전체 중단 중'
        : '전체 중단됨'
    : halted
      ? hasActive
        ? '일부 작업 중단 · 나머지 진행 중'
        : '일부 작업 중단'
      : data?.integrating
        ? '통합 검사 중'
        : report
          ? (reports[report.status] ?? report.status)
          : complete
            ? data?.hasUiIntegration
              ? '통합 대기'
              : '문서 작업 완료'
            : '가지 완료 대기';
  return (
    <section className={styles.page} aria-label="마스터 실행 상세">
      <a href="#/runs">
        <ArrowLeft size={15} /> 실행 현황
      </a>
      {error && <p role="alert">{error}</p>}
      {data ? (
        <>
          <h2>{data.plan.goal}</h2>
          {!data.stopped &&
            (hasActive ||
              data.integrating ||
              data.children.some((c) => c.view.failureId)) && (
              <RunAction
                path={'/master-runs/' + id + '/stop'}
                label="전체 작업 중단"
                refresh={refresh}
              />
            )}
          <div className={styles.wire} aria-label="병렬 실행 와이어">
            <div className={styles.endpoint}>
              <GitBranch aria-hidden="true" /> 병렬 시작
            </div>
            <ul className={styles.branches}>
              {data.children.map((child) => {
                const task = data.plan.tasks.find((t) => t.id === child.taskId);
                return (
                  <li key={child.runId}>
                    <a className={styles.node} href={'#/runs/' + child.runId}>
                      <strong>{task?.documents.output ?? child.taskId}</strong>
                      <span>
                        {child.taskId} · {states[child.view.summary.status]}
                      </span>
                      <small>{task?.doneWhen}</small>
                      <ArrowUpRight size={15} aria-hidden="true" />
                    </a>
                    {!data.stopped && active(child.view.summary.status) && (
                      <RunAction
                        path={'/runs/' + child.runId + '/stop'}
                        label="이 작업만 중단"
                        refresh={refresh}
                      />
                    )}
                    {!data.stopped &&
                      child.view.summary.status === 'failed' &&
                      child.view.failureId && (
                        <RunAction
                          key={child.view.failureId}
                          path={'/runs/' + child.runId + '/retry'}
                          label="이 작업만 다시 실행"
                          body={{ failureId: child.view.failureId }}
                          refresh={() => setRefreshKey((n) => n + 1)}
                        />
                      )}
                  </li>
                );
              })}
            </ul>
            <div className={styles.endpoint}>
              <GitMerge aria-hidden="true" /> {status}
            </div>
          </div>
          {report && (
            <section className={styles.report}>
              <h3>통합 결과</h3>
              <strong>
                {reports[report.status] ?? report.status}
                {report.branch && ' · ' + report.branch}
              </strong>
              {report.reason && <p>{report.reason}</p>}
              {!!report.files?.length && (
                <>
                  <h4>
                    {report.status === 'conflict' ? '충돌 파일' : '변경 파일'}
                  </h4>
                  <ul>
                    {report.files.map((f) => (
                      <li key={f}>
                        <code>{f}</code>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {report.verifiedStage && (
                <details>
                  <summary>마지막 통과본 보기</summary>
                  <p>작업본 위치</p>
                  <code>{report.verifiedStage}</code>
                  <label>
                    검증 화면{' '}
                    <select
                      value={shot}
                      onChange={(e) => setShot(e.target.value)}
                    >
                      {[
                        '1440-document',
                        '390-document',
                        '1440-editor',
                        '390-editor',
                        '1440-dashboard',
                        '390-dashboard',
                        '1920-layout',
                      ].map((x) => (
                        <option key={x} value={x + '.png'}>
                          {x}
                        </option>
                      ))}
                    </select>
                  </label>
                  <img
                    alt="마지막 통과본의 브라우저 검증 화면"
                    src={
                      '/api/master-runs/' + id + '/verified-captures/' + shot
                    }
                  />
                </details>
              )}
            </section>
          )}
        </>
      ) : (
        !error && <p>실행 불러오는 중…</p>
      )}
    </section>
  );
}
