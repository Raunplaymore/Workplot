import { StepProperties } from './StepProperties';
import { ApprovalChanges } from './ApprovalChanges';
import { ActiveSessionCard } from './ActiveSessionCard';
import { GitRun, GitRunInfo } from './GitRun';
import { NodeInstructions } from './NodeInstructions';
import { LinkedInstructions } from './LinkedInstructions';
import { documentSourceLabel, type DocumentSource } from './document-source';
import { DesignDocument } from './DesignDocument';
import { MasterRun, MasterLinks, routeMaster } from './MasterRun';
import { RunWireComparison, useSavedVersion } from './RunWireComparison';
import { SessionTrail, sessionHeadline } from './SessionTrail';
import { EvidenceCaptures } from './EvidenceCaptures';
import { MarkdownDocument } from './MarkdownDocument';
import { RunDivider } from './RunDivider';
import { storeMaterialDraft, emptyMaterialDraft } from './material-draft';
import { SessionRequests } from './SessionRequests';
import { AutoSession } from './AutoSession';
import { ActionMenu, anchorMenu, type MenuPosition } from './ActionMenu';
import { recoveryKey, readEditorRecovery } from './editor-recovery';
import { NodeShelf } from './NodeShelf';
import { WorkflowLibrary, MaterialDialog } from './WorkflowLibrary';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Columns2,
  FilePlus,
  FolderOpen,
  ListTree,
  PanelRight,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Scissors,
  Settings2,
  SlidersHorizontal,
  Square,
  Trash2,
  Undo2,
  UserCheck,
  Workflow,
} from 'lucide-react';
import { DocumentComparison } from './DocumentComparison';
import { LocalRequestError, localRequest } from './local-request';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type XYPosition,
  type Dimensions,
  type Viewport,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  orderedSteps,
  insertWorkflowStep,
  removeWorkflowStep,
  runViewSchema,
  runEventsSchema,
  timeoutReportSchema,
  runListSchema,
  slotSettingsSchema,
  portCheckSchema,
  MAX_DEVELOPMENT_SLOTS,
  type RunList,
  type RunMaterial,
  type RequestFiles,
  requiredInputFields,
  workflowDefinitionSchema,
  workflowIdSchema,
  workflowListSchema,
  workflowPlan,
  workflowVersionSchema,
  missingInputFields,
  type RunDecision,
  effortLevels,
  type ModelSettings,
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
const runPageSizes = [30, 50, 100] as const;
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
const waitingRunLabels = {
  question: { status: '답변 대기', action: '질문 열기' },
  review: { status: '승인 대기', action: '검토 열기' },
  unspecified: { status: runLabels.waiting, action: '대기 단계 열기' },
};
function chain(steps: Step[]) {
  return steps.flatMap((step, index) => {
    const previous = steps[index - 1];
    return previous ? [{ from: previous.id, to: step.id }] : [];
  });
}
function message(error: unknown) {
  return error instanceof Error ? error.message : '작업을 완료할 수 없습니다.';
}

function instructionPreview(instructions: string) {
  const text = instructions.trim().replace(/\s+/g, ' ');
  if (!text) return '작업 지침 없음';
  const firstSentence = text.split(/(?<=[.!?。！？])\s/, 1)[0]!;
  return firstSentence.length > 80
    ? firstSentence.slice(0, 80).trimEnd() + '…'
    : firstSentence;
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
    location.hash
      .slice('#/runs/'.length)
      .replace(/\/(?:compare|review|log)$/, ''),
  );
  return location.hash.startsWith('#/runs/') && parsed.success
    ? parsed.data
    : null;
}

function designTarget() {
  return location.hash.startsWith('#/design/')
    ? location.hash.slice('#/design/'.length).split('?')[0]
    : null;
}
function designUrl(id?: string) {
  return id ? '#/design/' + id : '#/design';
}
type DocumentRoute = {
  workflow: string;
  step: string;
  version: number;
  run?: string;
};
function readDocumentRoute(): DocumentRoute | null {
  const workflow = designTarget();
  const params = new URLSearchParams(location.hash.split('?')[1]);
  const step = params.get('node');
  const version = Number(params.get('version'));
  if (!workflow || !step || !Number.isSafeInteger(version) || version < 1)
    return null;
  return { workflow, step, version, run: params.get('run') ?? undefined };
}
function documentUrl(route: DocumentRoute) {
  const params = new URLSearchParams({
    node: route.step,
    version: String(route.version),
  });
  if (route.run) params.set('run', route.run);
  return designUrl(route.workflow) + '?' + params;
}
function screen() {
  if (routeMaster()) return 'master';
  if (routeRun())
    return location.hash.endsWith('/compare') ? 'compare' : 'detail';
  if (location.hash === '#/library' || location.hash.startsWith('#/library/'))
    return 'library';
  return location.hash === '#/design' || designTarget() !== null
    ? 'design'
    : 'monitor';
}

