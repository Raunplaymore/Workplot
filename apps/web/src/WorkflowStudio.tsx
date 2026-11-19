import { useEffect, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type XYPosition,
  type Dimensions,
  type Viewport,
} from '@xyflow/react';
import {
  orderedSteps,
  runViewSchema,
  runEventsSchema,
  runListSchema,
  type RunList,
  workflowDefinitionSchema,
  workflowIdSchema,
  workflowListSchema,
  workflowPlan,
  workflowVersionSchema,
  type RunDecision,
  type RunView,
  type WorkflowDefinition,
  type WorkflowVersion,
} from '@studio/contracts';
import { WorkflowProposal } from './WorkflowProposal';
import styles from './WorkflowStudio.module.css';

type Step = WorkflowDefinition['steps'][number];
const defaultDefinition: WorkflowDefinition = {
  name: '매장 소개 문서',
  input: '가상 자료: 픽셀서점, 샘플로 10, 10:00–18:00, 독립출판물 판매.',
  steps: [
    {
      id: 'draft',
      title: '초안 작성',
      kind: 'task',
      instructions:
        '자료에 근거해 한국어 매장 소개 초안을 마크다운으로 쓰세요.',
      agent: 'codex',
      skill: 'source-check',
      position: { x: 0, y: 90 },
    },
    {
      id: 'review',
      title: '초안 검토',
      kind: 'review',
      position: { x: 240, y: 90 },
    },
    {
      id: 'revision',
      title: '수정본 작성',
      kind: 'task',
      instructions: '초안의 사실을 보존하고 제목과 한 문단으로 정리하세요.',
      agent: 'codex',
      position: { x: 480, y: 90 },
    },
  ],
  links: [
    { from: 'draft', to: 'review' },
    { from: 'review', to: 'revision' },
  ],
};
const blank: WorkflowDefinition = {
  name: '새 작업 흐름',
  input: '',
  steps: [
    {
      id: 'draft',
      kind: 'task',
      title: '초안 작성',
      instructions: '',
      agent: 'codex',
      position: { x: 0, y: 90 },
    },
  ],
  links: [],
};
const activeStatuses = new Set(['queued', 'running', 'waiting']);
const runLabels: Record<RunView['summary']['status'], string> = {
  queued: '실행 준비 중',
  running: '실행 중',
  waiting: '사용자 확인 대기',
  completed: '완료',
  failed: '실패',
  stopped: '중단됨',
  unknown: '종료 상태 미확인',
};
const errorText: Record<string, string> = {
  invalid_proposal:
    'Codex가 유효한 변경안을 만들지 못했습니다. 요청을 구체화해 다시 시도하세요.',
  retry_conflict:
    '재실행 조건이 달라졌습니다. 실행 상태와 이전 결과 문서를 확인하세요.',
  stale_version:
    '다른 변경이 먼저 저장됐습니다. 작업 목록에서 최신 버전을 다시 여세요.',
  login: '터미널에서 Codex의 ChatGPT 로그인을 확인하세요.',
  cli: '로컬 서버가 Codex를 찾지 못했습니다. 설치와 서버 실행 환경을 확인하세요.',
  output: '실행할 작업 단계와 Codex 담당자 설정을 확인하세요.',
  not_found: '기록이나 결과 파일을 찾을 수 없습니다.',
};

async function localRequest(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
) {
  const init: RequestInit = {
    method,
    signal,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  let response = await fetch('/api' + path, init);
  if (response.status === 401) {
    const session = await fetch('/api/session', {
      method: 'POST',
      headers: { 'X-Studio-Client': 'browser' },
    });
    if (!session.ok) throw new Error('로컬 작업실 세션을 열 수 없습니다.');
    response = await fetch('/api' + path, init);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      errorText[data.error] ??
        (response.status === 409
          ? '다른 실행 또는 변경과 충돌했습니다. 현재 상태를 확인하세요.'
          : '로컬 서버 요청을 완료할 수 없습니다.'),
    );
  }
  return response;
}

function chain(steps: Step[]) {
  return steps.flatMap((step, index) => {
    const previous = steps[index - 1];
    return previous ? [{ from: previous.id, to: step.id }] : [];
  });
}
function message(error: unknown) {
  return error instanceof Error ? error.message : '작업을 완료할 수 없습니다.';
}

function WireIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="3" width="7" height="7" rx="1.5" />
      <rect x="15" y="14" width="7" height="7" rx="1.5" />
      <path d="M9 6h6a3 3 0 0 1 3 3v5M5 10v5a3 3 0 0 0 3 3h7" />
    </svg>
  );
}

function routeRun() {
  const parsed = workflowIdSchema.safeParse(
    location.hash.slice('#/runs/'.length),
  );
  return location.hash.startsWith('#/runs/') && parsed.success
    ? parsed.data
    : null;
}

function screen() {
  if (routeRun()) return 'detail';
  return location.hash === '#/design' ? 'design' : 'monitor';
}