export function WorkflowStudio({
  codexAvailable,
  connected,
  onShowTools,
}: {
  codexAvailable: boolean;
  connected: boolean;
  onShowTools: () => void;
}) {
  const [initial] = useState(() => readEditorRecovery(designTarget()));
  const [restored, setRestored] = useState(Boolean(initial));
  const [storageFailed, setStorageFailed] = useState(false);
  const [surface, setSurface] = useState(screen);
  const [target, setTarget] = useState(designTarget);
  const [routeProblem, setRouteProblem] = useState('');
  const [routeAttempt, retryRoute] = useState(0);
  const [masterId, setMasterId] = useState(routeMaster);
  const [logRoute, setLogRoute] = useState(() =>
    location.hash.endsWith('/log'),
  );
  const [proposalMode, setProposalMode] = useState<'create' | 'guided' | null>(
    null,
  );
  const [selectedWire, setSelectedWire] = useState('');
  const [editSession, setEditSession] = useState(0);
  const [newKind, setNewKind] = useState<Step['kind'] | 'ai-review' | 'shelf'>(
    'task',
  );
  const [properties, setProperties] = useState(true);
  const [flowSettings, setFlowSettings] = useState(
    initial?.flowSettings ?? false,
  );
  const [materialRequest, setMaterialRequest] = useState<string>();
  const [materialFiles, setMaterialFiles] = useState<RequestFiles>();
  function prepareMaterial(
    v: WorkflowVersion,
    request?: string,
    files?: RequestFiles,
  ) {
    setMaterialFiles(files);
    setMaterialRequest(request);
    setMaterialVersion(v);
  }
  const [materialVersion, setMaterialVersion] =
    useState<WorkflowVersion | null>(null);
  const [library, setLibrary] = useState(false);
  const flow = useRef<Pick<
    ReactFlowInstance,
    'getViewport' | 'setViewport'
  > | null>(null);
  const graph = useRef<HTMLDivElement>(null);
  const reveal = useRef<string | null>(null);
  const [canvasSession, setCanvasSession] = useState(0);
  const viewport = useRef<Viewport | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [wireMenu, setWireMenu] = useState<{
    id: string;
    position: MenuPosition;
  } | null>(null);
  const [shelf, setShelf] = useState<'save' | 'browse' | null>(null);
  const [draft, setDraft] = useState<WorkflowDefinition>(
    initial?.draft ?? defaultDefinition,
  );
  const [baseline, setBaseline] = useState<WorkflowDefinition>(
    initial?.baseline ?? defaultDefinition,
  );
  const [saved, setSaved] = useState<WorkflowVersion | null>(
    initial?.saved ?? null,
  );
  const [history, setHistory] = useState<
    { definition: WorkflowDefinition; selection: string; wire: string }[]
  >([]);
  const [list, setList] = useState<ReturnType<typeof workflowListSchema.parse>>(
    [],
  );
  const [selected, select] = useState(initial?.selected ?? 'draft');
  const [choice, setChoice] = useState(initial?.saved?.id ?? '');
  const [run, setRun] = useState<RunView | null>(null);
  const { record, executionSteps } = useRunDefinition(
    surface === 'detail' ? run : null,
  );
  const [runId, setRunId] = useState(
    () => routeRun() ?? sessionStorage.getItem('studio-run'),
  );
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const requestedStart = useRef<{ id: string; key: string } | null>(null);
  const [error, setError] = useState('');
  const [handoffFlow, setHandoffFlow] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<ModelSettings['effort']>();
  const modelControl = (
    <details>
      <summary>AI 실행 설정</summary>
      <label>
        모델{' '}
        <input
          value={model}
          placeholder="자동"
          maxLength={96}
          onChange={(e) => setModel(e.target.value)}
        />
      </label>{' '}
      <label>
        추론 강도{' '}
        <select
          value={effort ?? ''}
          onChange={(e) =>
            setEffort(effortLevels.find((v) => v === e.target.value))
          }
        >
          <option value="">자동</option>
          {effortLevels.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
    </details>
  );
  const [starting, setStarting] = useState(false);
  const [answer, setAnswer] = useState('');
  const [preview, setPreview] = useState<{
    name: string;
    text: string;
    focusOnMobile?: boolean;
    evidenceQuote?: string;
  } | null>(null);
  const documentHeading = useRef<HTMLHeadingElement>(null);
  const reviewPrompt = useRef<HTMLElement>(null);
  const stepPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (
      preview?.focusOnMobile &&
      window.matchMedia('(max-width: 800px)').matches
    ) {
      documentHeading.current?.focus({ preventScroll: true });
      documentHeading.current?.scrollIntoView({ block: 'start' });
    }
  }, [preview]);
  const [editing, setEditing] = useState<{
    gate: string;
    rule?: string;
    original: string;
    text: string;
  }>();
  const [previewedGate, setPreviewedGate] = useState('');
  const [nodeSizes, setNodeSizes] = useState<Record<string, Dimensions>>({});
  const [dragging, setDragging] = useState<{
    id: string;
    position: XYPosition;
  } | null>(null);
  useEffect(() => {
    const id = reveal.current;
    const container = graph.current;
    if (!id || !flow.current || !container) return;
    if (!container.clientWidth) {
      reveal.current = null;
      return;
    }
    const node = draft.steps.find((s) => s.id === id);
    const size = nodeSizes[id];
    if (!node || !size) return;
    reveal.current = null;
    const { x, y, zoom } = flow.current.getViewport();
    const pan = (start: number, length: number, limit: number) => {
      const end = start + length * zoom;
      return Math.max(0, 16 - start) || Math.min(0, limit - 16 - end);
    };
    const dx = pan(
      node.position.x * zoom + x,
      size.width,
      container.clientWidth,
    );
    const dy = pan(
      node.position.y * zoom + y,
      size.height,
      container.clientHeight,
    );
    if (dx || dy) void flow.current.setViewport({ x: x + dx, y: y + dy, zoom });
  }, [draft, nodeSizes]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  useLayoutEffect(() => {
    if (designTarget() && designTarget() !== saved?.id) return;
    try {
      if (dirty)
        sessionStorage.setItem(
          recoveryKey(saved?.id),
          JSON.stringify({ draft, baseline, saved, selected, flowSettings }),
        );
      else {
        sessionStorage.removeItem(recoveryKey(saved?.id));
        setRestored(false);
      }
      setStorageFailed(false);
    } catch {
      setStorageFailed(dirty);
      if (dirty) {
        const warn = (event: BeforeUnloadEvent) => {
          event.preventDefault();
          event.returnValue = true;
        };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
      }
    }
  }, [draft, baseline, saved, selected, flowSettings, dirty]);
  const ordered = orderedSteps(draft);
  const joined = ordered.length === draft.steps.length;
  const steps = joined ? ordered : draft.steps;
  const [slotSettings, setSlotSettings] = useState<ReturnType<
    typeof slotSettingsSchema.parse
  > | null>(null);
  const [slotInput, setSlotInput] = useState('');
  const [slotIssue, setSlotIssue] = useState('');
  const [savingSlots, setSavingSlots] = useState(false);
  async function saveSlotLimit(limit: number) {
    setSavingSlots(true);
    try {
      const response = await localRequest('/development-slots', 'PUT', {
        limit,
      });
      setSlotSettings(slotSettingsSchema.parse(await response.json()));
      setSlotInput('');
      setSlotIssue('');
    } catch (e) {
      setSlotIssue(message(e));
    } finally {
      setSavingSlots(false);
    }
  }
  const [rows, setRows] = useState<RunList | null>(null);
  const [pageSize, setPageSize] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem('workplot.runList.pageSize'));
      return runPageSizes.find((size) => size === saved) ?? runPageSizes[0];
    } catch {
      return runPageSizes[0];
    }
  });
  const [requestedPage, setPage] = useState(1);
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
      setMaterialVersion(null);
      setGitPrep(null);
      setLogRoute(location.hash.endsWith('/log'));
      setMasterId(routeMaster());
      setTarget(designTarget());
      setDocumentRequest(readDocumentRoute());
      setRouteProblem('');
      setSurface(screen());
      setProposalMode(null);
      setLibrary(false);
      titleRef.current?.focus({ preventScroll: true });
    }
    window.addEventListener('hashchange', route);
    return () => window.removeEventListener('hashchange', route);
  }, [runId]);
  const running = (status: RunView['summary']['status']) =>
    status === 'queued' || status === 'running';
  const byId = new Map(rows?.map((row) => [row.id, row]));
  const parentIds = new Set(rows?.map((row) => row.previousSessionId));
  const latestRows = rows?.filter((row) => !parentIds.has(row.id));
  function earlierSessions(row: RunList[number]) {
    const chain: RunList = [];
    const seen = new Set([row.id]);
    let parent = row.previousSessionId;
    while (parent && !seen.has(parent)) {
      const previous = byId.get(parent);
      if (!previous) break;
      chain.push(previous);
      seen.add(parent);
      parent = previous.previousSessionId;
    }
    return chain;
  }
  const visibleRows = latestRows?.filter(
    (row) =>
      filter === 'all' ||
      (filter === 'waiting'
        ? row.status === 'waiting' || !!row.quotaRetryAt
        : running(row.status)),
  );
  const pageCount = Math.max(
    1,
    Math.ceil((visibleRows?.length ?? 0) / pageSize),
  );
  const currentPage = Math.min(requestedPage, pageCount);
  const offset = (currentPage - 1) * pageSize;
  const pageRows = visibleRows?.slice(offset, offset + pageSize) ?? [];
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const [result, settings] = await Promise.all([
          localRequest('/runs')
            .then((r) => r.json())
            .then((v) => runListSchema.parse(v)),
          localRequest('/development-slots')
            .then((r) => r.json())
            .then((v) => slotSettingsSchema.parse(v))
            .catch(() => null),
        ]);
        if (!disposed) {
          setRows(result);
          setSlotSettings(settings);
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
  const link = step?.kind === 'task' ? step.workflowRef : undefined;
  const [documentRequest, setDocumentRequest] = useState(readDocumentRoute);
  function openDocument(route: DocumentRoute) {
    window.history.pushState(null, '', documentUrl(route));
    setDocumentRequest(route);
  }
  useEffect(() => {
    if (documentRequest && documentRequest.workflow === saved?.id)
      inspect(documentRequest.step);
  }, [documentRequest?.step, documentRequest?.workflow, saved?.id]);
  const [linkedRecord, setLinkedRecord] = useState<WorkflowVersion | null>(
    null,
  );
  useEffect(() => {
    setLinkedRecord(null);
    if (!link) return;
    const cancel = new AbortController();
    void localRequest(
      '/workflows/' + link.id + '/versions/' + link.version,
      'GET',
      undefined,
      cancel.signal,
    )
      .then((r) => r.json())
      .then((value) => {
        if (!cancel.signal.aborted)
          setLinkedRecord(workflowVersionSchema.parse(value));
      })
      .catch((e) => {
        if (!cancel.signal.aborted) setError(message(e));
      });
    return () => cancel.abort();
  }, [link?.id, link?.version]);
  const plan = workflowPlan(draft);
  const index = steps.findIndex(({ id }) => id === step?.id);
  const canDeleteStep = joined && steps.length >= 2;
  const previousStep = steps[index - 1];
  const nextStep = steps[index + 1];
  const affectedTasks =
    canDeleteStep && step
      ? steps
          .slice(index + 1)
          .filter(
            (item) => item.kind === 'task' && item.inputFrom?.includes(step.id),
          )
      : [];
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
  const reviewReady =
    !run?.results.length ||
    (previewedGate === run.gate?.id &&
      (run.gate?.startNextSession || preview?.name === run.results.at(-1)));

  async function updateList() {
    setList(
      workflowListSchema.parse(await (await localRequest('/workflows')).json()),
    );
  }
  useEffect(() => {
    if (!connected) return;
    void updateList().catch((error: unknown) => setError(message(error)));
  }, [connected]);
  const reviewFile = run?.results.at(-1);
  const reviewAuthor = executionSteps.find(
    (s) => s.kind === 'task' && s.id + '.md' === reviewFile,
  );
  const gateId = run?.gate?.id;
  const autoOpenReview =
    run?.gate?.kind === 'review' &&
    routeRun() === run.summary.id &&
    (location.hash.endsWith('/review') ||
      location.hash === '#/runs/' + run.summary.id);
  useEffect(() => {
    if (!autoOpenReview || !reviewFile || !gateId || !runId) return;
    const c = new AbortController();
    void localRequest(
      '/runs/' + runId + '/results/' + reviewFile,
      'GET',
      undefined,
      c.signal,
    )
      .then((r) => r.text())
      .then((text) => {
        if (!c.signal.aborted) {
          setPreview({ name: reviewFile, text });
          setPreviewedGate(gateId);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(message(e));
      });
    return () => c.abort();
  }, [autoOpenReview, reviewFile, gateId, runId]);
  const failedCommit =
    run?.summary.status === 'failed' &&
    executionSteps.some(
      (s) =>
        s.id === run.stepId &&
        s.kind === 'task' &&
        s.tool === 'verified-commit',
    );
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
          if (
            activeStatuses.has(updated.summary.status) ||
            updated.quotaRetryAt
          )
            timer = setTimeout(refresh, 700);
          else if (updated.retention && !updated.retention.expired)
            timer = setTimeout(refresh, 60_000);
          if (updated.retention?.expired)
            setPreview((current) =>
              current && !updated.results.includes(current.name)
                ? null
                : current,
            );
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
    setHistory((previous) => [
      ...previous.slice(-29),
      {
        definition: draft,
        selection: step?.id ?? selected,
        wire: selectedWire,
      },
    ]);
    setDraft(next);
    setError('');
  }
  function reset(
    definition: WorkflowDefinition,
    record: WorkflowVersion | null,
    keepView = false,
  ) {
    setSelectedWire('');
    setEditSession((n) => n + 1);
    setDraft(definition);
    setBaseline(definition);
    setSaved(record);
    setHistory([]);
    reveal.current = null;
    if (!keepView) {
      viewport.current = null;
      setCanvasSession((s) => s + 1);
      setNodeSizes({});
      setDragging(null);
      setFlowSettings(false);
      setProperties(true);
    }
    const restored =
      keepView && definition.steps.some((s) => s.id === selected);
    select(restored ? selected : (orderedSteps(definition)[0]?.id ?? ''));
    setChoice(record?.id ?? '');
    setLibrary(false);
  }
  const waitingForDesign =
    surface === 'design' && target !== null && saved?.id !== target;
  useEffect(() => {
    if (surface !== 'design') return;
    if (target === null) {
      if (saved && location.hash === '#/design') {
        // Older bookmarks and recovered drafts acquire their permanent address.
        window.history.replaceState(
          window.history.state,
          '',
          designUrl(saved.id),
        );
        setTarget(saved.id);
      }
      return;
    }
    if (saved?.id === target || designTarget() !== target) return;
    if (!workflowIdSchema.safeParse(target).success) {
      setRouteProblem('워크플로 주소가 올바르지 않습니다.');
      return;
    }
    const recovered = readEditorRecovery(target);
    if (recovered?.saved) {
      reset(recovered.baseline, recovered.saved);
      setDraft(recovered.draft);
      select(recovered.selected);
      setFlowSettings(recovered.flowSettings);
      setRestored(true);
      return;
    }
    const controller = new AbortController();
    setRouteProblem('');
    localRequest('/workflows/' + target, 'GET', undefined, controller.signal)
      .then((r) => r.json())
      .then((raw) => {
        if (controller.signal.aborted || designTarget() !== target) return;
        const record = workflowVersionSchema.parse(raw);
        reset(record.definition, record);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setRouteProblem(message(e));
      });
    return () => controller.abort();
  }, [surface, target, saved?.id, routeAttempt]);
  function replaceStep(next: Step) {
    change({
      ...draft,
      steps: draft.steps.map((item) => (item.id === next.id ? next : item)),
    });
  }
  function changeOrder(next: Step[]) {
    change({ ...draft, steps: next, links: chain(next) });
  }
  function wire(
    from: string,
    to: string,
    previous?: { source: string; target: string },
  ) {
    if (
      busy ||
      from === to ||
      draft.links.some((link) => link.from === from && link.to === to)
    )
      return;
    const links = draft.links.filter(
      (link) =>
        link.from !== from &&
        link.to !== to &&
        !(previous?.source === link.from && previous.target === link.to),
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
    setSelectedWire(previous && to ? from + ':' + to : '');
  }
  function openRun(id: string) {
    location.hash = '/runs/' + id;
    setSurface('detail');
  }
  function move(offset: number) {
    const index = steps.findIndex((item) => item.id === step?.id);
    const next = [...steps];
    const current = next[index];
    const adjacent = next[index + offset];
    if (!current || !adjacent) return;
    next[index] = { ...adjacent, position: current.position };
    next[index + offset] = { ...current, position: adjacent.position };
    reveal.current = current.id;
    changeOrder(next);
  }
  function add(kind: Step['kind'] | 'ai-review', after = step?.id) {
    const index = steps.findIndex((s) => s.id === after),
      anchor = steps[index];
    if (!anchor || !joined || busy || steps.length >= 32) return;
    const entry = {
      id: 'step-' + crypto.randomUUID(),
      title:
        kind === 'ai-review'
          ? 'AI 검토'
          : kind === 'task'
            ? '새 작업'
            : '사용자 검토',
      position: anchor.position,
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
    reveal.current = entry.id;
    changeOrder(insertWorkflowStep(steps, index, created));
    inspect(entry.id);
  }
  const sessionGate = steps.find(
    (s) => s.kind === 'review' && s.startNextSession,
  );
  function addSessionLoop() {
    const last = steps.at(-1);
    if (!last || !joined || busy || sessionGate || steps.length > 30) return;
    const handoff: Step = {
      id: 'handoff-' + crypto.randomUUID(),
      kind: 'task',
      title: '다음 회차 준비',
      position: last.position,
      agent: 'codex',
      workspaceAccess: 'read-only',
      inputFrom: steps
        .filter((s) => s.kind === 'task')
        .slice(-4)
        .map((s) => s.id),
      instructions:
        '이번 회차의 작업 요청과 전달받은 결과를 읽고 다음 회차의 첫 단계가 사용할 인계 문서를 작성한다. 완료한 일과 근거, 아직 확인할 점을 구분하고 다음에 진행할 과제 한 가지와 선택 이유를 제시한다. 완료한 과제를 반복하지 않는다. 남은 과제가 없으면 종료를 권한다. 2,000자 이내로 작성한다.',
    };
    const next = insertWorkflowStep(steps, steps.length - 1, handoff);
    const gate: Step = {
      id: 'continue-' + crypto.randomUUID(),
      kind: 'review',
      title: '다음 회차 시작 승인',
      startNextSession: true,
      position: last.position,
    };
    changeOrder(insertWorkflowStep(next, next.length - 1, gate));
    reveal.current = gate.id;
  }
  function undo() {
    const old = history.at(-1);
    if (!old) return;
    select(old.selection);
    setSelectedWire(old.wire);
    setError('');
    reveal.current = old.selection;
    setDraft(old.definition);
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
      if (!saved) sessionStorage.removeItem(recoveryKey());
      if (screen() === 'design' && designTarget() !== record.id)
        location.hash = designUrl(record.id);
      setSaved(record);
      setDraft(record.definition);
      setBaseline(record.definition);
      setChoice(record.id);
      await updateList();
    });
  }
  const [gitPrep, setGitPrep] = useState<{
    version: WorkflowVersion;
    material?: RunMaterial;
    request?: string;
    files?: RequestFiles;
  } | null>(null);
  function prepareGit(
    version: WorkflowVersion,
    request?: string,
    files?: RequestFiles,
    material?: RunMaterial,
  ) {
    setError('');
    setGitPrep({ version, request, files, material });
  }
  function start(
    version: WorkflowVersion | null = saved,
    material?: RunMaterial,
    taskRequest?: string,
    requestFiles?: RequestFiles,
  ) {
    if (!version) return;
    perform(async () => {
      if (requestFiles?.workspace && !requestFiles.gitTarget) {
        const { location } = await (
          await localRequest('/git/inspect', 'POST', {
            path: requestFiles.workspace,
          })
        ).json();
        if (location) {
          prepareGit(version, taskRequest, requestFiles, material);
          return;
        }
      }
      const modelSettings =
        model.trim() || effort
          ? { model: model.trim() || undefined, effort }
          : undefined;
      if (
        modelSettings?.model &&
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(modelSettings.model)
      )
        throw Error(
          '모델 ID에는 영문, 숫자, 점, 밑줄, 하이픈을 사용할 수 있습니다.',
        );
      const key = JSON.stringify([
        modelSettings,
        version.id,
        version.version,
        material,
        taskRequest,
        requestFiles,
      ]);
      const id =
        requestedStart.current?.key === key
          ? requestedStart.current.id
          : crypto.randomUUID();
      requestedStart.current = { id, key };
      setStarting(true);
      try {
        const response = await localRequest('/runs', 'POST', {
          id,
          workflowId: version.id,
          workflowVersion: version.version,
          modelSettings,
          material,
          taskRequest,
          requestFiles,
        });
        const started = runViewSchema.parse(await response.json());
        if (material) storeMaterialDraft(version, emptyMaterialDraft);
        setMaterialVersion(null);
        setGitPrep(null);
        setRun(started);
        setRunId(id);
        sessionStorage.setItem('studio-run', id);
        openRun(id);
        requestedStart.current = null;
        setPreview(null);
        setAnswer('');
      } finally {
        setStarting(false);
      }
    });
  }
  function decide(
    decision: RunDecision,
    edit?: { file: string; text: string; original: string; rule?: string },
  ) {
    perform(async () => {
      if (edit && decision.decision === 'accept') {
        const bytes = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(edit.original),
        );
        decision = {
          ...decision,
          edit: {
            file: edit.file,
            text: edit.text,
            ...(edit.rule?.trim() && { rule: edit.rule.trim() }),
            expected: Array.from(new Uint8Array(bytes), (b) =>
              b.toString(16).padStart(2, '0'),
            ).join(''),
          },
        };
      }
      const path = '/runs/' + runId;
      let updated: RunView;
      try {
        updated = runViewSchema.parse(
          await (
            await localRequest(path + '/decision', 'POST', decision)
          ).json(),
        );
      } catch (error) {
        if (!(error instanceof LocalRequestError) || error.status !== 409)
          throw error;
        updated = runViewSchema.parse(
          await (await localRequest(path + '/view')).json(),
        );
        if (edit) {
          if (routeRun() === runId) setRun(updated);
          throw Error(
            edit.rule
              ? '규칙과 수정본을 저장하지 못했습니다. 현재 흐름 버전과 승인 상태를 확인하거나 이번 결과만 승인하세요.'
              : '승인 상태가 변경되어 수정본을 저장하지 못했습니다. 현재 결과를 확인하세요.',
            { cause: error },
          );
        }
        if (updated.gate?.id === decision.gateId) throw error;
      }
      if (routeRun() !== runId) return;
      setRun(updated);
      if (edit) setPreview({ name: edit.file, text: edit.text });
      setEditing(undefined);
      setAnswer('');
    });
  }
  function showFile(
    name: string,
    focusOnMobile = true,
    evidenceQuote?: string,
  ) {
    perform(async () => {
      const text = await (
        await localRequest(
          '/runs/' + runId + '/results/' + encodeURIComponent(name),
        )
      ).text();
      if (routeRun() !== runId) return;
      setPreview({
        name,
        text,
        focusOnMobile,
        evidenceQuote:
          evidenceQuote && text.includes(evidenceQuote)
            ? evidenceQuote
            : undefined,
      });
      if (run?.gate?.kind === 'review' && name === run.results.at(-1))
        setPreviewedGate(run.gate.id);
    });
  }

  const [documentSources, setDocumentSources] = useState<{
    key: string;
    files: Record<string, DocumentSource | null | undefined>;
  }>();
  const sourceKey = saved ? saved.id + '/' + saved.version : '';
  useEffect(() => {
    if (!saved || !connected || surface !== 'design') return;
    const controller = new AbortController();
    const tasks = saved.definition.steps.filter((item) => item.kind === 'task');
    async function load() {
      const entries = await Promise.all(
        tasks.map(async (item) => {
          try {
            const response = await localRequest(
              '/workflows/' +
                saved!.id +
                '/versions/' +
                saved!.version +
                '/documents/' +
                encodeURIComponent(item.id + '.md'),
              'GET',
              undefined,
              controller.signal,
            );
            const sources: DocumentSource[] = await response.json();
            return [item.id, sources[0] ?? null] as const;
          } catch {
            return [item.id, undefined] as const;
          }
        }),
      );
      if (!controller.signal.aborted)
        setDocumentSources({
          key: sourceKey,
          files: Object.fromEntries(entries),
        });
    }
    void load();
    window.addEventListener('focus', load);
    return () => {
      controller.abort();
      window.removeEventListener('focus', load);
    };
  }, [saved, sourceKey, connected, surface]);
  function documentButton(item: Step) {
    const files =
      documentSources?.key === sourceKey ? documentSources.files : undefined;
    const run = files?.[item.id];
    const status = run
      ? documentSourceLabel(run, true)
      : !saved ||
          !saved.definition.steps.some((s) => s.id === item.id) ||
          run === null
        ? '실행 결과 없음'
        : !connected || files
          ? '회차 확인 불가'
          : '회차 조회 중';
    return (
      <button
        type="button"
        disabled={!run}
        className={'nodrag nopan ' + styles.nodeFile}
        aria-label={item.id + '.md 열기 · ' + status}
        title={item.id + '.md · ' + status}
        onClick={(event) => {
          event.stopPropagation();
          if (saved && run) {
            inspect(item.id);
            openDocument({
              workflow: saved.id,
              step: item.id,
              version: saved.version,
              run: run.id,
            });
          }
        }}
      >
        <span>{item.id}.md</span>
        <small>{status}</small>
      </button>
    );
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
              : item.workflowRef
                ? '워크플롯 ↗ v' + item.workflowRef.version
                : item.agent === 'codex'
                  ? 'Codex'
                  : '담당 미지정'}
            {item.kind === 'task' &&
              item.tool === 'market-calendar' &&
              ' · 공식 웹 조회'}
            {item.kind === 'task' &&
              item.tool === 'workplot-ui' &&
              ' · 화면 작업본'}
          </small>
          <strong>{item.title || '제목 없음'}</strong>
          {item.kind === 'task' && (
            <small
              title={item.instructions.trim() || undefined}
              style={{ display: 'block', overflowWrap: 'anywhere' }}
            >
              역할 · {instructionPreview(item.instructions)}
            </small>
          )}
          {item.kind === 'task' && item.codexSkill && (
            <small className={styles.boundSkill} title={item.codexSkill.title}>
              ${item.codexSkill.title}
            </small>
          )}
          {item.kind === 'review' ? (
            <code>승인 후 계속</code>
          ) : (
            documentButton(item)
          )}
        </>
      ),
    },
    position: dragging?.id === item.id ? dragging.position : item.position,
    measured: nodeSizes[item.id],
    // A reopened canvas can reuse node sizes before React Flow measures its ports.
    handles: nodeSizes[item.id]
      ? [
          {
            type: 'source' as const,
            position: Position.Right,
            x: nodeSizes[item.id]!.width,
            y: nodeSizes[item.id]!.height / 2,
            width: 0,
            height: 0,
          },
          {
            type: 'target' as const,
            position: Position.Left,
            x: 0,
            y: nodeSizes[item.id]!.height / 2,
            width: 0,
            height: 0,
          },
        ]
      : undefined,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    selected: !flowSettings && item.id === step?.id,
  }));
  const starts = steps.filter(
    (item) => !draft.links.some((link) => link.to === item.id),
  );
  const paths = starts.map((start) => {
    const path: Step[] = [];
    let current: Step | undefined = start;
    while (current && !path.includes(current)) {
      path.push(current);
      const next = draft.links.find((link) => link.from === current?.id)?.to;
      current = steps.find((item) => item.id === next);
    }
    return path;
  });
  const edges = draft.links.map(({ from, to }) => {
    const afterApproval =
      steps.find((item) => item.id === from)?.kind === 'review';
    return {
      id: from + ':' + to,
      source: from,
      target: to,
      selected: selectedWire === from + ':' + to,
      ariaLabel:
        titleFor(from) +
        (afterApproval ? ' → 승인 후 → ' : ' → ') +
        titleFor(to),
      label: afterApproval ? '승인 후' : undefined,
      labelStyle: { fontSize: 12, fontWeight: 600 },
      interactionWidth: 28,
      markerEnd: { type: MarkerType.ArrowClosed },
    };
  });
  const chosenWire = edges.find((edge) => edge.id === selectedWire);
  function disconnect(id: string) {
    const edge = edges.find((item) => item.id === id);
    if (!edge || busy) return;
    change({
      ...draft,
      links: draft.links.filter(
        (link) => !(link.from === edge.source && link.to === edge.target),
      ),
    });
    setSelectedWire('');
  }
  const invalidAgent = steps.some(
    (item) => item.kind === 'task' && item.agent === 'unassigned',
  );
  const activeRows =
    rows?.filter((row) => row.occupiesSlot ?? activeStatuses.has(row.status)) ??
    [];
  const occupyingRun = activeRows[0] ?? (active ? run?.summary : undefined);
  const slotLimit = slotSettings?.limit ?? 0;
  const slotDataReady =
    !!slotSettings && connected && rows !== null && !dashboardError;
  const freeSlots = activeRows.every(
    (row) => row.isolatedTask && !row.masterRunId && row.status !== 'unknown',
  )
    ? Math.max(0, slotLimit - activeRows.length)
    : 0;
  const gitSlotAvailable = slotDataReady && freeSlots > 0;
  const slotInfo = (
    <div className={styles.slotInfo} aria-label="개발 작업 슬롯">
      <span>
        {slotDataReady
          ? `슬롯 ${activeRows.length}/${slotLimit} 사용 · 추가 ${freeSlots}개 가능`
          : '슬롯 확인 중'}
      </span>
      {slotSettings && (
        <details>
          <summary>슬롯 설정</summary>
          <p>
            사용 가능 CPU {slotSettings.cores}코어 · 여유 메모리{' '}
            {slotSettings.availableGiB} GiB · 추천 {slotSettings.recommended}개
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveSlotLimit(Number(slotInput || slotLimit));
            }}
          >
            <label>
              동시 실행 한도{' '}
              <input
                type="number"
                min="1"
                max={MAX_DEVELOPMENT_SLOTS}
                required
                value={slotInput || String(slotLimit)}
                onChange={(e) => setSlotInput(e.target.value)}
              />
            </label>
            <button disabled={savingSlots}>저장</button>
            <button
              type="button"
              disabled={savingSlots}
              onClick={() => void saveSlotLimit(slotSettings.recommended)}
            >
              추천값 적용
            </button>
          </form>
          {slotIssue && <p role="alert">{slotIssue}</p>}
        </details>
      )}
      {slotDataReady &&
        freeSlots === 0 &&
        activeRows.map((row) => (
          <a key={row.id} href={'#/runs/' + row.id}>
            {list.find((flow) => flow.id === row.workflowId)?.name ?? row.name}{' '}
            v{row.workflowVersion} ·{' '}
            {row.status === 'waiting'
              ? row.gateKind === 'question'
                ? '답변 대기'
                : '승인 대기'
              : row.status === 'queued'
                ? '시작 대기'
                : row.status === 'unknown'
                  ? '상태 확인 필요'
                  : '실행 중'}
          </a>
        ))}
    </div>
  );
  function startDisabledReason(development = false): string {
    if (starting) return '실행 요청을 접수하고 있습니다.';
    if (!connected) return '로컬 서버 연결을 확인하세요.';
    if (development && !slotDataReady) return '실행 슬롯을 확인하고 있습니다.';
    if (occupyingRun && !(development && gitSlotAvailable)) {
      const label =
        (occupyingRun.workflowId === saved?.id
          ? '이 워크플롯'
          : '다른 워크플롯') +
        ' v' +
        occupyingRun.workflowVersion;
      if (!development && !startDisabledReason(true)) {
        const state =
          occupyingRun.status === 'waiting' ? '승인 대기 중' : '실행 중';
        return (
          label +
          '이 ' +
          state +
          '입니다. ‘개발 작업 실행’으로 별도 Git 작업 폴더에서 병렬 실행할 수 있습니다.'
        );
      }
      if (occupyingRun.status === 'waiting') {
        if (occupyingRun.id === run?.summary.id && run.gate?.startNextSession)
          return (
            label +
            '이 다음 세션 승인 대기 중입니다. 실행 상세에서 ‘이번 세션 마치기’를 선택하면 새 실행을 시작할 수 있습니다.'
          );
        return (
          label +
          '이 사용자 확인 대기 중입니다. 실행 현황에서 대기 중인 단계를 열어 주세요.'
        );
      }
      return label + '이 실행 중입니다. 실행 현황에서 진행 상황을 확인하세요.';
    }
    if (!codexAvailable)
      return '내 에이전트 도구에서 Codex 연결 상태를 확인하세요.';
    if (!saved || dirty) return '흐름을 먼저 저장하세요.';
    if (invalidAgent) return '담당 도구가 없는 작업 단계에 도구를 지정하세요.';
    if (checkingRun || busy) return '현재 요청을 처리하고 있습니다.';
    return '';
  }
  const startHint = startDisabledReason();
  const actionIcons = {
    되돌리기: Undo2,
    '변경 취소': RotateCcw,
    '앞으로 이동': ArrowLeft,
    '뒤로 이동': ArrowRight,
    '단계 삭제': Trash2,
    '작업 중단': Square,
    '실패한 단계 다시 실행': Redo2,
    '흐름 열기': FolderOpen,
    '새 흐름': FilePlus,
    '내 노드로 저장': Save,
    '내 노드함': FolderOpen,
  };
  const button = (label: string, action: () => void, disabled = false) => {
    const Icon = actionIcons[label as keyof typeof actionIcons];
    return (
      <button type="button" onClick={action} disabled={disabled}>
        {Icon && <Icon size={15} aria-hidden="true" />}
        {label}
      </button>
    );
  };

  function openWorkflow(id: string, stepId?: string, settings = false) {
    if (dirty || !connected) return;
    if (!stepId && !settings) {
      location.hash = designUrl(id);
      return;
    }
    const sourceHash = location.hash;
    perform(async () => {
      const record = workflowVersionSchema.parse(
        await (await localRequest('/workflows/' + id)).json(),
      );
      if (location.hash !== sourceHash) return;
      if (
        stepId &&
        !record.definition.steps.some((item) => item.id === stepId)
      ) {
        setError('선택한 단계는 최신 저장 워크플로에서 삭제되었습니다.');
        return;
      }
      reset(record.definition, record);
      if (settings) setFlowSettings(true);
      if (stepId) {
        inspect(stepId);
        reveal.current = stepId;
      }
      location.hash = designUrl(record.id);
    });
  }
  function inspect(id: string) {
    select(id);
    setSelectedWire('');
    setFlowSettings(false);
    setProperties(true);
  }
  return (
    <>
      {surface === 'design' &&
        saved &&
        documentRequest?.workflow === saved.id && (
          <DesignDocument
            key={[saved.id, documentRequest.version, documentRequest.step].join(
              '/',
            )}
            workflowId={saved.id}
            version={documentRequest.version}
            file={documentRequest.step + '.md'}
            busy={busy}
            run={documentRequest.run}
            onRun={(run) => {
              const route = { ...documentRequest, run };
              window.history.replaceState(
                window.history.state,
                '',
                documentUrl(route),
              );
              setDocumentRequest(route);
            }}
            close={() => {
              window.history.replaceState(
                window.history.state,
                '',
                designUrl(saved.id),
              );
              setDocumentRequest(null);
            }}
          >
            {step?.id === documentRequest.step && link && (
              <>
                <h3>하위 지침 · v{link.version}</h3>
                {linkedRecord?.id === link.id &&
                  linkedRecord.version === link.version && (
                    <LinkedInstructions
                      key={link.id + '/' + link.version}
                      record={linkedRecord}
                      disabled={!connected || busy}
                      save={(childDefinition) =>
                        perform(async () => {
                          const response = await localRequest(
                            '/workflows/' +
                              saved.id +
                              '/steps/' +
                              step.id +
                              '/linked-instructions',
                            'PUT',
                            {
                              baseVersion: saved.version,
                              definition: draft,
                              childDefinition,
                            },
                          );
                          const updated = workflowVersionSchema.parse(
                            await response.json(),
                          );
                          setSaved(updated);
                          setDraft(updated.definition);
                          setBaseline(updated.definition);
                          setHistory([]);
                          await updateList();
                        })
                      }
                    />
                  )}
                {error && <p role="alert">{error}</p>}
              </>
            )}
          </DesignDocument>
        )}
      {surface === 'design' && shelf && step && (
        <NodeShelf
          key={editSession}
          mode={shelf}
          definition={draft}
          selected={step.id}
          after={chosenWire?.source ?? step.id}
          close={() => setShelf(null)}
          apply={(definition, id) => {
            change(definition);
            inspect(id);
            reveal.current = id;
            setShelf(null);
          }}
        />
      )}
      <nav className={styles.rail} aria-label="작업공간">
        <span className={styles.brand} aria-label="Workplot">
          <WireIcon />
        </span>
        <a
          href="#/runs"
          aria-current={
            surface !== 'design' && surface !== 'library' ? 'page' : undefined
          }
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 4h6v6H3zM13 5h8M13 9h6M3 14h6v6H3zM13 15h8M13 19h6" />
          </svg>
          실행 현황
        </a>
        <a
          href="#/library"
          aria-current={surface === 'library' ? 'page' : undefined}
        >
          <FolderOpen aria-hidden="true" />내 워크플로
        </a>
        <a
          href={designUrl(saved?.id)}
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
                ? waitingForDesign
                  ? '흐름 설계'
                  : draft.name || '새 작업 흐름'
                : surface === 'library'
                  ? '내 워크플로'
                  : surface === 'monitor'
                    ? '워크플로 대시보드'
                    : surface === 'compare'
                      ? '문서 비교'
                      : surface === 'master'
                        ? '마스터 실행'
                        : '실행과 결과'}
            </h1>
          </div>
          {surface === 'design' && !waitingForDesign && (
            <>
              <div className={styles.version}>
                <span role="status">
                  {saved
                    ? `저장된 버전 ${saved.version}`
                    : '아직 저장하지 않음'}
                  {dirty && ' · 미저장 변경 있음'}
                  {dirty && restored && ' · 이 탭의 편집 내용 복원됨'}
                </span>
                {storageFailed && (
                  <span role="alert">
                    {' '}
                    · 임시 보관 실패. 떠나기 전에 흐름을 저장하세요.
                  </span>
                )}
              </div>
              <button
                aria-expanded={library}
                onClick={() => setLibrary(!library)}
              >
                <ListTree size={16} aria-hidden="true" /> 흐름 목록
              </button>{' '}
              <div className={styles.buttons}>
                {saved && (
                  <button
                    type="button"
                    disabled={!!startDisabledReason(true)}
                    title={startDisabledReason(true) || undefined}
                    onClick={() => prepareGit(saved)}
                  >
                    개발 작업 실행
                  </button>
                )}
                {saved && modelControl}
                {saved && slotInfo}
                {button('되돌리기', undo, busy || history.length === 0)}
                {button(
                  '변경 취소',
                  () => reset(baseline, saved, true),
                  busy || !dirty,
                )}
                <button
                  className={styles.primary}
                  type="button"
                  onClick={save}
                  disabled={!connected || busy || (!!saved && !dirty)}
                >
                  <Save size={15} aria-hidden="true" /> 흐름 저장
                </button>
                <span
                  className={styles.startControl}
                  tabIndex={startHint ? 0 : undefined}
                  role={startHint ? 'group' : undefined}
                  aria-label={startHint ? '실행할 수 없는 이유' : undefined}
                  aria-describedby={startHint ? 'run-start-hint' : undefined}
                >
                  <button
                    className={styles.primary}
                    type="button"
                    onClick={() => start()}
                    disabled={!!startHint}
                    aria-describedby={startHint ? 'run-start-hint' : undefined}
                  >
                    <Play size={15} aria-hidden="true" />{' '}
                    {starting
                      ? '실행 접수 중…'
                      : saved
                        ? '저장한 버전 실행'
                        : '작업 실행 · 연결 준비 중'}
                  </button>
                  {startHint && (
                    <span
                      role="tooltip"
                      id="run-start-hint"
                      className={styles.startHint}
                    >
                      {startHint}
                    </span>
                  )}
                </span>
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
                    failedCommit
                      ? '커밋 단계만 다시 실행'
                      : '실패한 단계 다시 실행',
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
        {waitingForDesign && (
          <section aria-label="워크플로 열기">
            {routeProblem ? (
              <>
                <p role="alert">{routeProblem}</p>
                <button onClick={() => retryRoute((n) => n + 1)}>
                  다시 시도
                </button>{' '}
                <a href="#/library">내 워크플로</a>
              </>
            ) : (
              <p>워크플로를 여는 중…</p>
            )}
          </section>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {proposalMode && (
          <WorkflowProposal
            reuse={
              proposalMode === 'guided'
                ? async (match, signal) => {
                    const version = workflowVersionSchema.parse(
                      await (
                        await localRequest(
                          '/workflows/' +
                            match.id +
                            '/versions/' +
                            match.version,
                          'GET',
                          undefined,
                          signal,
                        )
                      ).json(),
                    );
                    if (signal.aborted) return;
                    setError('');
                    setProposalMode(null);
                    prepareMaterial(version);
                  }
                : undefined
            }
            guidedSave={
              proposalMode === 'guided'
                ? async (definition) => {
                    const record = workflowVersionSchema.parse(
                      await (
                        await localRequest('/workflows', 'POST', definition)
                      ).json(),
                    );
                    reset(record.definition, record);
                    setProposalMode(null);
                    location.hash = designUrl(record.id);
                    void updateList().catch((e) => setError(message(e)));
                  }
                : undefined
            }
            base={null}
            close={() => setProposalMode(null)}
            propose={async (request, signal, clarifications) =>
              (
                await localRequest(
                  '/workflow-proposals',
                  'POST',
                  {
                    request,
                    mode: 'create',
                    ...(proposalMode === 'guided' && {
                      reviewBeforeRevision: true,
                    }),
                    ...(clarifications.length && { clarifications }),
                  },
                  signal,
                )
              ).json()
            }
            apply={(next) => {
              if (proposalMode === 'create') {
                reset(blank, null);
                location.hash = designUrl();
                setDraft(next);
                select(orderedSteps(next)[0]!.id);
                setError('');
              } else change(next);
              setProposalMode(null);
            }}
          />
        )}
        {gitPrep && (
          <GitRun
            flow={
              gitPrep.version.definition.name + ' · v' + gitPrep.version.version
            }
            folder={gitPrep.files?.workspace ?? ''}
            request={gitPrep.request ?? ''}
            error={error}
            busy={busy}
            onClose={() => setGitPrep(null)}
            onStart={(gitTarget, request) => {
              const files = {
                ...gitPrep.files,
                references: gitPrep.files?.references ?? [],
                workspace: gitTarget.path,
                gitTarget,
              };
              if (
                (!gitPrep.material &&
                  !gitPrep.version.definition.input?.trim()) ||
                (files.handoff &&
                  missingInputFields(
                    requiredInputFields(gitPrep.version.definition),
                    gitPrep.material?.source ?? '',
                  ).length > 0)
              ) {
                prepareMaterial(gitPrep.version, request || undefined, files);
                setGitPrep(null);
              } else
                start(
                  gitPrep.version,
                  gitPrep.material,
                  request || undefined,
                  files,
                );
            }}
          />
        )}
        {materialVersion && !gitPrep && (
          <MaterialDialog
            key={materialVersion.id + ':' + materialVersion.version}
            version={materialVersion}
            start={(v, m) => start(v, m, materialRequest, materialFiles)}
            busy={busy}
            close={() => {
              setMaterialVersion(null);
              setError('');
            }}
            error={error}
          />
        )}
        {surface === 'library' && (
          <WorkflowLibrary
            modelControl={modelControl}
            rows={rows}
            starting={starting}
            develop={prepareGit}
            slotInfo={slotInfo}
            developmentBusy={
              busy || !connected || !codexAvailable || !gitSlotAvailable
            }
            startSaved={(v, request, files) =>
              start(v, undefined, request, files)
            }
            prepare={(v, request, files) => {
              setError('');
              prepareMaterial(v, request, files);
            }}
            edit={openWorkflow}
            editSettings={(id) => openWorkflow(id, undefined, true)}
            canEdit={!dirty && !busy && connected}
            busy={
              busy ||
              !connected ||
              !codexAvailable ||
              rows === null ||
              rows.some((r) => activeStatuses.has(r.status))
            }
          />
        )}
        {(surface === 'compare' || surface === 'detail') &&
          run?.summary.id === runId &&
          run?.summary.status === 'completed' && (
            <div className={styles.buttons}>
              {button(
                '이 버전으로 다시 사용',
                () =>
                  perform(async () => {
                    const version = workflowVersionSchema.parse(
                      await (
                        await localRequest(
                          '/workflows/' +
                            run.summary.workflowId +
                            '/versions/' +
                            run.summary.workflowVersion,
                        )
                      ).json(),
                    );
                    if (routeRun() === run.summary.id) prepareMaterial(version);
                  }),
                busy ||
                  !connected ||
                  !codexAvailable ||
                  rows === null ||
                  rows.some((r) => activeStatuses.has(r.status)),
              )}
            </div>
          )}
        {surface === 'compare' && runId && (
          <DocumentComparison key={runId} runId={runId} />
        )}
        {surface === 'master' && masterId && (
          <MasterRun key={masterId} id={masterId} />
        )}
        {surface === 'monitor' && (
          <>
            <section className={styles.monitor} aria-labelledby="monitor-title">
              <div className={styles.monitorHead}>
                <h2 id="monitor-title">실행 현황</h2>
                <button
                  className={styles.primary}
                  disabled={busy || dirty || !connected || !codexAvailable}
                  onClick={() => setProposalMode('guided')}
                >
                  목표로 시작
                </button>
                <a className={styles.launch} href={designUrl(saved?.id)}>
                  와이어 편집기 열기 →
                </a>
              </div>
              {dirty && (
                <p>
                  편집 중인 흐름을 저장하거나 변경을 취소하면 새 목표를 시작할
                  수 있습니다.
                </p>
              )}
              <div className={styles.metrics}>
                {(
                  [
                    ['all', '전체 실행', latestRows?.length],
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
                    onClick={() => {
                      setFilter(id);
                      setPage(1);
                    }}
                  >
                    <span>{label}</span>
                    <strong>
                      {connected && !dashboardError ? (count ?? '—') : '—'}
                    </strong>
                  </button>
                ))}
              </div>
              {connected && !dashboardError && activeRows.length > 0 && (
                <section aria-label="진행 중인 워크플롯">
                  <h3>진행 중인 워크플롯</h3>
                  <div className={styles.activeGrid}>
                    {activeRows
                      .toSorted(
                        (a, b) =>
                          Number(b.status === 'waiting' && !b.quotaRetryAt) -
                          Number(a.status === 'waiting' && !a.quotaRetryAt),
                      )
                      .map((row) => {
                        const waiting =
                          waitingRunLabels[
                            (row.quotaRetryAt ? undefined : row.gateKind) ??
                              'unspecified'
                          ];
                        return (
                          <ActiveSessionCard
                            key={row.id}
                            row={row}
                            history={earlierSessions(row)}
                            status={
                              row.quotaRetryAt
                                ? '한도 대기'
                                : row.status === 'waiting'
                                  ? waiting.status
                                  : runLabels[row.status]
                            }
                            action={
                              row.status === 'waiting' && !row.quotaRetryAt
                                ? row.gateKind === 'review'
                                  ? '문서 검토 열기'
                                  : waiting.action
                                : '실행 상세 열기'
                            }
                          />
                        );
                      })}
                  </div>
                </section>
              )}
              {connected && !codexAvailable && (
                <div className={`${styles.buttons} ${styles.codexNotice}`}>
                  <p>
                    시작하려면 ‘내 에이전트 도구’에서 Codex 설치 상태를
                    확인하세요.
                  </p>
                  <button
                    type="button"
                    aria-controls="agent-tools-panel"
                    onClick={onShowTools}
                  >
                    Codex 설치 상태 보기
                  </button>
                </div>
              )}
              <MasterLinks rows={pageRows} />
              <div className={styles.runListHeader}>
                <h3>실행 목록</h3>
                {connected &&
                  !dashboardError &&
                  (visibleRows?.length ?? 0) > runPageSizes[0] && (
                    <nav
                      className={styles.pagination}
                      aria-label="실행 목록 페이지"
                    >
                      <select
                        aria-label="페이지당 실행 개수"
                        value={pageSize}
                        onChange={(event) => {
                          const size = Number(event.target.value);
                          setPageSize(size);
                          setPage(1);
                          try {
                            localStorage.setItem(
                              'workplot.runList.pageSize',
                              String(size),
                            );
                          } catch {
                            /* This selection still applies to the current view. */
                          }
                        }}
                      >
                        {runPageSizes.map((size) => (
                          <option key={size} value={size}>
                            {size}개씩 보기
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        aria-label="이전 페이지"
                        disabled={currentPage === 1}
                        onClick={() => setPage(currentPage - 1)}
                      >
                        이전
                      </button>
                      <span aria-live="polite">
                        {currentPage} / {pageCount} 페이지
                      </span>
                      <button
                        type="button"
                        aria-label="다음 페이지"
                        disabled={currentPage === pageCount}
                        onClick={() => setPage(currentPage + 1)}
                      >
                        다음
                      </button>
                    </nav>
                  )}
              </div>
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
                      {pageRows.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <strong>{row.name}</strong>{' '}
                            <small>v{row.workflowVersion}</small>
                            {row.sessionSummary && (
                              <p className={styles.sessionSummary}>
                                {sessionHeadline(row.sessionSummary)}
                              </p>
                            )}
                            {row.previousSessionId && (
                              <SessionTrail
                                rows={earlierSessions(row)}
                                labels={runLabels}
                              />
                            )}
                          </td>
                          <td>
                            <span
                              className={styles.badge}
                              data-state={row.status}
                            >
                              {row.quotaRetryAt
                                ? '한도 대기'
                                : row.status === 'waiting'
                                  ? waitingRunLabels[
                                      row.gateKind ?? 'unspecified'
                                    ].status
                                  : runLabels[row.status]}
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
                                ? waitingRunLabels[
                                    row.gateKind ?? 'unspecified'
                                  ].action
                                : row.status === 'failed'
                                  ? '실패 상세 열기'
                                  : '결과 열기'}
                            </button>{' '}
                            {row.status === 'completed' && !!row.comparable && (
                              <a href={'#/runs/' + row.id + '/compare'}>
                                문서 비교
                              </a>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>
                  {filter === 'all'
                    ? '첫 문서를 만들려면 ‘목표로 시작’을 선택하세요. 초안을 승인한 뒤 수정안을 비교할 수 있습니다.'
                    : '해당 상태의 실행이 없습니다.'}
                </p>
              )}
            </section>
          </>
        )}
        {surface === 'design' && !waitingForDesign && (
          <>
            {library && (
              <div className={styles.library}>
                {button(
                  '새 흐름',
                  () => {
                    reset(blank, null);
                    location.hash = designUrl();
                  },
                  busy || dirty,
                )}
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
                  {chosenWire && (
                    <button
                      aria-label="와이어 메뉴"
                      aria-haspopup="menu"
                      onClick={(e) =>
                        setWireMenu({
                          id: chosenWire.id,
                          position: anchorMenu(e.currentTarget),
                        })
                      }
                    >
                      ⋯
                    </button>
                  )}
                  {wireMenu && edges.some((e) => e.id === wireMenu.id) && (
                    <ActionMenu
                      position={wireMenu.position}
                      close={() => setWireMenu(null)}
                      label="와이어 작업"
                      items={[
                        ...(['ai-review', 'task', 'review'] as const).map(
                          (kind) => ({
                            label:
                              '사이에 ' +
                              {
                                'ai-review': 'AI 검토',
                                task: '작업',
                                review: '사용자 검토',
                              }[kind] +
                              ' 추가',
                            disabled: busy || !joined || steps.length >= 32,
                            action: () =>
                              add(
                                kind,
                                edges.find((e) => e.id === wireMenu.id)?.source,
                              ),
                          }),
                        ),
                        {
                          label: '연결 끊기',
                          divider: true,
                          disabled: busy,
                          action: () => disconnect(wireMenu.id),
                        },
                      ]}
                    />
                  )}
                  {chosenWire && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => disconnect(chosenWire.id)}
                    >
                      <Scissors size={16} aria-hidden="true" /> 연결 끊기
                    </button>
                  )}
                  <button
                    onClick={() => setProperties(!properties)}
                    aria-expanded={properties}
                  >
                    <PanelRight size={16} aria-hidden="true" />{' '}
                    {properties ? '속성 접기' : '속성 열기'}
                  </button>
                </div>
                {!joined && (
                  <strong>
                    연결되지 않은 흐름 · 모든 단계를 한 줄로 연결하세요.
                  </strong>
                )}
                <div
                  className={styles.graph}
                  ref={graph}
                  aria-label="작업 흐름 노드"
                  onKeyDownCapture={(event) => {
                    const edge = (event.target as Element).closest(
                      '.react-flow__edge',
                    );
                    const id = edge?.getAttribute('data-id');
                    if (
                      id &&
                      ((event.shiftKey && event.key === 'F10') ||
                        event.key === 'ContextMenu')
                    ) {
                      event.preventDefault();
                      setSelectedWire(id);
                      setWireMenu({ id, position: anchorMenu(edge!) });
                      return;
                    }
                    if (
                      id &&
                      (event.key === 'Delete' || event.key === 'Backspace')
                    ) {
                      event.preventDefault();
                      disconnect(id);
                    }
                  }}
                >
                  <ReactFlow
                    key={canvasSession}
                    onInit={(instance) => {
                      flow.current = instance;
                    }}
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
                    onEdgeContextMenu={(event, edge) => {
                      event.preventDefault();
                      select(edge.source);
                      setSelectedWire(edge.id);
                      setWireMenu({
                        id: edge.id,
                        position: { x: event.clientX, y: event.clientY },
                      });
                    }}
                    onEdgeClick={(_event, edge) => {
                      select(edge.source);
                      setProperties(true);
                      setFlowSettings(false);
                      setSelectedWire(edge.id);
                    }}
                    reconnectRadius={7}
                    edgesReconnectable={!busy}
                    onReconnect={(edge, connection) =>
                      wire(connection.source, connection.target, edge)
                    }
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
                      setSelectedWire('');
                      setProperties(true);
                      setFlowSettings(true);
                    }}
                    onNodeDragStart={(_event, node) => {
                      select(node.id);
                      setFlowSettings(false);
                      setSelectedWire('');
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
                  {paths.map((path) => (
                    <div className={styles.mobilePath} key={path[0]!.id}>
                      {!joined && (
                        <small>
                          {path.length === 1 ? '연결 없음' : '연결된 단계'}
                        </small>
                      )}
                      {path.map((item, i) => (
                        <div key={item.id} style={{ minWidth: 0 }}>
                          <button
                            aria-pressed={!flowSettings && item.id === step?.id}
                            style={{
                              maxWidth: '100%',
                              whiteSpace: 'normal',
                              overflowWrap: 'anywhere',
                              textAlign: 'start',
                            }}
                            onClick={() => {
                              inspect(item.id);
                              stepPanel.current?.scrollTo({ top: 0 });
                            }}
                          >
                            <span>
                              {i + 1}. {item.title || '제목 없음'}
                              {item.kind === 'task' && (
                                <small>
                                  역할 · {instructionPreview(item.instructions)}
                                </small>
                              )}
                              {item.kind === 'review' && (
                                <small style={{ display: 'block' }}>
                                  사용자 검토
                                </small>
                              )}
                            </span>
                          </button>
                          {item.kind === 'task' && documentButton(item)}
                          {i < path.length - 1 && (
                            <div
                              className={styles.pathArrow}
                              aria-label={
                                item.title + ' → ' + path[i + 1]!.title
                              }
                            >
                              ↓ {item.kind === 'review' && '승인 후'}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
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
                <WorkflowProposal
                  key={editSession}
                  base={draft}
                  disabled={
                    busy ||
                    !connected ||
                    !codexAvailable ||
                    !workflowDefinitionSchema.safeParse(draft).success
                  }
                  close={() => setEditSession((n) => n + 1)}
                  propose={async (request, signal, clarifications, skill) =>
                    (
                      await localRequest(
                        '/workflow-proposals',
                        'POST',
                        {
                          request,
                          definition: draft,
                          ...(skill && { designSkill: skill }),
                          ...(clarifications.length && { clarifications }),
                        },
                        signal,
                      )
                    ).json()
                  }
                  apply={(next) => {
                    change(next);
                    setEditSession((n) => n + 1);
                  }}
                />
              </div>
              {properties && (
                <aside ref={stepPanel} className={styles.inspector}>
                  <div className={styles.switches}>
                    <button
                      aria-pressed={!flowSettings}
                      onClick={() => setFlowSettings(false)}
                    >
                      <SlidersHorizontal size={16} aria-hidden="true" /> 단계
                      속성
                    </button>
                    <button
                      aria-pressed={flowSettings}
                      onClick={() => setFlowSettings(true)}
                    >
                      <Workflow size={16} aria-hidden="true" /> 흐름 설정
                    </button>
                  </div>{' '}
                  <fieldset className={styles.settings} disabled={busy}>
                    <legend className={styles.scopeHeading}>
                      {flowSettings ? (
                        <Workflow size={18} aria-hidden="true" />
                      ) : (
                        <Settings2 size={18} aria-hidden="true" />
                      )}{' '}
                      {flowSettings ? '흐름 정보' : step?.title || '단계 속성'}
                    </legend>
                    {flowSettings && (
                      <>
                        <section aria-label="세션 반복">
                          <strong>세션 반복</strong>
                          <p>
                            {sessionGate
                              ? '마지막 인계 문서를 승인하면 같은 버전의 첫 단계부터 다음 회차가 시작됩니다.'
                              : '현재는 마지막 단계에서 실행이 끝납니다.'}
                          </p>
                          {sessionGate ? (
                            <button
                              type="button"
                              onClick={() => inspect(sessionGate.id)}
                            >
                              반복 단계 보기
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={!joined || steps.length > 30}
                              onClick={addSessionLoop}
                            >
                              인계와 반복 승인 추가
                            </button>
                          )}
                          {!sessionGate && (!joined || steps.length > 30) && (
                            <p>
                              {!joined
                                ? '먼저 모든 단계를 하나의 흐름으로 연결하세요.'
                                : '인계와 승인을 추가하려면 두 단계의 여유가 필요합니다.'}
                            </p>
                          )}
                        </section>
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
                          새 실행 필수 항목 (쉼표로 구분)
                          <input
                            key={JSON.stringify(requiredInputFields(draft))}
                            defaultValue={requiredInputFields(draft).join(', ')}
                            placeholder="예: 매장명, 주소, 영업시간"
                            onBlur={(e) => {
                              const fields = [
                                ...new Set(
                                  e.target.value
                                    .split(',')
                                    .map((f) => f.trim())
                                    .filter(Boolean),
                                ),
                              ];
                              if (
                                JSON.stringify(fields) !==
                                JSON.stringify(requiredInputFields(draft))
                              )
                                change({ ...draft, inputFields: fields });
                            }}
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
                    {!flowSettings && (
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
                    )}
                    {step && !flowSettings && (
                      <StepProperties
                        key={step.id}
                        roleContent={
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
                            {step.kind === 'task' && !step.workflowRef && (
                              <NodeInstructions
                                key={canvasSession + ':' + step.id}
                                title={step.title}
                                context={JSON.stringify({
                                  workflow: draft.name,
                                  goal: draft.goal,
                                  doneWhen: draft.doneWhen,
                                  inputs: step.inputFrom?.map(titleFor),
                                  connections: draft.links
                                    .filter(
                                      ({ from, to }) =>
                                        from === step.id || to === step.id,
                                    )
                                    .map(({ from, to }) => [
                                      titleFor(from),
                                      titleFor(to),
                                    ]),
                                  nextRole: steps.find(
                                    (item) =>
                                      item.id ===
                                      draft.links.find(
                                        (link) => link.from === step.id,
                                      )?.to,
                                  )?.kind,
                                })}
                                value={step.instructions}
                                change={(instructions) =>
                                  replaceStep({ ...step, instructions })
                                }
                                available={connected && codexAvailable}
                              />
                            )}
                            {step.kind === 'task' && (
                              <>
                                {saved && (
                                  <section aria-label="실행 결과">
                                    <strong>실행 결과</strong>
                                    {documentButton(step)}
                                  </section>
                                )}
                                {!saved && (
                                  <p>
                                    흐름을 저장하고 실행하면 이곳에서 결과
                                    문서를 읽을 수 있습니다.
                                  </p>
                                )}
                              </>
                            )}
                          </>
                        }
                        connections={
                          <>
                            <label>
                              다음 단계 연결
                              <select
                                value={
                                  draft.links.find(
                                    (link) => link.from === step.id,
                                  )?.to ?? ''
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
                            {step.kind === 'review' &&
                              !draft.links.some(
                                (link) => link.from === step.id,
                              ) && (
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={!!step.startNextSession}
                                    onChange={(event) =>
                                      replaceStep({
                                        ...step,
                                        startNextSession: event.target.checked
                                          ? true
                                          : undefined,
                                      })
                                    }
                                  />
                                  승인한 인계 문서로 다음 세션 시작
                                </label>
                              )}
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
                                  연결할 워크플롯
                                  <select
                                    value={
                                      link ? link.id + '/' + link.version : ''
                                    }
                                    onChange={(e) => {
                                      const [id, version] =
                                        e.target.value.split('/');
                                      const picked = list.find(
                                        (row) => row.id === id,
                                      );
                                      if (!picked) {
                                        replaceStep({
                                          ...step,
                                          workflowRef: undefined,
                                        });
                                        return;
                                      }
                                      replaceStep({
                                        ...step,
                                        workflowRef: {
                                          id: picked.id,
                                          version: Number(version),
                                        },
                                        title: picked.name,
                                        instructions:
                                          '연결한 워크플롯의 마지막 작업 문서를 반환합니다.',
                                        agent: 'codex',
                                        codexSkill: undefined,
                                        tool: undefined,
                                        skill: undefined,
                                      });
                                    }}
                                  >
                                    <option value="">연결 없음</option>
                                    {link &&
                                      !list.some(
                                        (row) =>
                                          row.id === link.id &&
                                          row.version === link.version,
                                      ) && (
                                        <option
                                          value={link.id + '/' + link.version}
                                        >
                                          {linkedRecord?.definition.name ??
                                            '연결된 흐름'}{' '}
                                          · v{link.version}
                                        </option>
                                      )}
                                    {list
                                      .filter((row) => row.id !== saved?.id)
                                      .map((row) => (
                                        <option
                                          key={row.id}
                                          value={row.id + '/' + row.version}
                                        >
                                          {row.name} · v{row.version}
                                        </option>
                                      ))}
                                  </select>
                                </label>
                                {link &&
                                  linkedRecord?.id === link.id &&
                                  linkedRecord.version === link.version && (
                                    <details key={link.id + link.version} open>
                                      <summary>
                                        {linkedRecord.definition.name} · v
                                        {link.version}
                                      </summary>
                                      <ol>
                                        {orderedSteps(
                                          linkedRecord.definition,
                                        ).map((s) => (
                                          <li key={s.id}>{s.title}</li>
                                        ))}
                                      </ol>
                                      {saved && (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            openDocument({
                                              workflow: saved.id,
                                              step: step.id,
                                              version: saved.version,
                                            })
                                          }
                                        >
                                          문서와 하위 지침 열기
                                        </button>
                                      )}
                                    </details>
                                  )}
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
                                () => {
                                  const next = removeWorkflowStep(steps, index);
                                  const neighbor =
                                    next[Math.min(index, next.length - 1)]!;
                                  changeOrder(next);
                                  inspect(neighbor.id);
                                  reveal.current = neighbor.id;
                                },
                                !canDeleteStep,
                              )}
                            </div>
                            {canDeleteStep && !busy && (
                              <details className={styles.inputs}>
                                <summary>삭제 영향</summary>
                                {previousStep && nextStep && (
                                  <p>
                                    앞 단계 ‘{titleFor(previousStep.id)}’와 뒤
                                    단계 ‘{titleFor(nextStep.id)}’가 서로
                                    재연결됩니다.
                                  </p>
                                )}
                                {!previousStep && nextStep && (
                                  <p>
                                    ‘{titleFor(nextStep.id)}’가 새 시작 단계가
                                    됩니다.
                                  </p>
                                )}
                                {previousStep && !nextStep && (
                                  <p>
                                    ‘{titleFor(previousStep.id)}’가 새 끝 단계가
                                    됩니다.
                                  </p>
                                )}
                                {step.kind === 'review' && (
                                  <p>
                                    이 단계의 사용자 승인 대기가 사라집니다.
                                  </p>
                                )}
                                {affectedTasks.length > 0 && (
                                  <>
                                    <p>
                                      삭제 후에는 저장하기 전에 아래 작업의
                                      ‘전달받을 문서’에서 삭제된 단계 참조를
                                      수정해야 합니다.
                                    </p>
                                    <ul>
                                      {affectedTasks.map((item) => (
                                        <li key={item.id}>
                                          {titleFor(item.id)}
                                        </li>
                                      ))}
                                    </ul>
                                  </>
                                )}
                              </details>
                            )}
                          </>
                        }
                        execution={
                          step.kind === 'task' && !link ? (
                            <>
                              {!link && (
                                <>
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
                                        Codex
                                        {codexAvailable ? '' : ' · 설치 미확인'}
                                      </option>
                                      <option value="unassigned">미지정</option>
                                      <option disabled>
                                        Claude Code · 실행 미연결
                                      </option>
                                    </select>
                                  </label>
                                  {step.codexSkill && (
                                    <div>
                                      실행 스킬 · ${step.codexSkill.title}{' '}
                                      <button
                                        type="button"
                                        onClick={() =>
                                          replaceStep({
                                            ...step,
                                            codexSkill: undefined,
                                          })
                                        }
                                      >
                                        연결 해제
                                      </button>
                                    </div>
                                  )}
                                  <label>
                                    작업 스킬
                                    <select
                                      value={step.skill ?? 'none'}
                                      onChange={(event) =>
                                        replaceStep({
                                          ...step,
                                          skill:
                                            event.target.value ===
                                            'source-check'
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
                                  <label>
                                    Git 작업 폴더 권한
                                    <select
                                      value={step.workspaceAccess ?? ''}
                                      onChange={(e) =>
                                        replaceStep({
                                          ...step,
                                          workspaceAccess:
                                            e.target.value === 'read-only'
                                              ? 'read-only'
                                              : e.target.value === 'write'
                                                ? 'write'
                                                : undefined,
                                        })
                                      }
                                    >
                                      <option value="">
                                        자동 · 화면 구현 또는 단일 작업만 수정
                                      </option>
                                      <option value="read-only">
                                        읽기 전용
                                      </option>
                                      <option value="write">
                                        수정 및 체크포인트 저장
                                      </option>
                                    </select>
                                  </label>
                                  <label>
                                    사용 도구
                                    <select
                                      value={step.tool ?? ''}
                                      onChange={(event) =>
                                        replaceStep({
                                          ...step,
                                          tool:
                                            event.target.value ===
                                            'market-calendar'
                                              ? 'market-calendar'
                                              : event.target.value ===
                                                  'workplot-ui'
                                                ? 'workplot-ui'
                                                : event.target.value ===
                                                    'verified-commit'
                                                  ? 'verified-commit'
                                                  : undefined,
                                        })
                                      }
                                    >
                                      <option value="">없음</option>
                                      <option value="workplot-ui">
                                        Workplot 화면 구현·검증
                                      </option>
                                      <option value="verified-commit">
                                        검증 후 Git 커밋
                                      </option>
                                      <option value="market-calendar">
                                        공식 웹 조회 · 츠키지 달력
                                      </option>
                                    </select>
                                  </label>
                                </>
                              )}
                            </>
                          ) : undefined
                        }
                      />
                    )}
                    {!flowSettings && step && (
                      <div className={styles.buttons}>
                        {button(
                          '내 노드로 저장',
                          () => setShelf('save'),
                          !joined,
                        )}
                        {button('내 노드함', () => setShelf('browse'), !joined)}
                      </div>
                    )}
                    {!flowSettings && (
                      <div className={styles.addRow}>
                        {newKind === 'review' ? (
                          <UserCheck size={18} aria-hidden="true" />
                        ) : newKind === 'ai-review' ? (
                          <Bot size={18} aria-hidden="true" />
                        ) : (
                          <FilePlus size={18} aria-hidden="true" />
                        )}
                        <select
                          aria-label="추가할 단계 유형"
                          value={newKind}
                          onChange={(event) =>
                            setNewKind(event.target.value as typeof newKind)
                          }
                        >
                          <option value="task">작업 단계</option>
                          <option value="ai-review">AI 검토</option>
                          <option value="shelf">내 노드함 · 흐름 맞춤</option>
                          <option value="review">사용자 검토</option>
                        </select>
                        <button
                          type="button"
                          className={styles.primary}
                          disabled={!joined || steps.length >= 32}
                          onClick={() =>
                            newKind === 'shelf'
                              ? setShelf('browse')
                              : add(newKind)
                          }
                        >
                          <Plus size={16} aria-hidden="true" /> 추가
                        </button>
                      </div>
                    )}
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
            <div className={styles.paper} id="run-documents">
              {run?.summary.master && (
                <a href={'#/masters/' + run.summary.master.runId}>
                  ← 마스터 실행으로
                </a>
              )}
              {(run?.summary.previousSessionId ||
                run?.summary.nextSessionId) && (
                <nav className={styles.sessionLinks} aria-label="세션 이동">
                  {run.summary.previousSessionId && (
                    <a href={'#/runs/' + run.summary.previousSessionId}>
                      <ArrowLeft size={15} aria-hidden="true" /> 이전 세션
                    </a>
                  )}
                  {run.summary.nextSessionId && (
                    <a href={'#/runs/' + run.summary.nextSessionId}>
                      다음 세션 <ArrowRight size={15} aria-hidden="true" />
                    </a>
                  )}
                </nav>
              )}
              <div className={styles.docTitle}>
                <div>
                  <small>실행 결과</small>
                  <h2 ref={documentHeading} tabIndex={-1}>
                    {run?.gate?.startNextSession && preview?.name === reviewFile
                      ? '다음 세션 계획'
                      : preview?.name ||
                        (run?.gate?.kind === 'review'
                          ? '문서 검토'
                          : '결과 문서')}
                  </h2>
                </div>
                {run?.summary.status === 'completed' &&
                  !run.retention?.expired &&
                  (run.summary.origin || run.results.length > 1) && (
                    <a
                      className={styles.compareLink}
                      href={'#/runs/' + run.summary.id + '/compare'}
                    >
                      <Columns2 size={16} aria-hidden="true" /> 원안과 수정안
                      비교
                    </a>
                  )}
              </div>
              {run?.retention && (
                <div className={styles.fileHint}>
                  <p>
                    {run.retention.expired
                      ? '상세 기록 보관 기간이 끝났습니다.'
                      : run.retention.expiresAt
                        ? '상세 기록 보관 기한 · ' +
                          new Date(run.retention.expiresAt).toLocaleString(
                            'ko-KR',
                            {
                              timeZone: 'Asia/Seoul',
                              year: 'numeric',
                              month: 'long',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            },
                          )
                        : '루프 종료 후 30일간 상세 기록을 보관합니다.'}
                  </p>
                  {run.retention.summary && <p>{run.retention.summary}</p>}
                </div>
              )}
              {run && (
                <DocumentFlow
                  key={run.summary.id}
                  run={run}
                  steps={executionSteps}
                  selected={preview?.name}
                  busy={busy}
                  open={showFile}
                />
              )}
              {preview && (
                <div className={styles.result}>
                  {run?.summary.status === 'completed' &&
                    !run.retention?.expired &&
                    /인계|handoff/i.test(
                      preview.name + ' ' + preview.text.split('\n', 1)[0],
                    ) && (
                      <div>
                        <label>
                          개발 흐름{' '}
                          <select
                            value={handoffFlow}
                            onChange={(e) => setHandoffFlow(e.target.value)}
                          >
                            <option value="">흐름 선택</option>
                            {list.map((flow) => (
                              <option key={flow.id} value={flow.id}>
                                {flow.name} · v{flow.version}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          disabled={busy || !handoffFlow}
                          onClick={() =>
                            perform(async () => {
                              const version = workflowVersionSchema.parse(
                                await (
                                  await localRequest(
                                    '/workflows/' + handoffFlow,
                                  )
                                ).json(),
                              );
                              prepareGit(
                                version,
                                '인계 문서의 과제와 합격 기준에 따라 개발하고 검증한다.',
                                {
                                  references: [],
                                  workspace:
                                    run.summary.requestFiles?.workspace,
                                  handoff: {
                                    runId: run.summary.id,
                                    file: preview.name,
                                  },
                                },
                                {
                                  name: preview.name,
                                  source: (
                                    '개발 과제: ' +
                                    preview.name +
                                    ' 문서의 과제 및 합격 기준\n\n' +
                                    preview.text
                                  ).slice(0, 8000),
                                },
                              );
                            })
                          }
                        >
                          이 과제로 개발 시작
                        </button>
                      </div>
                    )}
                  <strong>{preview.name}</strong>{' '}
                  {run?.retention && run.results.includes(preview.name) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const kept = run.retention!.kept.includes(preview.name);
                        const action = kept
                          ? run.retention!.expired
                            ? 'delete'
                            : 'release'
                          : 'keep';
                        if (
                          action === 'delete' &&
                          !window.confirm(
                            preview.name +
                              ' 보관 문서를 삭제할까요? 삭제하면 복구할 수 없습니다.',
                          )
                        )
                          return;
                        perform(async () => {
                          const id = run.summary.id;
                          const response = await localRequest(
                            '/runs/' +
                              id +
                              '/results/' +
                              encodeURIComponent(preview.name) +
                              '/keep',
                            'PUT',
                            action,
                          );
                          const updated = runViewSchema.parse(
                            await response.json(),
                          );
                          if (routeRun() === id) {
                            setRun(updated);
                            if (action === 'delete') setPreview(null);
                          }
                        });
                      }}
                    >
                      {run.retention.kept.includes(preview.name)
                        ? run.retention.expired
                          ? '보관 문서 삭제'
                          : '보관 해제'
                        : '보관'}
                    </button>
                  )}
                  {preview.evidenceQuote && (
                    <blockquote aria-label="선택한 검사 근거">
                      {preview.evidenceQuote}
                    </blockquote>
                  )}
                  {run &&
                    !run.retention?.expired &&
                    /\.png\b/.test(preview.text) && (
                      <EvidenceCaptures
                        key={run.summary.id + preview.name}
                        runId={run.summary.id}
                        file={preview.name}
                        text={preview.text}
                      />
                    )}
                  {run?.editedFiles?.includes(preview.name) && (
                    <ApprovalChanges
                      key={run.summary.id + preview.name}
                      run={run.summary.id}
                      file={preview.name}
                    />
                  )}
                  <MarkdownDocument key={preview.name} text={preview.text} />
                </div>
              )}

              {!preview && (
                <p className={styles.fileHint}>
                  {run?.results.length
                    ? '문서를 선택하면 이곳에서 내용을 읽을 수 있습니다.'
                    : run?.retention?.expired
                      ? '보관한 문서가 없습니다.'
                      : '생성된 문서가 여기에 표시됩니다.'}
                </p>
              )}
            </div>
            <RunDivider />
            <aside className={styles.inspector} aria-label="실행 상세 패널">
              <small>실행 상세</small>
              {run?.summary.requestFiles?.handoff && (
                <a href={'#/runs/' + run.summary.requestFiles.handoff.runId}>
                  원본 인계 · {run.summary.requestFiles.handoff.file}
                </a>
              )}
              {rows
                ?.filter((r) => r.handoffRunId === runId && runId)
                .map((r) => (
                  <a key={r.id} href={'#/runs/' + r.id}>
                    인계한 개발 실행 · {r.name}
                  </a>
                ))}
              <h2>
                {rows?.find((row) => row.id === runId)?.name ?? '작업 흐름'}
              </h2>{' '}
              {run?.recovery && (
                <p>
                  실패 복구 · {run.recovery.state}{' '}
                  {run.recovery.repair === run.summary.id ? (
                    <a href={'#/runs/' + run.recovery.source}>원본 실행</a>
                  ) : (
                    run.recovery.state !== '접수' && (
                      <a href={'#/runs/' + run.recovery.repair}>
                        Astra 복구 보고서
                      </a>
                    )
                  )}
                </p>
              )}
              {run && <GitRunInfo run={run} />}
              {run?.summary.requestFiles && (
                <details>
                  <summary>첨부 · 작업 폴더</summary>
                  {run.summary.requestFiles.references.map((path) => (
                    <p key={path}>참고 · {path}</p>
                  ))}
                  {run.summary.requestFiles.workspace && (
                    <p>수정할 폴더 · {run.summary.requestFiles.workspace}</p>
                  )}
                </details>
              )}
              {run && (
                <details>
                  <summary>AI 실행 설정과 호출 기록</summary>
                  <p>
                    요청 모델 {run.summary.modelSettings?.model ?? '자동'} ·
                    추론 강도 {run.summary.modelSettings?.effort ?? '자동'}
                  </p>
                  {run.modelCalls?.length ? (
                    <ul>
                      {run.modelCalls.map((c, i) => (
                        <li key={i}>
                          {executionSteps.find((s) => s.id === c.step)?.title ??
                            c.step}{' '}
                          · {c.model} · {c.effort}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>CLI에서 확인된 호출 기록이 없습니다.</p>
                  )}
                </details>
              )}
              {run?.summary.taskRequest && (
                <details>
                  <summary>이번 작업 요청</summary>
                  <p style={{ whiteSpace: 'pre-wrap' }}>
                    {run.summary.taskRequest}
                  </p>
                </details>
              )}
              <p aria-live="polite">
                {run
                  ? `버전 ${run.summary.workflowVersion} · ${run.quotaRetryAt ? '한도 대기' : runLabels[run.summary.status]}`
                  : checkingRun
                    ? '실행 기록을 불러오는 중…'
                    : '선택한 실행이 없습니다.'}
                {run?.summary.status === 'running' &&
                  run.stepId &&
                  ' · ' +
                    (executionSteps.find((s) => s.id === run.stepId)?.title ??
                      run.stepId)}
                {run?.summary.status === 'failed' && run.stepId
                  ? ` · ${run.quotaRetryAt ? '대기' : '실패'} 단계 ${run.stepId}`
                  : ''}
                {run?.quotaRetryAt && (
                  <span>
                    {' '}
                    · 재시도 가능 시각{' '}
                    {new Date(run.quotaRetryAt).toLocaleString('ko-KR')} ·
                    위임이 유효하면 자동 재개
                  </span>
                )}
                {run?.note ? ` · ${run.note}` : ''}
              </p>
              {run && (run.timedOut || run.hasTimeoutHistory) && (
                <TimeoutHistory
                  key={run.summary.id}
                  id={run.summary.id}
                  status={run.summary.status}
                  steps={executionSteps}
                />
              )}
              {failedCommit && run && (
                <CommitRecovery
                  key={run.summary.id + run.failureId}
                  run={run}
                />
              )}
              {run?.portCheck && (
                <section aria-label="QA 포트 검사">
                  <strong>QA 포트 검사</strong>
                  <p role="status">{run.portCheck.reason}</p>
                  {run.portCheck.status !== 'passed' &&
                    button(
                      '포트 검사만 다시 실행',
                      () =>
                        perform(async () => {
                          const id = run.summary.id;
                          const response = await localRequest(
                            '/runs/' + id + '/qa-port/retry',
                            'POST',
                            { token: run.portCheck!.token },
                          );
                          const checked = portCheckSchema.parse(
                            await response.json(),
                          );
                          setRun((current) =>
                            current?.summary.id === id
                              ? { ...current, portCheck: checked }
                              : current,
                          );
                        }),
                      busy || !connected || run.portCheck.status === 'checking',
                    )}
                </section>
              )}
              {run?.summary.lastReview && (
                <p role="status" aria-label="최근 검토 결과">
                  {executionSteps.find(
                    (s) => s.id === run.summary.lastReview!.stepId,
                  )?.title ?? run.summary.lastReview.stepId}
                  {' · '}
                  {
                    {
                      accept: '승인 완료',
                      decline: '거절됨',
                      finish: '세션 마침',
                    }[run.summary.lastReview.decision]
                  }
                  {run.summary.lastReview.savedWorkflowVersion &&
                    ' · 흐름 v' +
                      run.summary.lastReview.savedWorkflowVersion +
                      '에 규칙 저장'}
                </p>
              )}
              {run?.gate && (
                <div className={styles.gate}>
                  <strong ref={reviewPrompt} tabIndex={-1}>
                    {run.gate.kind === 'review'
                      ? run.gate.startNextSession
                        ? '이번 세션을 마칠까요, 다음 세션을 시작할까요?'
                        : '검토 후 계속할까요?'
                      : 'Codex가 확인을 요청했습니다'}
                  </strong>
                  <p>
                    {run.gate.startNextSession
                      ? run.gate.repeatsSession
                        ? '반복 감지 · 이전 세션 ' +
                          run.gate.repeatsSession.slice(0, 8) +
                          '과 이번 세션의 소스와 화면 검사 결과가 같습니다. 계속하면 미달 항목을 다른 방법으로 점검합니다.'
                        : '계획을 확인한 뒤 승인하면 다음 세션이 시작됩니다.'
                      : run.gate.text}
                  </p>
                  {run.gate.kind === 'review' &&
                    !run.gate.startNextSession &&
                    reviewFile && (
                      <p>
                        승인 대상 · <strong>{reviewFile}</strong>
                      </p>
                    )}
                  {run.gate.kind === 'review' &&
                    !run.gate.startNextSession &&
                    reviewReady &&
                    preview &&
                    preview.name === reviewFile &&
                    (editing?.gate === run.gate.id ? (
                      <div>
                        <label>
                          승인할 수정본
                          <textarea
                            rows={8}
                            aria-label="승인할 수정본"
                            value={editing.text}
                            maxLength={128000}
                            onChange={(e) =>
                              setEditing({ ...editing, text: e.target.value })
                            }
                          />
                        </label>
                        {reviewAuthor?.kind === 'task' && (
                          <fieldset>
                            <legend>수정 적용 범위</legend>
                            <label>
                              <input
                                type="radio"
                                name="review-scope"
                                checked={editing.rule === undefined}
                                onChange={() =>
                                  setEditing({ ...editing, rule: undefined })
                                }
                              />
                              이번 결과만 수정
                            </label>
                            <label>
                              <input
                                type="radio"
                                name="review-scope"
                                checked={editing.rule !== undefined}
                                onChange={() =>
                                  setEditing({ ...editing, rule: '' })
                                }
                              />
                              다음 실행에도 규칙 적용
                            </label>
                            {editing.rule !== undefined && (
                              <>
                                <label>
                                  {reviewAuthor.title}에 추가할 규칙
                                  <textarea
                                    rows={3}
                                    maxLength={Math.max(
                                      0,
                                      Math.min(
                                        2000,
                                        7998 - reviewAuthor.instructions.length,
                                      ),
                                    )}
                                    value={editing.rule}
                                    onChange={(e) =>
                                      setEditing({
                                        ...editing,
                                        rule: e.target.value,
                                      })
                                    }
                                  />
                                </label>
                                <details>
                                  <summary>저장될 노드 지침 미리보기</summary>
                                  <p style={{ whiteSpace: 'pre-wrap' }}>
                                    {reviewAuthor.instructions}
                                  </p>
                                  <ins style={{ whiteSpace: 'pre-wrap' }}>
                                    {editing.rule.trim()}
                                  </ins>
                                </details>
                              </>
                            )}
                          </fieldset>
                        )}
                        {button(
                          editing.rule === undefined
                            ? '수정 후 승인'
                            : '규칙 저장 후 승인',
                          () =>
                            decide(
                              { gateId: run.gate!.id, decision: 'accept' },
                              { file: preview.name, ...editing },
                            ),
                          busy ||
                            !connected ||
                            !editing.text.trim() ||
                            (editing.rule !== undefined &&
                              !editing.rule.trim()) ||
                            (editing.text === editing.original &&
                              editing.rule === undefined),
                        )}
                        {button('수정 취소', () => setEditing(undefined), busy)}
                      </div>
                    ) : (
                      button(
                        '문서 수정',
                        () =>
                          setEditing({
                            gate: run.gate!.id,
                            original: preview.text,
                            text: preview.text,
                          }),
                        busy,
                      )
                    ))}
                  {run.gate.kind === 'review' ? (
                    <div className={styles.buttons}>
                      {run.results.length > 0 &&
                        (!run.gate.startNextSession ||
                          preview?.name !== reviewFile ||
                          !reviewReady) &&
                        button(
                          run.gate.startNextSession
                            ? '다음 세션 계획 열기'
                            : '검토할 문서 열기',
                          () => showFile(run.results.at(-1)!),
                          busy,
                        )}
                      {run.gate.startNextSession &&
                        button(
                          '이번 세션 마치기',
                          () =>
                            decide({
                              gateId: run.gate!.id,
                              decision: 'finish',
                            }),
                          busy || !connected,
                        )}
                      {button(
                        run.gate.startNextSession
                          ? run.gate.repeatsSession
                            ? '다른 접근으로 다음 세션 시작'
                            : '승인하고 다음 세션 시작'
                          : '승인하고 계속',
                        () =>
                          decide({ gateId: run.gate!.id, decision: 'accept' }),
                        busy ||
                          !connected ||
                          !reviewReady ||
                          editing?.gate === run.gate.id,
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
              <RunHistory
                openEvidence={(file, quote) => showFile(file, true, quote)}
                record={record}
                executionSteps={executionSteps}
                key={runId + (logRoute ? '/log' : '')}
                openLog={logRoute}
                run={run}
                disabled={busy || !connected || !codexAvailable}
                editDisabled={busy || dirty || !connected}
                editStep={(stepId) => {
                  if (run && routeRun() === run.summary.id)
                    openWorkflow(run.summary.workflowId, stepId);
                }}
                onInstructionsSaved={() => {
                  void updateList().catch((error: unknown) =>
                    setError(message(error)),
                  );
                }}
                rerun={(stepId, instructions) => {
                  if (!run) return;
                  perform(async () => {
                    const response = await localRequest(
                      '/runs/' + run.summary.id + '/rerun',
                      'POST',
                      { stepId, instructions },
                    );
                    const next = runViewSchema.parse(await response.json());
                    openRun(next.summary.id);
                    await updateList();
                  });
                }}
              />
              {run && (
                <div className={styles.buttons}>
                  {button(
                    '저장 흐름 편집',
                    () => openWorkflow(run.summary.workflowId),
                    busy || dirty || !connected,
                  )}
                  {dirty && (
                    <p>
                      단계 편집을 열려면 편집 중인 흐름을 저장하거나 변경을
                      취소하세요.
                    </p>
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

function TimeoutHistory({
  id,
  status,
  steps,
}: {
  id: string;
  status: string;
  steps: Step[];
}) {
  const [report, setReport] = useState<
    ReturnType<typeof timeoutReportSchema.parse>
  >([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void localRequest(
      '/runs/' + id + '/timeouts',
      'GET',
      undefined,
      controller.signal,
    )
      .then((r) => r.json())
      .then((data) => {
        if (!controller.signal.aborted) {
          setReport(timeoutReportSchema.parse(data));
          setError('');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('시간 초과 기록을 읽을 수 없습니다.');
      });
    return () => controller.abort();
  }, [id, status]);
  if (error) return <p role="status">{error}</p>;
  if (!report.length) return null;
  const seconds = (ms: number) => Math.round(ms / 1000) + '초';
  return (
    <section aria-label="시간 초과와 복구">
      {report.map((r) => (
        <details key={r.step} open={status === 'failed' || undefined}>
          <summary>
            {steps.find((s) => s.id === r.step)?.title ?? r.step} · 시간 초과{' '}
            {r.attempts.length}회
          </summary>
          <p>
            다시 시작할 단계 ·{' '}
            {steps.find((s) => s.id === r.step)?.title ?? r.step}
          </p>
          {r.attempts.map((a) => (
            <p key={a.begin}>
              {new Date(a.begin).toLocaleTimeString('ko-KR')} 시작 ·{' '}
              {seconds(a.elapsedMs)} 경과
              {a.parallel !== null &&
                ' · 시작 당시 실행 중 ' + a.parallel + '개'}
              <br />
              마지막 검사 · {a.lastCheck ?? '기록 없음'}
              {a.retryMs !== null && (
                <>
                  <br />
                  다음 시도 {seconds(a.retryMs)} · 다시 실행한 통과 검사{' '}
                  {a.repeatedChecks === null
                    ? '기록 없음'
                    : a.repeatedChecks + '개'}
                </>
              )}
              {a.recoveredMs !== null && (
                <>
                  <br />
                  실패부터 단계 완료까지 {seconds(a.recoveredMs)}
                </>
              )}
            </p>
          ))}
          {r.peers.length > 0 && (
            <>
              <strong>같은 단계에서 시간 초과한 실행</strong>
              <ul>
                {r.peers.map((p) => (
                  <li key={p.run}>
                    <a href={'#/runs/' + p.run}>{p.run.slice(0, 8)}</a>
                    {p.overlap && ' · 실행 시간 겹침'}
                  </li>
                ))}
              </ul>
            </>
          )}
        </details>
      ))}
    </section>
  );
}

function CommitRecovery({ run }: { run: RunView }) {
  const [diff, setDiff] = useState('');
  const [error, setError] = useState('');
  return (
    <section aria-label="커밋 단계 복구">
      <strong>커밋 단계에서 멈췄습니다</strong>
      <p>
        완료한 결과 문서 {run.results.length}개를 보존했습니다. 다시 실행하면 이
        회차의 변경을 검증하고 작업 브랜치에 커밋합니다.
      </p>
      {run.worktree && (
        <details
          onToggle={async (e) => {
            if (!e.currentTarget.open || diff) return;
            try {
              const result = await localRequest(
                '/runs/' + run.summary.id + '/staged-changes',
              );
              setDiff((await result.text()) || '스테이징된 변경이 없습니다.');
              setError('');
            } catch (e) {
              setError(message(e));
            }
          }}
        >
          <summary>변경 내용 보기</summary>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {error || diff || '변경을 읽는 중…'}
          </pre>
        </details>
      )}
    </section>
  );
}
function useRunDefinition(run: RunView | null) {
  const id = run?.summary.workflowId;
  const version = run?.summary.workflowVersion;
  const [loaded, setLoaded] = useState<{
    record: WorkflowVersion;
    executionSteps: Step[];
  } | null>(null);
  useEffect(() => {
    if (!id || !version) return;
    let disposed = false;
    const path = '/workflows/' + id + '/versions/' + version;
    async function load() {
      const record = workflowVersionSchema.parse(
        await (await localRequest(path)).json(),
      );
      if (disposed) return;
      const linked = record.definition.steps.some(
        (s) => s.kind === 'task' && s.workflowRef,
      );
      setLoaded({
        record,
        executionSteps: linked ? [] : orderedSteps(record.definition),
      });
      if (linked) {
        const expanded = workflowVersionSchema.parse(
          await (await localRequest(path + '?expanded=1')).json(),
        );
        if (!disposed)
          setLoaded({
            record,
            executionSteps: orderedSteps(expanded.definition),
          });
      }
    }
    void load().catch(() => {});
    return () => {
      disposed = true;
    };
  }, [id, version]);
  return loaded && loaded.record.id === id && loaded.record.version === version
    ? loaded
    : { record: null, executionSteps: [] };
}

function DocumentFlow({
  run,
  steps,
  selected,
  busy,
  open,
}: {
  run: RunView;
  steps: Step[];
  selected?: string;
  busy: boolean;
  open: (name: string, focusOnMobile: boolean) => void;
}) {
  const status = run.summary.status;
  const live =
    status === 'running' || status === 'waiting' || !!run.quotaRetryAt;
  const stage = run.stepId && steps.find((s) => s.id === run.stepId);
  const pending =
    live && run.stepId && !run.results.includes(run.stepId + '.md');
  if (!run.results.length && !pending) return null;
  return (
    <ol className={styles.files} aria-label="문서 생성 순서">
      {run.results.map((name, index) => {
        const title = steps.find((step) => step.id + '.md' === name)?.title;
        const isSelected = selected === name;
        return (
          <li key={name}>
            <button
              type="button"
              aria-label={name}
              title={title ? title + ' · ' + name : name}
              aria-pressed={isSelected}
              aria-disabled={busy}
              onClick={(event) => {
                if (!busy) open(name, event.detail !== 0);
              }}
            >
              {title && <strong>{title}</strong>}
              <span>
                {index + 1}. {name}
                {isSelected && <small> · 읽는 중</small>}
              </span>
            </button>
          </li>
        );
      })}
      {pending && (
        <li aria-current="step">
          <div className={styles.pendingFile}>
            <strong>{stage ? stage.title : run.stepId}</strong>
            <span>
              {run.quotaRetryAt
                ? '한도 대기'
                : status === 'waiting'
                  ? '사용자 확인 대기'
                  : '진행 중'}
            </span>
          </div>
        </li>
      )}
    </ol>
  );
}

function stageStatus(
  run: RunView,
  item: Step,
  index: number,
  currentIndex: number,
) {
  const status = run.summary.status;
  const decision = run.summary.lastReview;
  if (index === currentIndex && run.quotaRetryAt) return '한도 대기';
  if (index === currentIndex && activeStatuses.has(status)) {
    if (run.gate) return run.gate.kind === 'review' ? '승인 대기' : '답변 대기';
    return runLabels[status];
  }
  if (decision?.stepId === item.id && item.kind === 'review')
    return { accept: '승인 완료', decline: '거절', finish: '세션 마침' }[
      decision.decision
    ];
  if (index === currentIndex && (status === 'failed' || status === 'stopped'))
    return runLabels[status];
  if (run.results.includes(item.id + '.md') || status === 'completed')
    return '완료';
  if (status === 'unknown') return '확인 필요';
  if (currentIndex < 0) return status === 'queued' ? '시작 전' : '확인 필요';
  return index < currentIndex ? '완료' : '시작 전';
}

function RunHistory({
  openEvidence,
  record,
  executionSteps,
  openLog,
  run,
  disabled,
  editDisabled,
  editStep,
  onInstructionsSaved,
  rerun,
}: {
  openEvidence: (file: string, quote: string) => void;
  record: WorkflowVersion | null;
  executionSteps: Step[];
  run: RunView | null;
  openLog: boolean;
  disabled: boolean;
  editDisabled: boolean;
  editStep: (stepId: string) => void;
  onInstructionsSaved: () => void;
  rerun: (stepId: string, instructions: string) => void;
}) {
  const rerunDescriptionId = useId();
  const saveDescriptionId = useId();
  const savingRef = useRef(false);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [instructionSaveError, setInstructionSaveError] = useState('');
  const [instructionSaveResult, setInstructionSaveResult] = useState<{
    title: string;
    version: number;
  } | null>(null);
  const [targetId, setTargetId] = useState('');
  const [instructions, setInstructions] = useState('');
  const [expanded, setExpanded] = useState(openLog);
  const logHeading = useRef<HTMLElement>(null);
  const [events, setEvents] = useState<
    ReturnType<typeof runEventsSchema.parse>
  >([]);
  const [logError, setLogError] = useState('');
  const id = run?.summary.id,
    status = run?.summary.status,
    step = run?.stepId;
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
  useEffect(() => {
    if (openLog && id) {
      logHeading.current?.focus({ preventScroll: true });
      logHeading.current?.scrollIntoView({ block: 'center' });
    }
  }, [openLog, id]);
  const { saved, refresh } = useSavedVersion(run?.summary.workflowId);
  if (!run) return null;
  const outdated =
    !!instructionSaveResult ||
    (!!saved && saved.version !== run.summary.workflowVersion);
  const steps = record ? orderedSteps(record.definition) : [];
  const targetTask = steps.find(
    (item) => item.id === targetId && item.kind === 'task' && !item.workflowRef,
  );
  const editedInstructions = instructions.trim();
  const changed =
    targetTask?.kind === 'task' &&
    !!editedInstructions &&
    targetTask.instructions !== editedInstructions;

  async function saveInstructions() {
    if (!record || !targetTask || savingRef.current) return;
    savingRef.current = true;
    setSavingInstructions(true);
    setInstructionSaveError('');
    try {
      const response = await localRequest('/workflows/' + record.id, 'PUT', {
        baseVersion: record.version,
        definition: {
          ...record.definition,
          steps: record.definition.steps.map((item) =>
            item.id === targetTask.id
              ? { ...item, instructions: editedInstructions }
              : item,
          ),
        },
      });
      const updated = workflowVersionSchema.parse(await response.json());
      setInstructionSaveResult({
        title: targetTask.title,
        version: updated.version,
      });
      onInstructionsSaved();
    } catch (error) {
      setInstructionSaveError(message(error));
    } finally {
      refresh();
      savingRef.current = false;
      setSavingInstructions(false);
    }
  }
  const currentIndex = executionSteps.findIndex((item) => item.id === step);
  const targetIndex = targetId
    ? executionSteps.findIndex((item) => item.id === targetId)
    : -1;
  let rerunStart = targetIndex;
  while (rerunStart > 0 && executionSteps[rerunStart - 1]?.kind === 'review') {
    rerunStart -= 1;
  }
  const executionPlan =
    record && executionSteps.length
      ? workflowPlan({
          ...record.definition,
          steps: executionSteps,
          links: chain(executionSteps),
        }).steps
      : [];
  const inputDocumentIds = executionPlan[targetIndex]?.inputs ?? [];
  const reusedResults =
    rerunStart >= 0
      ? executionSteps.slice(0, rerunStart).flatMap((item) => {
          const file = item.id + '.md';
          return item.kind === 'task' && run.results.includes(file)
            ? [file]
            : [];
        })
      : [];
  return (
    <>
      {run.summary.status === 'completed' &&
        steps.some((s) => s.kind === 'review' && s.startNextSession) && (
          <p role="status">
            {run.summary.nextSessionId
              ? '이번 세션을 마치고 다음 세션을 시작했습니다.'
              : '이번 세션에서 개선 루프를 마쳤습니다.'}
          </p>
        )}
      {executionSteps.some(
        (s) => s.kind === 'review' && s.startNextSession,
      ) && (
        <AutoSession
          handoffOnly={
            !executionSteps.some(
              (s) => s.kind === 'task' && s.tool === 'workplot-ui',
            )
          }
          canRestart={
            run.summary.status === 'completed' &&
            !run.summary.nextSessionId &&
            !run.summary.master &&
            run.summary.lastReview?.decision === 'finish' &&
            run.results.length > 0
          }
          openEvidence={openEvidence}
          canRetry={!!run?.failureId}
          id={run.summary.id}
          canConfigure={['queued', 'running', 'waiting'].includes(
            run.summary.status,
          )}
        />
      )}
      {!run.summary.master &&
        executionSteps.some(
          (s) => s.kind === 'review' && s.startNextSession,
        ) && <SessionRequests summary={run.summary} />}
      <h3>실행 순서 · v{run.summary.workflowVersion}</h3>
      <ol className={styles.sequence}>
        {executionSteps.map((item, index) => {
          const planned = executionPlan[index];
          const previous = executionSteps[index - 1];
          const next = executionSteps[index + 1];
          const consumers = executionPlan.filter((stage) =>
            stage.inputs.includes(item.id),
          );
          return (
            <li
              key={item.id}
              aria-current={
                index === currentIndex &&
                (activeStatuses.has(run.summary.status) || run.quotaRetryAt)
                  ? 'step'
                  : undefined
              }
            >
              <details>
                <summary>
                  <span className={styles.stageLine}>
                    <strong title={item.title || item.id}>
                      {item.title || item.id}
                    </strong>
                    <small>
                      {item.kind === 'review' ? '검토' : '작업'} ·{' '}
                      {stageStatus(run, item, index, currentIndex)}
                    </small>
                  </span>
                </summary>
                <dl>
                  <dt>실행 당시 지침</dt>
                  <dd style={{ whiteSpace: 'pre-wrap' }}>
                    {item.kind === 'task'
                      ? item.instructions
                      : '사용자가 문서를 검토하고 승인합니다.'}
                  </dd>
                  <dt>실행 순서 연결</dt>
                  <dd>
                    {previous?.title || previous?.id || '시작'} →{' '}
                    {item.title || item.id} → {next?.title || next?.id || '끝'}
                  </dd>
                  <dt>입력 문서</dt>
                  <dd>
                    {planned?.inputs.map((id) => id + '.md').join(', ') ||
                      '연결된 입력 문서 없음'}
                  </dd>
                  <dt>출력 문서</dt>
                  <dd>{planned?.output ?? '없음'}</dd>
                  <dt>출력을 전달받는 단계</dt>
                  <dd>
                    {consumers
                      .map((stage) => stage.title || stage.id)
                      .join(', ') || '없음'}
                  </dd>
                </dl>
                {steps.some((stage) => stage.id === item.id) ? (
                  <button
                    type="button"
                    disabled={editDisabled}
                    onClick={() => editStep(item.id)}
                  >
                    최신 저장본에서 이 단계 편집
                  </button>
                ) : (
                  <p>연결된 워크플로에 속한 단계입니다.</p>
                )}
              </details>
            </li>
          );
        })}
      </ol>
      {record && (
        <RunWireComparison record={record} saved={saved} refresh={refresh} />
      )}
      {run.summary.origin && (
        <p>
          <a href={'#/runs/' + run.summary.origin.runId}>이전 실행 보기</a> ·
          변경 단계{' '}
          {steps.find((item) => item.id === run.summary.origin?.stepId)
            ?.title ?? run.summary.origin.stepId}
        </p>
      )}
      {status === 'completed' && record && !run.retention?.expired && (
        <details>
          <summary>단계 지침 저장 또는 다시 실행</summary>
          {saved && outdated && !instructionSaveResult && (
            <p role="status">
              최신 저장본은 v{saved.version}입니다. 지침을 변경하려면 최신 저장
              흐름을 여세요.
            </p>
          )}
          <fieldset className={styles.rerunFields}>
            <label>
              변경할 단계
              <select
                value={targetId}
                disabled={savingInstructions}
                onChange={(e) => {
                  const task = steps.find((s) => s.id === e.target.value);
                  setInstructionSaveError('');
                  setTargetId(task?.id ?? '');
                  setInstructions(
                    task?.kind === 'task' ? task.instructions : '',
                  );
                }}
              >
                <option value="">단계 선택</option>
                {steps
                  .filter((s) => s.kind === 'task' && !s.workflowRef)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
              </select>
            </label>
            {targetId && (
              <>
                <label>
                  새 작업 지침
                  <textarea
                    value={instructions}
                    disabled={savingInstructions}
                    maxLength={8000}
                    onChange={(e) => setInstructions(e.target.value)}
                  />
                </label>
                <p id={saveDescriptionId}>
                  대상 단계 · {targetTask?.title}. 새 흐름 버전으로 저장됩니다.
                  이후 최신 저장본으로 시작하는 실행에 적용됩니다. 지금은 새
                  실행이 시작되지 않습니다.
                </p>
                <button
                  type="button"
                  aria-describedby={saveDescriptionId}
                  disabled={
                    editDisabled ||
                    !saved ||
                    outdated ||
                    savingInstructions ||
                    !changed
                  }
                  onClick={saveInstructions}
                >
                  {savingInstructions ? '저장 중…' : '작성 지침만 저장'}
                </button>
                {instructionSaveError && (
                  <p role="alert">{instructionSaveError}</p>
                )}
                <p role="status">
                  {instructionSaveResult &&
                    `작성 지침 저장됨 · v${instructionSaveResult.version} · ${instructionSaveResult.title}`}
                </p>
                {targetIndex >= 0 ? (
                  <dl>
                    <dt>선택한 작업의 입력 문서</dt>
                    <dd>
                      {inputDocumentIds.length
                        ? inputDocumentIds.map((id) => id + '.md').join(', ')
                        : '앞 단계에서 전달받는 문서 없음'}
                    </dd>
                    <dt>재사용할 앞 단계 결과</dt>
                    <dd>{reusedResults.join(', ') || '없음'}</dd>
                    <dt>다시 수행할 단계</dt>
                    <dd>
                      <ol start={rerunStart + 1}>
                        {executionSteps.slice(rerunStart).map((item) => (
                          <li key={item.id}>{item.title || item.id}</li>
                        ))}
                      </ol>
                    </dd>
                  </dl>
                ) : (
                  <p>
                    펼친 실행 순서를 불러오면 다시 수행할 범위를 표시합니다.
                  </p>
                )}
                {!outdated && targetIndex >= 0 && (
                  <p id={rerunDescriptionId}>
                    바꾼 지침은 새 흐름 버전으로 저장되며, 이후 최신 저장본으로
                    시작하는 실행에 적용됩니다.
                  </p>
                )}
                <button
                  type="button"
                  aria-describedby={
                    !outdated && targetIndex >= 0
                      ? rerunDescriptionId
                      : undefined
                  }
                  disabled={
                    disabled ||
                    outdated ||
                    savingInstructions ||
                    targetIndex < 0 ||
                    !changed
                  }
                  onClick={() => rerun(targetId, instructions.trim())}
                >
                  지침 저장하고 이 단계부터 다시 실행
                </button>
              </>
            )}
          </fieldset>
        </details>
      )}
      {!run.retention?.expired && (
        <details
          open={expanded}
          onToggle={(e) => setExpanded(e.currentTarget.open)}
        >
          <summary ref={logHeading}>실행 로그</summary>
          {logError ? (
            <p>{logError}</p>
          ) : (
            <ol
              className={styles.log}
              role="list"
              aria-label="최근 실행 이벤트"
            >
              {events.map((event, i) => {
                const next = events[i + 1];
                const eventStep = executionSteps.find(
                  (s) => s.id === event.stepId,
                );
                const missingApproval =
                  event.status === 'waiting' &&
                  event.gate === 'review' &&
                  eventStep?.kind === 'review' &&
                  !eventStep.startNextSession &&
                  next &&
                  (next.stepId !== event.stepId ||
                    next.status === 'completed') &&
                  !events.some(
                    (e) => e.stepId === event.stepId && e.reviewCompleted,
                  );
                return (
                  <li key={i}>
                    <span className={styles.logNumber} aria-hidden="true">
                      {i + 1}
                    </span>
                    <time dateTime={event.at}>
                      {new Date(event.at).toLocaleTimeString('ko-KR')}
                    </time>
                    <div className={styles.logEntry}>
                      <div>
                        <strong>{eventStep?.title ?? event.stepId}</strong> ·{' '}
                        <span className={styles.logStatus}>
                          {event.reviewCompleted
                            ? '승인 완료'
                            : event.reviewDeclined
                              ? '거절됨'
                              : runLabels[event.status]}
                        </span>
                      </div>
                      {missingApproval && (
                        <p className={styles.logNote}>
                          승인 완료 여부를 확인할 수 없음
                        </p>
                      )}
                      {event.status === 'failed' && (
                        <p className={styles.failureReason}>
                          <strong>실패 사유</strong>{' '}
                          {event.failureReason ??
                            '저장된 실패 사유가 없습니다.'}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </details>
      )}
    </>
  );
}