export function WorkflowStudio({
  codexAvailable,
  connected,
}: {
  codexAvailable: boolean;
  connected: boolean;
}) {
  const [surface, setSurface] = useState(screen);
  const [proposalMode, setProposalMode] = useState<'create' | 'edit' | null>(
    null,
  );
  const [properties, setProperties] = useState(true);
  const [flowSettings, setFlowSettings] = useState(false);
  const [library, setLibrary] = useState(false);
  const viewport = useRef<Viewport | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [draft, setDraft] = useState(defaultDefinition);
  const [baseline, setBaseline] = useState(defaultDefinition);
  const [saved, setSaved] = useState<WorkflowVersion | null>(null);
  const [history, setHistory] = useState<WorkflowDefinition[]>([]);
  const [list, setList] = useState<ReturnType<typeof workflowListSchema.parse>>(
    [],
  );
  const [selected, select] = useState('draft');
  const [choice, setChoice] = useState('');
  const [run, setRun] = useState<RunView | null>(null);
  const [runId, setRunId] = useState(
    () => routeRun() ?? sessionStorage.getItem('studio-run'),
  );
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const requestedStart = useRef<{ id: string; key: string } | null>(null);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState('');
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(
    null,
  );
  const documentHeading = useRef<HTMLHeadingElement>(null);
  const reviewPrompt = useRef<HTMLElement>(null);
  const stepPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (preview && window.matchMedia('(max-width: 800px)').matches) {
      documentHeading.current?.focus({ preventScroll: true });
      documentHeading.current?.scrollIntoView({ block: 'start' });
    }
  }, [preview]);
  const [previewedGate, setPreviewedGate] = useState('');
  const [nodeSizes, setNodeSizes] = useState<Record<string, Dimensions>>({});
  const [dragging, setDragging] = useState<{
    id: string;
    position: XYPosition;
  } | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const ordered = orderedSteps(draft);
  const joined = ordered.length === draft.steps.length;
  const steps = joined ? ordered : draft.steps;
  const [rows, setRows] = useState<RunList | null>(null);
  const [dashboardError, setDashboardError] = useState('');
  const [filter, setFilter] = useState<'all' | 'waiting' | 'running'>('all');
  useEffect(() => {
    function route() {
      const id = routeRun();
      setError('');
      if (id && id !== runId) {
        setRunId(id);
        sessionStorage.setItem('studio-run', id);
        setRun(null);
        setPreview(null);
        setPreviewedGate('');
        setAnswer('');
      }
      setSurface(screen());
      setLibrary(false);
      titleRef.current?.focus({ preventScroll: true });
    }
    window.addEventListener('hashchange', route);
    return () => window.removeEventListener('hashchange', route);
  }, [runId]);
  const running = (status: RunView['summary']['status']) =>
    status === 'queued' || status === 'running';
  const visibleRows = rows?.filter(
    (row) =>
      filter === 'all' ||
      (filter === 'waiting' ? row.status === 'waiting' : running(row.status)),
  );
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = runListSchema.parse(
          await (await localRequest('/runs')).json(),
        );
        if (!disposed) {
          setRows(result);
          setDashboardError('');
        }
      } catch (error) {
        if (!disposed) setDashboardError(message(error));
      } finally {
        if (!disposed) timer = setTimeout(refresh, 2000);
      }
    }
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [connected, run?.summary.status, run?.summary.id]);
  const step = steps.find((item) => item.id === selected) ?? steps[0];
  const plan = workflowPlan(draft);
  const index = steps.findIndex(({ id }) => id === step?.id);
  const precedingTasks = steps
    .slice(0, index)
    .filter((item) => item.kind === 'task');
  const selectedInputs = step?.kind === 'task' ? step.inputFrom : undefined;
  const invalidInputs =
    selectedInputs?.filter(
      (id) => !precedingTasks.some((item) => item.id === id),
    ) ?? [];
  const titleFor = (id: string) => {
    const item = steps.find((step) => step.id === id);
    return item ? item.title.trim() || '제목 없음' : '삭제된 단계';
  };
  const active = Boolean(run && activeStatuses.has(run.summary.status));
  const checkingRun = runId !== null && run?.summary.id !== runId;
  const reviewReady = !run?.results.length || previewedGate === run.gate?.id;

  async function updateList() {
    setList(
      workflowListSchema.parse(await (await localRequest('/workflows')).json()),
    );
  }
  useEffect(() => {
    if (!connected) return;
    void updateList().catch((error: unknown) => setError(message(error)));
  }, [connected]);
  const observedStatus = rows?.find((row) => row.id === runId)?.status;
  useEffect(() => {
    if (!runId || !connected || busy) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const updated = runViewSchema.parse(
          await (await localRequest('/runs/' + runId + '/view')).json(),
        );
        if (!disposed) {
          setRun(updated);
          if (activeStatuses.has(updated.summary.status))
            timer = setTimeout(refresh, 700);
        }
      } catch (error) {
        if (!disposed) {
          setError(message(error));
          timer = setTimeout(refresh, 2000);
        }
      }
    }
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [runId, connected, busy, observedStatus]);

  function change(next: WorkflowDefinition) {
    setHistory((previous) => [...previous.slice(-29), draft]);
    setDraft(next);
    setError('');
  }
  function reset(
    definition: WorkflowDefinition,
    record: WorkflowVersion | null,
  ) {
    setDraft(definition);
    setBaseline(definition);
    setSaved(record);
    setHistory([]);
    viewport.current = null;
    setFlowSettings(false);
    setProperties(true);
    select(orderedSteps(definition)[0]?.id ?? '');
    setChoice(record?.id ?? '');
    setLibrary(false);
  }
  function replaceStep(next: Step) {
    change({
      ...draft,
      steps: draft.steps.map((item) => (item.id === next.id ? next : item)),
    });
  }
  function changeOrder(next: Step[]) {
    change({ ...draft, steps: next, links: chain(next) });
  }
  function wire(from: string, to: string) {
    if (
      busy ||
      from === to ||
      draft.links.some((link) => link.from === from && link.to === to)
    )
      return;
    const links = draft.links.filter(
      (link) => link.from !== from && link.to !== to,
    );
    let cursor: string | undefined = to;
    while (cursor) {
      if (cursor === from) {
        setError('이 연결은 순환합니다. 기존 연결을 먼저 해제하세요.');
        return;
      }
      cursor = links.find((link) => link.from === cursor)?.to;
    }
    change({ ...draft, links: to ? [...links, { from, to }] : links });
  }
  function openRun(id: string) {
    location.hash = '/runs/' + id;
  }
  function move(offset: number) {
    const index = steps.findIndex((item) => item.id === step?.id);
    const next = [...steps];
    const current = next[index];
    const adjacent = next[index + offset];
    if (!current || !adjacent) return;
    next[index] = adjacent;
    next[index + offset] = current;
    changeOrder(next);
  }
  function add(kind: Step['kind'] | 'ai-review') {
    const after = index + 1;
    const entry = {
      id: 'step-' + crypto.randomUUID(),
      title:
        kind === 'ai-review'
          ? 'AI 검토'
          : kind === 'task'
            ? '새 작업'
            : '사용자 검토',
      position:
        after < steps.length
          ? {
              x: step?.position.x ?? 0,
              y: Math.max(90, ...steps.map((item) => item.position.y)) + 120,
            }
          : {
              x: Math.max(-240, ...steps.map((item) => item.position.x)) + 240,
              y: 90,
            },
    };
    const created: Step =
      kind === 'review'
        ? { ...entry, kind }
        : {
            ...entry,
            kind: 'task',
            instructions:
              kind === 'ai-review'
                ? '원본 자료, 업무 완료 기준, 앞 단계 결과를 비교하세요. 빠지거나 틀린 항목과 수정할 내용을 검토 의견으로 반환하세요.'
                : '',
            agent: 'codex',
          };
    changeOrder([...steps.slice(0, after), created, ...steps.slice(after)]);
    inspect(entry.id);
  }
  function undo() {
    const old = history.at(-1);
    if (!old) return;
    setDraft(old);
    setHistory(history.slice(0, -1));
  }
  function perform(work: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    void work()
      .catch((error: unknown) => setError(message(error)))
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  }
  function save() {
    perform(async () => {
      if (!joined) throw new Error('모든 단계를 하나의 흐름으로 연결하세요.');
      const parsed = workflowDefinitionSchema.safeParse(draft);
      if (!parsed.success) {
        const connection = parsed.error.issues.find(
          (issue) => issue.path.at(-1) === 'inputFrom',
        );
        if (connection) {
          const item = draft.steps[Number(connection.path[1])];
          if (item) inspect(item.id);
          throw new Error(
            '전달받을 문서를 확인하세요. 앞서 실행되는 작업의 결과만 연결할 수 있습니다.',
          );
        }
        throw new Error('흐름 이름과 각 작업 단계의 제목·지침을 입력하세요.');
      }
      const response = saved
        ? await localRequest('/workflows/' + saved.id, 'PUT', {
            baseVersion: saved.version,
            definition: parsed.data,
          })
        : await localRequest('/workflows', 'POST', parsed.data);
      const record = workflowVersionSchema.parse(await response.json());
      setSaved(record);
      setDraft(record.definition);
      setBaseline(record.definition);
      setChoice(record.id);
      await updateList();
    });
  }
  function start() {
    if (!saved) return;
    perform(async () => {
      const key = saved.id + ':' + saved.version;
      const id =
        requestedStart.current?.key === key
          ? requestedStart.current.id
          : crypto.randomUUID();
      requestedStart.current = { id, key };
      const response = await localRequest('/runs', 'POST', {
        id,
        workflowId: saved.id,
        workflowVersion: saved.version,
      });
      setRun(runViewSchema.parse(await response.json()));
      setRunId(id);
      sessionStorage.setItem('studio-run', id);
      openRun(id);
      requestedStart.current = null;
      setPreview(null);
      setAnswer('');
    });
  }
  function decide(decision: RunDecision) {
    perform(async () => {
      setRun(
        runViewSchema.parse(
          await (
            await localRequest('/runs/' + runId + '/decision', 'POST', decision)
          ).json(),
        ),
      );
      setAnswer('');
    });
  }
  function showFile(name: string) {
    perform(async () => {
      const text = await (
        await localRequest(
          '/runs/' + runId + '/results/' + encodeURIComponent(name),
        )
      ).text();
      if (routeRun() !== runId) return;
      setPreview({ name, text });
      if (run?.gate?.kind === 'review' && name === run.results.at(-1))
        setPreviewedGate(run.gate.id);
    });
  }

  const nodes = steps.map((item, index) => ({
    id: item.id,
    data: {
      label: (
        <>
          <small>
            {joined ? String(index + 1).padStart(2, '0') + ' / ' : ''}
            {item.kind === 'review'
              ? '사용자 검토'
              : item.agent === 'codex'
                ? 'Codex'
                : '담당 미지정'}
          </small>
          <strong>{item.title || '제목 없음'}</strong>
          <code>
            {item.kind === 'review' ? '승인 후 계속' : item.id + '.md'}
          </code>
        </>
      ),
    },
    position: dragging?.id === item.id ? dragging.position : item.position,
    measured: nodeSizes[item.id],
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    selected: !flowSettings && item.id === step?.id,
  }));
  const edges = draft.links.map(({ from, to }) => ({
    id: from + ':' + to,
    source: from,
    target: to,
    markerEnd: { type: MarkerType.ArrowClosed },
  }));
  const invalidAgent = steps.some(
    (item) => item.kind === 'task' && item.agent === 'unassigned',
  );
  const button = (label: string, action: () => void, disabled = false) => (
    <button type="button" onClick={action} disabled={disabled}>
      {label}
    </button>
  );

  function openWorkflow(id: string) {
    perform(async () => {
      const record = workflowVersionSchema.parse(
        await (await localRequest('/workflows/' + id)).json(),
      );
      reset(record.definition, record);
      location.hash = '/design';
    });
  }
  function inspect(id: string) {
    select(id);
    setFlowSettings(false);
    setProperties(true);
  }
  return (
    <>
      <nav className={styles.rail} aria-label="작업공간">
        <span className={styles.brand} aria-label="Workplot">
          <WireIcon />
        </span>
        <a
          href="#/runs"
          aria-current={surface !== 'design' ? 'page' : undefined}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 4h6v6H3zM13 5h8M13 9h6M3 14h6v6H3zM13 15h8M13 19h6" />
          </svg>
          실행 현황
        </a>
        <a
          href="#/design"
          aria-current={surface === 'design' ? 'page' : undefined}
        >
          <WireIcon />
          흐름 설계
        </a>
      </nav>
      <main className={styles.workspace}>
        <header className={styles.header}>
          <div className={styles.identity}>
            <small>Workplot</small>
            <h1 tabIndex={-1} ref={titleRef}>
              {surface === 'design'
                ? draft.name || '새 작업 흐름'
                : surface === 'monitor'
                  ? '워크플로 대시보드'
                  : '실행과 결과'}
            </h1>
          </div>
          {surface === 'design' && (
            <>
              <div className={styles.version}>
                {saved ? `저장된 버전 ${saved.version}` : '아직 저장하지 않음'}
                {dirty ? ' · 변경 있음' : ''}
              </div>
              <button
                aria-expanded={library}
                onClick={() => setLibrary(!library)}
              >
                흐름 목록
              </button>{' '}
              <div className={styles.buttons}>
                {button('되돌리기', undo, busy || history.length === 0)}
                {button(
                  '변경 취소',
                  () => reset(baseline, saved),
                  busy || !dirty,
                )}
                <button
                  className={styles.primary}
                  type="button"
                  onClick={save}
                  disabled={!connected || busy || (!!saved && !dirty)}
                >
                  흐름 저장
                </button>
                <button
                  className={styles.primary}
                  type="button"
                  onClick={start}
                  disabled={
                    !connected ||
                    !codexAvailable ||
                    !saved ||
                    dirty ||
                    active ||
                    busy ||
                    invalidAgent ||
                    checkingRun
                  }
                >
                  {saved ? '저장한 버전 실행' : '작업 실행 · 연결 준비 중'}
                </button>
              </div>
            </>
          )}
          {surface === 'detail' && (
            <>
              <span className={styles.version}>실행 {runId?.slice(0, 8)}</span>
              <div className={styles.buttons}>
                {run?.summary.status === 'failed' &&
                  run.failureId &&
                  button(
                    '실패한 단계 다시 실행',
                    () =>
                      perform(async () => {
                        const response = await localRequest(
                          '/runs/' + run.summary.id + '/retry',
                          'POST',
                          { failureId: run.failureId },
                        );
                        setRun(runViewSchema.parse(await response.json()));
                        setPreview(null);
                        setAnswer('');
                        setPreviewedGate('');
                      }),
                    busy || !connected || !codexAvailable,
                  )}
                {active &&
                  button(
                    '작업 중단',
                    () =>
                      perform(async () => {
                        setRun(
                          runViewSchema.parse(
                            await (
                              await localRequest(
                                '/runs/' + runId + '/stop',
                                'POST',
                              )
                            ).json(),
                          ),
                        );
                      }),
                    busy || !connected,
                  )}
              </div>
            </>
          )}
        </header>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {surface === 'monitor' && (
          <>
            <section className={styles.monitor} aria-labelledby="monitor-title">
              <div className={styles.monitorHead}>
                <h2 id="monitor-title">실행 현황</h2>
                <a className={styles.launch} href="#/design">
                  와이어 편집기 열기 →
                </a>
              </div>
              <div className={styles.metrics}>
                {(
                  [
                    ['all', '전체 실행', rows?.length],
                    [
                      'running',
                      '진행 중',
                      rows?.filter((row) => running(row.status)).length,
                    ],
                    [
                      'waiting',
                      '사용자 확인 대기',
                      rows?.filter((row) => row.status === 'waiting').length,
                    ],
                  ] as const
                ).map(([id, label, count]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={filter === id}
                    onClick={() => setFilter(id)}
                  >
                    <span>{label}</span>
                    <strong>
                      {connected && !dashboardError ? (count ?? '—') : '—'}
                    </strong>
                  </button>
                ))}
              </div>
              <h3>실행 목록</h3>
              {!connected || dashboardError || rows === null ? (
                <p>
                  {dashboardError ||
                    (connected
                      ? '실행 기록을 불러오는 중…'
                      : '로컬 서버 연결을 확인하세요.')}
                </p>
              ) : visibleRows?.length ? (
                <div className={styles.runTable}>
                  <table>
                    <thead>
                      <tr>
                        <th>작업 흐름</th>
                        <th>상태</th>
                        <th>시작 시각</th>
                        <th>상세</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <strong>{row.name}</strong>{' '}
                            <small>v{row.workflowVersion}</small>
                          </td>
                          <td>
                            <span
                              className={styles.badge}
                              data-state={row.status}
                            >
                              {runLabels[row.status]}
                            </span>
                          </td>
                          <td>
                            <time dateTime={row.recordedAt}>
                              {new Date(row.recordedAt).toLocaleString('ko-KR')}
                            </time>
                          </td>
                          <td>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => openRun(row.id)}
                            >
                              {row.status === 'waiting'
                                ? '검토 열기'
                                : row.status === 'failed'
                                  ? '실패 상세 열기'
                                  : '결과 열기'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>
                  {filter === 'all'
                    ? '아직 실행 기록이 없습니다. 와이어 편집기에서 첫 흐름을 저장하고 실행하세요.'
                    : '해당 상태의 실행이 없습니다.'}
                </p>
              )}
            </section>
          </>
        )}
        {surface === 'design' && (
          <>
            {library && (
              <div className={styles.library}>
                {button('새 흐름', () => reset(blank, null), busy || dirty)}
                {button(
                  '목표로 새 흐름 만들기',
                  () => setProposalMode('create'),
                  busy || dirty || !connected || !codexAvailable,
                )}
                <label>
                  저장한 흐름
                  <select
                    value={choice}
                    onChange={(event) => setChoice(event.target.value)}
                    disabled={busy}
                  >
                    <option value="">선택하세요</option>
                    {list.map((record) => (
                      <option value={record.id} key={record.id}>
                        {record.name} · v{record.version}
                      </option>
                    ))}
                  </select>
                </label>
                {button(
                  '흐름 열기',
                  () => openWorkflow(choice),
                  !choice || dirty || busy,
                )}
              </div>
            )}
            <section
              className={styles.editor}
              data-panel={properties}
              aria-label="와이어 편집기"
            >
              <div className={styles.canvas}>
                <div className={styles.canvasTitle}>
                  <div>
                    <small>흐름 설계</small>
                    <h2>와이어 편집기</h2>
                  </div>
                  <button
                    disabled={
                      busy ||
                      !connected ||
                      !codexAvailable ||
                      !workflowDefinitionSchema.safeParse(draft).success
                    }
                    onClick={() => setProposalMode('edit')}
                  >
                    말로 흐름 수정
                  </button>
                  {proposalMode && (
                    <WorkflowProposal
                      base={proposalMode === 'edit' ? draft : null}
                      close={() => setProposalMode(null)}
                      propose={async (request, signal, clarifications) =>
                        (
                          await localRequest(
                            '/workflow-proposals',
                            'POST',
                            {
                              request,
                              ...(proposalMode === 'create'
                                ? { mode: 'create' }
                                : { definition: draft }),
                              ...(clarifications.length && { clarifications }),
                            },
                            signal,
                          )
                        ).json()
                      }
                      apply={(next) => {
                        if (proposalMode === 'create') {
                          reset(blank, null);
                          setDraft(next);
                          select(orderedSteps(next)[0]!.id);
                          setError('');
                        } else change(next);
                        setProposalMode(null);
                      }}
                    />
                  )}
                  <button
                    onClick={() => setProperties(!properties)}
                    aria-expanded={properties}
                  >
                    {properties ? '속성 접기' : '속성 열기'}
                  </button>
                </div>
                {!joined && (
                  <strong>
                    연결되지 않은 흐름 · 모든 단계를 한 줄로 연결하세요.
                  </strong>
                )}
                <div className={styles.graph} aria-label="작업 흐름 노드">
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={(changes) => {
                      for (const change of changes) {
                        if (change.type !== 'dimensions' || !change.dimensions)
                          continue;
                        const { id, dimensions } = change;
                        setNodeSizes((sizes) => {
                          const prior = sizes[id];
                          return prior?.width === dimensions.width &&
                            prior.height === dimensions.height
                            ? sizes
                            : { ...sizes, [id]: dimensions };
                        });
                      }
                    }}
                    nodesConnectable={!busy}
                    onConnect={({ source, target }) => wire(source, target)}
                    nodesFocusable={false}
                    deleteKeyCode={null}
                    defaultViewport={viewport.current ?? undefined}
                    onMoveEnd={(_event, next) => {
                      viewport.current = next;
                    }}
                    fitView={!viewport.current}
                    fitViewOptions={{ maxZoom: 1.25, padding: 0.18 }}
                    minZoom={0.2}
                    onNodeClick={(_event, node) => inspect(node.id)}
                    onPaneClick={() => {
                      setProperties(true);
                      setFlowSettings(true);
                    }}
                    onNodeDrag={(_event, node) =>
                      setDragging({ id: node.id, position: node.position })
                    }
                    onNodeDragStop={(_event, node) => {
                      setDragging(null);
                      const item = steps.find(({ id }) => id === node.id);
                      if (
                        item &&
                        (item.position.x !== node.position.x ||
                          item.position.y !== node.position.y)
                      )
                        replaceStep({ ...item, position: node.position });
                    }}
                    nodesDraggable={!busy}
                  >
                    <Background color="#acbcb0" gap={24} />
                    <Controls showInteractive={false} />
                  </ReactFlow>
                </div>
                <div className={styles.mobileSteps} aria-label="작업 순서">
                  {steps.map((item, i) => (
                    <button
                      key={item.id}
                      aria-pressed={!flowSettings && item.id === step?.id}
                      onClick={() => {
                        inspect(item.id);
                        stepPanel.current?.scrollTo({ top: 0 });
                      }}
                    >
                      {i + 1}. {item.title || '제목 없음'}
                    </button>
                  ))}
                </div>{' '}
                <details className={styles.plan}>
                  <summary>업무 설계서</summary>
                  <div className={styles.planBody}>
                    <label>
                      업무 목표
                      <textarea
                        value={draft.goal ?? ''}
                        rows={2}
                        maxLength={1000}
                        disabled={busy}
                        onChange={(event) =>
                          change({ ...draft, goal: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      완료 기준
                      <textarea
                        value={draft.doneWhen ?? ''}
                        rows={2}
                        maxLength={2000}
                        disabled={busy}
                        onChange={(event) =>
                          change({ ...draft, doneWhen: event.target.value })
                        }
                      />
                    </label>
                    {!joined ? (
                      <p>
                        단계를 모두 연결하면 실행 순서와 문서 전달 경로가
                        표시됩니다.
                      </p>
                    ) : (
                      <ol aria-label="단계별 결과 전달">
                        {plan.steps.map((item) => (
                          <li key={item.id}>
                            <strong>{item.title || '제목 없음'}</strong>
                            <p>
                              {item.kind === 'task'
                                ? '입력: 원본 자료'
                                : '검토: 사용자 승인'}
                              {item.inputs.length > 0 &&
                                ' · ' + item.inputs.map(titleFor).join(', ')}
                              {item.output && ' → ' + item.output}
                            </p>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </details>
              </div>
              {properties && (
                <aside ref={stepPanel} className={styles.inspector}>
                  <div className={styles.switches}>
                    <button
                      aria-pressed={!flowSettings}
                      onClick={() => setFlowSettings(false)}
                    >
                      단계 속성
                    </button>
                    <button
                      aria-pressed={flowSettings}
                      onClick={() => setFlowSettings(true)}
                    >
                      흐름 설정
                    </button>
                  </div>{' '}
                  <fieldset className={styles.settings} disabled={busy}>
                    <legend>
                      {flowSettings ? '흐름 정보' : step?.title || '단계 속성'}
                    </legend>
                    {flowSettings && (
                      <>
                        <label>
                          흐름 이름
                          <input
                            value={draft.name}
                            maxLength={100}
                            onChange={(event) =>
                              change({ ...draft, name: event.target.value })
                            }
                          />
                        </label>
                        <label>
                          입력 자료
                          <textarea
                            value={draft.input ?? ''}
                            maxLength={8000}
                            rows={3}
                            onChange={(event) =>
                              change({ ...draft, input: event.target.value })
                            }
                          />
                        </label>
                      </>
                    )}
                    <label>
                      편집할 단계
                      <select
                        value={step?.id ?? ''}
                        onChange={(event) => inspect(event.target.value)}
                      >
                        {steps.map((item, i) => (
                          <option value={item.id} key={item.id}>
                            {joined ? i + 1 + '. ' : ''}
                            {item.title || '제목 없음'}
                          </option>
                        ))}
                      </select>
                    </label>
                    {step && !flowSettings && (
                      <>
                        <label>
                          단계 제목
                          <input
                            value={step.title}
                            maxLength={100}
                            onChange={(event) =>
                              replaceStep({
                                ...step,
                                title: event.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          다음 단계 연결
                          <select
                            value={
                              draft.links.find((link) => link.from === step.id)
                                ?.to ?? ''
                            }
                            onChange={(event) =>
                              wire(step.id, event.target.value)
                            }
                          >
                            <option value="">연결 없음</option>
                            {steps
                              .filter((item) => item.id !== step.id)
                              .map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.title || '제목 없음'}
                                </option>
                              ))}
                          </select>
                        </label>
                        {step.kind === 'task' && (
                          <>
                            <details className={styles.inputs}>
                              <summary>전달받을 문서</summary>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={selectedInputs === undefined}
                                  onChange={(event) =>
                                    replaceStep({
                                      ...step,
                                      inputFrom: event.target.checked
                                        ? undefined
                                        : (plan.steps[index]?.inputs ?? []),
                                    })
                                  }
                                />
                                직전 작업 문서 자동 연결
                              </label>
                              {selectedInputs !== undefined &&
                                [
                                  ...precedingTasks.map((item) => item.id),
                                  ...invalidInputs,
                                ].map((id) => (
                                  <label key={id}>
                                    <input
                                      type="checkbox"
                                      checked={selectedInputs.includes(id)}
                                      disabled={
                                        !selectedInputs.includes(id) &&
                                        selectedInputs.length >= 4
                                      }
                                      onChange={(event) =>
                                        replaceStep({
                                          ...step,
                                          inputFrom: event.target.checked
                                            ? [...selectedInputs, id]
                                            : selectedInputs.filter(
                                                (source) => source !== id,
                                              ),
                                        })
                                      }
                                    />
                                    {titleFor(id)}
                                    {invalidInputs.includes(id)
                                      ? ' · 연결할 수 없음'
                                      : ''}
                                  </label>
                                ))}
                            </details>
                            {invalidInputs.length > 0 && (
                              <p className={styles.error}>
                                전달받을 문서에 앞서 실행되지 않는 단계가
                                있습니다.
                              </p>
                            )}
                            <label>
                              작업 지침
                              <textarea
                                value={step.instructions}
                                rows={3}
                                maxLength={8000}
                                onChange={(event) =>
                                  replaceStep({
                                    ...step,
                                    instructions: event.target.value,
                                  })
                                }
                              />
                            </label>
                            <label>
                              담당 도구
                              <select
                                value={step.agent ?? 'codex'}
                                onChange={(event) =>
                                  replaceStep({
                                    ...step,
                                    agent:
                                      event.target.value === 'codex'
                                        ? 'codex'
                                        : 'unassigned',
                                  })
                                }
                              >
                                <option value="codex">
                                  Codex{codexAvailable ? '' : ' · 설치 미확인'}
                                </option>
                                <option value="unassigned">미지정</option>
                                <option disabled>
                                  Claude Code · 실행 미연결
                                </option>
                              </select>
                            </label>
                            <label>
                              작업 스킬
                              <select
                                value={step.skill ?? 'none'}
                                onChange={(event) =>
                                  replaceStep({
                                    ...step,
                                    skill:
                                      event.target.value === 'source-check'
                                        ? 'source-check'
                                        : 'none',
                                  })
                                }
                              >
                                <option value="none">없음</option>
                                <option value="source-check">
                                  자료 사실 확인
                                </option>
                              </select>
                            </label>
                            <p>
                              문서 작성 모드 · 명령, 브라우저, 외부 도구 사용 안
                              함
                            </p>
                          </>
                        )}
                        <div className={styles.buttons}>
                          {button(
                            '앞으로 이동',
                            () => move(-1),
                            !joined || index < 1,
                          )}
                          {button(
                            '뒤로 이동',
                            () => move(1),
                            !joined || index >= steps.length - 1,
                          )}
                          {button(
                            '단계 삭제',
                            () =>
                              changeOrder(
                                steps.filter((item) => item.id !== step.id),
                              ),
                            !joined || steps.length < 2,
                          )}
                        </div>
                      </>
                    )}
                    <div className={styles.buttons}>
                      {button(
                        '작업 단계 추가',
                        () => add('task'),
                        !joined || steps.length >= 32,
                      )}
                      {button(
                        'AI 검토 추가',
                        () => add('ai-review'),
                        !joined || steps.length >= 32,
                      )}
                      {button(
                        '사용자 검토 추가',
                        () => add('review'),
                        !joined || steps.length >= 32,
                      )}
                    </div>
                    <p>선택한 단계 뒤에 새 단계를 추가합니다.</p>
                  </fieldset>
                </aside>
              )}
            </section>
          </>
        )}
        {surface === 'detail' && (
          <section className={styles.execution} aria-label="실행 상세">
            {preview && run?.gate?.kind === 'review' && (
              <div className={styles.readingBar}>
                <span>{preview.name}</span>
                <button
                  type="button"
                  onClick={() => {
                    reviewPrompt.current?.focus({ preventScroll: true });
                    reviewPrompt.current?.scrollIntoView({ block: 'start' });
                  }}
                >
                  검토로 이동
                </button>
              </div>
            )}
            <div className={styles.paper}>
              <div className={styles.docTitle}>
                <small>실행 결과</small>
                <h2 ref={documentHeading} tabIndex={-1}>
                  {preview?.name ||
                    (run?.gate?.kind === 'review' ? '문서 검토' : '결과 문서')}
                </h2>
              </div>
              {run?.results.length ? (
                <ul className={styles.files}>
                  {run.results.map((name) => (
                    <li key={name}>
                      {button(name, () => showFile(name), busy)}
                    </li>
                  ))}
                </ul>
              ) : null}
              {preview && (
                <div className={styles.result}>
                  <strong>{preview.name}</strong>
                  <pre>{preview.text}</pre>
                </div>
              )}

              {!preview && (
                <p className={styles.fileHint}>
                  {run?.results.length
                    ? '문서를 선택하면 이곳에서 내용을 읽을 수 있습니다.'
                    : '생성된 문서가 여기에 표시됩니다.'}
                </p>
              )}
            </div>
            <aside className={styles.inspector}>
              <small>실행 상세</small>
              <h2>
                {rows?.find((row) => row.id === runId)?.name ?? '작업 흐름'}
              </h2>{' '}
              <p aria-live="polite">
                {run
                  ? `버전 ${run.summary.workflowVersion} · ${runLabels[run.summary.status]}`
                  : checkingRun
                    ? '실행 기록을 불러오는 중…'
                    : '선택한 실행이 없습니다.'}
                {run?.summary.status === 'failed' && run.stepId
                  ? ` · 실패 단계 ${run.stepId}`
                  : ''}
                {run?.note ? ` · ${run.note}` : ''}
              </p>
              {run?.gate && (
                <div className={styles.gate}>
                  <strong ref={reviewPrompt} tabIndex={-1}>
                    {run.gate.kind === 'review'
                      ? '검토 후 계속할까요?'
                      : 'Codex가 확인을 요청했습니다'}
                  </strong>
                  <p>{run.gate.text}</p>
                  {run.gate.kind === 'review' ? (
                    <div className={styles.buttons}>
                      {run.results.length > 0 &&
                        button(
                          '검토할 문서 열기',
                          () => showFile(run.results.at(-1)!),
                          busy,
                        )}
                      {button(
                        '승인하고 계속',
                        () =>
                          decide({ gateId: run.gate!.id, decision: 'accept' }),
                        busy || !connected || !reviewReady,
                      )}
                      {button(
                        '거절',
                        () =>
                          decide({ gateId: run.gate!.id, decision: 'decline' }),
                        busy || !connected,
                      )}
                    </div>
                  ) : (
                    <>
                      <label>
                        질문에 답하기
                        <textarea
                          value={answer}
                          maxLength={4000}
                          onChange={(event) => setAnswer(event.target.value)}
                        />
                      </label>
                      {button(
                        '답변 보내기',
                        () =>
                          decide({
                            gateId: run.gate!.id,
                            decision: 'answer',
                            answer,
                          }),
                        busy || !connected || !answer.trim(),
                      )}
                    </>
                  )}
                </div>
              )}
              <RunHistory key={runId} run={run} />
              {run && (
                <div className={styles.buttons}>
                  {button(
                    '저장 흐름 편집',
                    () => openWorkflow(run.summary.workflowId),
                    busy || dirty || !connected,
                  )}
                  {dirty && (
                    <p>편집 중인 흐름의 변경 사항을 먼저 저장하세요.</p>
                  )}
                </div>
              )}
              {checkingRun && error && (
                <a
                  href="#/runs"
                  onClick={() => {
                    sessionStorage.removeItem('studio-run');
                    setRunId(null);
                    setRun(null);
                  }}
                >
                  실행 현황으로 돌아가기
                </a>
              )}
            </aside>
          </section>
        )}
      </main>
    </>
  );
}

function RunHistory({ run }: { run: RunView | null }) {
  const [record, setRecord] = useState<WorkflowVersion | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<
    ReturnType<typeof runEventsSchema.parse>
  >([]);
  const [logError, setLogError] = useState('');
  const workflowId = run?.summary.workflowId,
    version = run?.summary.workflowVersion;
  const id = run?.summary.id,
    status = run?.summary.status,
    step = run?.stepId;
  useEffect(() => {
    if (!workflowId || !version) return;
    let disposed = false;
    void localRequest('/workflows/' + workflowId + '/versions/' + version)
      .then((response) => response.json())
      .then((data) => workflowVersionSchema.parse(data))
      .then((data) => {
        if (!disposed) setRecord(data);
      })
      .catch(() => {
        if (!disposed) setRecord(null);
      });
    return () => {
      disposed = true;
    };
  }, [workflowId, version]);
  useEffect(() => {
    if (!id || !expanded) return;
    let disposed = false;
    void localRequest('/runs/' + id + '/events')
      .then((response) => response.json())
      .then((data) => runEventsSchema.parse(data))
      .then((data) => {
        if (!disposed) {
          setEvents(data);
          setLogError('');
        }
      })
      .catch(() => {
        if (!disposed) setLogError('실행 로그를 읽을 수 없습니다.');
      });
    return () => {
      disposed = true;
    };
  }, [id, expanded, status, step]);
  if (!run) return null;
  const steps = record ? orderedSteps(record.definition) : [];
  return (
    <>
      <h3>실행 순서 · v{version}</h3>
      <ol className={styles.sequence}>
        {steps.map((item) => (
          <li
            key={item.id}
            aria-current={item.id === step ? 'step' : undefined}
          >
            {item.title}
          </li>
        ))}
      </ol>
      <details onToggle={(e) => setExpanded(e.currentTarget.open)}>
        <summary>실행 로그</summary>
        {logError ? (
          <p>{logError}</p>
        ) : (
          <ol className={styles.log} aria-label="최근 실행 이벤트">
            {events.map((event, i) => (
              <li key={i}>
                <time>{new Date(event.at).toLocaleTimeString('ko-KR')}</time>{' '}
                {steps.find((s) => s.id === event.stepId)?.title ??
                  event.stepId}{' '}
                · {runLabels[event.status]}
              </li>
            ))}
          </ol>
        )}
      </details>
    </>
  );
}
