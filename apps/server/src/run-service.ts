import { verifyGit, inspectGit } from './git-target.js';
import {
  AttachmentError,
  snapshotFiles,
  checkWorkspace,
} from './request-files.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname } from 'node:path';
import { createGitIntegration } from './git-integration.js';
import { manageWorktrees } from './git-worktree.js';
import type { GitTarget, RequestFiles } from '@studio/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { constants, writeSync } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  requiredInputFields,
  missingInputFields,
  orderedSteps,
  workflowPlan,
  runEventsSchema,
  type RunDecision,
  type RunInput,
  type RunMaterial,
  type RunView,
  type RetryCheckpoint,
  type PausedReview,
} from '@studio/contracts';
import { repeatsUnchangedChecks } from './repeated-checks.js';
import { discoveryBrief, shots } from './visual-discovery.js';
import { integrateUiSources } from './master-integration.js';
import { readUiSources, runUiWork, selectUiTask } from './ui-work.js';
import { readDesignSkill } from './design-skills.js';
import { RunnerError, type DocumentRunner } from './codex-runner.js';
import {
  StoreConflict,
  StoreNotFound,
  type StudioStore,
} from './studio-store.js';

type Gate = NonNullable<RunView['gate']>;
type Document = { file: string; text: string };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
type Execution = {
  view: RunView;
  controller: AbortController;
  decide?: (decision: RunDecision | undefined) => void;
  lastGate?: RunDecision;
  delegatedBrief?: string;
  redirected?: boolean;
  done?: Promise<void>;
  logDescriptor?: number;
  storageFailed?: boolean;
  review?: PausedReview;
  restored?: boolean;
  suspended?: boolean;
  sessionId: string | null;
  process: RunInput['process'];
};

const terminal = new Set(['completed', 'stopped', 'failed', 'unknown']);
const failureText = {
  timeout: 'Codex 응답 제한 시간에 도달했습니다.',
  quota: 'Codex 사용 한도에 도달했습니다.',
  ui_edit: '화면 작업본에서 변경 범위를 확인할 수 없습니다.',
  ui_browser:
    'Chromium으로 화면 작업본을 열지 못했습니다. 브라우저 설치와 작업본을 확인하세요.',
  ui_check: '화면 작업본의 타입 검사 또는 빌드가 실패했습니다.',
  review_changed:
    '승인 대기 당시의 문서와 일치하지 않아 검토를 복원할 수 없습니다.',
  login: '터미널에서 Codex의 ChatGPT 로그인을 확인하세요.',
  cli: 'Codex를 실행하지 못했습니다. 설치와 로그인 상태를 확인하세요.',
  output: 'Codex가 유효한 문서 또는 질문을 반환하지 않았습니다.',
  task_skill:
    '연결한 Codex 스킬을 읽을 수 없거나 저장 당시와 달라졌습니다. 스킬을 복원하거나 흐름에서 다시 연결하세요.',
  termination: 'Codex 프로세스 종료를 확인하지 못했습니다.',
};

export function createRunService(
  store: StudioStore,
  runner: DocumentRunner,
  root: string,
  expired: (id: string) => boolean,
) {
  const ownerId = randomUUID();
  const executions = new Map<string, Execution>();
  let closing = false;
  let integrationTail: Promise<void> = Promise.resolve();
  const integrationControllers = new Map<string, AbortController>();
  const integrating = new Map<
    string,
    Promise<ReturnType<StudioStore['integrationReport']>>
  >();
  async function checkedSources(id: string, step: string) {
    const files = await readUiSources(
      join(await folder(id), 'ui-' + step, 'src'),
    );
    if (store.uiDigest(id, step) !== hash(JSON.stringify(files)))
      throw new Error('검증 후 작업본 소스가 변경됐습니다.');
    return files;
  }
  function integrate(id: string) {
    if (store.masterStopped(id)) throw new StoreConflict();
    const pending = integrating.get(id);
    if (pending) return pending;
    const master = store.masterRun(id);
    if (!master) throw new StoreNotFound();
    const baseline = store.masterSources(id);
    if (
      !baseline ||
      master.children.some(
        (c) => store.run(c.runId).summary.status !== 'completed',
      )
    )
      throw new StoreConflict();
    const previous = store.integrationReport(id);
    if (previous?.status === 'verified' || previous?.status === 'unchanged')
      return Promise.resolve(previous);
    const controller = new AbortController();
    integrationControllers.set(id, controller);
    const work = integrationTail
      .then(async () => {
        try {
          controller.signal.throwIfAborted();
          const branches = [];
          for (const child of master.children) {
            const { summary, results } = store.run(child.runId);
            const def = store.executionDefinition(
              summary.workflowId,
              summary.workflowVersion,
            );
            const ui = orderedSteps(def)
              .filter((s) => s.kind === 'task' && s.tool === 'workplot-ui')
              .at(-1);
            if (ui && !results.includes(ui.id + '.md'))
              throw new StoreConflict();
            const files = ui
              ? await checkedSources(child.runId, ui.id)
              : baseline;
            branches.push({ id: child.taskId, files });
          }
          const report = await integrateUiSources(
            root,
            baseline,
            branches,
            controller.signal,
          );
          if (!controller.signal.aborted) store.saveIntegration(id, report);
          return report;
        } catch (e) {
          const report = {
            status: 'failed',
            reason: e instanceof Error ? e.message : '통합 실패',
          };
          if (!controller.signal.aborted) store.saveIntegration(id, report);
          return report;
        }
      })
      .finally(() => {
        integrating.delete(id);
        integrationControllers.delete(id);
      });
    integrationTail = work.then(
      () => {},
      () => {},
    );
    integrating.set(id, work);
    return work;
  }
  function occupied(execution: Execution) {
    const status = execution.view.summary.status;
    return !terminal.has(status) || status === 'unknown';
  }
  const gitIntegration = createGitIntegration(store);
  const worktrees = manageWorktrees(store, root);
  const blocked = (isolatedTask?: string) => {
    const active = [...executions.values()].filter(occupied);
    if (closing || !isolatedTask) return closing || active.length > 0;
    return (
      active.length >= 2 ||
      active.some(
        ({ view: { summary: s } }) =>
          !s.isolatedGit ||
          s.master ||
          s.status === 'unknown' ||
          s.developmentTaskId === isolatedTask,
      )
    );
  };
  async function verifyBinding(target: GitTarget, folder: string) {
    if (
      !store
        .bindings()
        .some(
          (b) =>
            b.serviceId === target.serviceId &&
            b.service === target.service &&
            b.path === target.path &&
            b.checkoutId === target.checkoutId &&
            b.repositoryId === target.repositoryId,
        )
    )
      throw new AttachmentError('등록한 서비스와 체크아웃을 다시 선택하세요.');
    await verifyGit(target, folder, true);
  }
  function track(execution: Execution) {
    for (const [id, entry] of executions)
      if (!occupied(entry)) executions.delete(id);
    executions.set(execution.view.summary.id, execution);
  }

  function view(id: string): RunView {
    const active = executions.get(id);
    if (active?.view.summary.id === id && !expired(id)) return active.view;
    const { summary, results, retry } = store.run(id);
    if (summary.status === 'failed' && retry)
      return {
        summary,
        results,
        stepId: retry.stepId,
        failureId: retry.failureId,
        quotaRetryAt: retry.quotaRetryAt,
        timedOut: retry.timedOut,
        note:
          retry.failureNote ?? (retry.timedOut ? failureText.timeout : null),
        gate: null,
      };
    if (terminal.has(summary.status))
      return { summary, results, stepId: null, note: null, gate: null };
    return {
      summary: { ...summary, status: 'unknown' },
      results,
      stepId: null,
      note: '서버가 이전 실행의 종료를 확인하지 못했습니다.',
      gate: null,
    };
  }

  function logEvent(
    execution: Execution,
    status: RunInput['status'],
    reviewCompleted = false,
  ) {
    const { results } = execution.view;
    if (execution.logDescriptor !== undefined) {
      writeSync(
        execution.logDescriptor,
        JSON.stringify({
          status,
          stepId: execution.view.stepId,
          results,
          gate: execution.view.gate?.kind ?? null,
          ...(reviewCompleted && { reviewCompleted: true }),
          ...(status === 'stopped' &&
            execution.view.summary.lastReview?.decision === 'decline' &&
            execution.view.stepId ===
              execution.view.summary.lastReview.stepId && {
              reviewDeclined: true,
            }),
          ...(status === 'failed' &&
            execution.view.note && { failureReason: execution.view.note }),
          at: new Date().toISOString(),
        }) + '\n',
      );
    }
  }
  function persist(
    execution: Execution,
    status: RunInput['status'],
    retry?: RetryCheckpoint,
    completedHashes?: string[],
  ) {
    const { summary, results } = execution.view;
    logEvent(execution, status);
    execution.view.summary = store.updateRun(summary.id, {
      status,
      results,
      sessionId: execution.sessionId,
      process: execution.process,
      retry,
      completedHashes,
    });
  }

  async function folder(id: string, create = false) {
    const realRoot = await realpath(resolve(root));
    const runs = join(realRoot, 'runs');
    if (create) await mkdir(runs, { recursive: true, mode: 0o700 });
    if (!(await lstat(runs)).isDirectory() || (await realpath(runs)) !== runs)
      throw new RunnerError('output');
    const directory = join(runs, id);
    if (create) await mkdir(directory, { mode: 0o700 });
    if (
      !(await lstat(directory)).isDirectory() ||
      (await realpath(directory)) !== directory
    )
      throw new RunnerError('output');
    return directory;
  }

  async function artifact(id: string, filename: string) {
    if (!view(id).results.includes(filename)) throw new StoreNotFound();
    return readRunFile(id, filename);
  }
  async function captureDirectory(id: string, file: string) {
    const { summary, results } = view(id);
    if (expired(id) || !results.includes(file)) throw new StoreNotFound();
    const definition = store.executionDefinition(
      summary.workflowId,
      summary.workflowVersion,
    );
    const step = definition.steps.find(
      (s) =>
        s.kind === 'task' && s.tool === 'workplot-ui' && s.id + '.md' === file,
    );
    if (!step) return null;
    return join(await folder(id), 'ui-' + step.id);
  }

  async function captureFile(directory: string, phase: string, image: string) {
    if (!shots.includes(image) || !['before', 'after'].includes(phase))
      throw new StoreNotFound();
    const parent = phase === 'before' ? join(directory, 'before') : directory;
    if ((await realpath(parent)) !== parent) throw new StoreNotFound();
    const handle = await open(
      join(parent, image),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size < 8 ||
        stat.size > 10_000_000
      )
        throw new StoreNotFound();
      const signature = Buffer.alloc(8);
      await handle.read(signature, 0, 8, 0);
      if (signature.toString('hex') !== '89504e470d0a1a0a')
        throw new StoreNotFound();
      return handle;
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  async function readRunFile(id: string, filename: string, tail = false) {
    let handle;
    try {
      handle = await open(
        join(await folder(id), filename),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size === 0 ||
        (!tail && stat.size > 128_000)
      )
        throw new StoreNotFound();
      const bytes = Buffer.alloc(128_001);
      const offset = tail ? Math.max(0, stat.size - 128_000) : 0;
      const { bytesRead } = await handle.read(
        bytes,
        0,
        tail ? 128_000 : bytes.length,
        offset,
      );
      if (bytesRead === 0 || bytesRead > 128_000) throw new StoreNotFound();
      const content = bytes.subarray(0, bytesRead).toString('utf8');
      return offset ? content.slice(content.indexOf('\n') + 1) : content;
    } catch {
      throw new StoreNotFound();
    } finally {
      await handle?.close();
    }
  }

  async function run(
    execution: Execution,
    definition: ReturnType<StudioStore['workflow']>['definition'],
    resume?: {
      stepId: string;
      documents: Map<string, Document>;
      fresh?: boolean;
      answerContext?: string;
      questionCount?: number;
      retryCheckpoint?: RetryCheckpoint;
      restore?: { checkpoint: PausedReview; ready: () => void };
    },
  ) {
    const { controller, view: state } = execution;
    const signal = controller.signal;
    const id = state.summary.id;
    let imageFolder: string | undefined;
    let log;
    let retryableTask = false;
    let partialTree: Awaited<ReturnType<typeof worktrees.open>> | undefined;
    let answer = '',
      question = 0;
    const produced = resume?.documents ?? new Map<string, Document>();
    try {
      const material = store.run(id).material;
      const mission = definition.steps.some(
        (step) => step.kind === 'review' && step.startNextSession,
      )
        ? store.sessionMission(id)
        : '';
      const parent = state.summary.master;
      const masterPlan = parent && store.masterPlan(parent.planId);
      const masterContext =
        masterPlan && parent
          ? {
              masterTask: {
                ...parent,
                goal: masterPlan.goal,
                ...masterPlan.tasks.find((t) => t.id === parent.taskId),
              },
            }
          : {};
      const snapshot = state.summary.snapshotId
        ? store.requestSnapshot(state.summary.snapshotId)
        : undefined;
      const target = state.summary.requestFiles?.gitTarget;
      const isolated =
        state.summary.isolatedGit && state.summary.developmentTaskId && target;
      const workspace = snapshot?.workspace ?? target?.path;
      const references = snapshot?.refs.map(({ name, text }) =>
        text === undefined ? { name, kind: 'image' } : { name, text },
      );
      const images: string[] = [];
      for (const item of snapshot?.refs ?? []) {
        if (!item.image) continue;
        imageFolder ??= await mkdtemp(join(tmpdir(), 'workplot-references-'));
        const filename = join(imageFolder, images.length + extname(item.name));
        await writeFile(filename, Buffer.from(item.image, 'base64'), {
          mode: 0o600,
        });
        images.push(filename);
      }
      const taskRequest = state.summary.taskRequest;
      const requestContext = taskRequest
        ? {
            taskRequest,
            requestPolicy:
              '이번 작업 요청은 사용자가 지정한 과제다. 현재 단계의 역할과 승인 절차를 지키면서 이 과제를 수행한다. 후속 세션은 인계문을 참고해 같은 과제의 남은 수정이나 검증을 진행한다. 이미 충족했다면 완료 근거를 기록하고 종료를 권한다. 별도 과제를 고르지 않는다.',
          }
        : {};
      const missionContext = mission
        ? {
            originalMission: mission,
            sessionHandoff: state.summary.previousSessionId
              ? material?.source
              : undefined,
            missionPolicy:
              '인계문에는 달성한 결과와 근거, 시도한 접근과 확인한 실패 이유, 남은 범위와 다음 시작 지점을 기록한다. 확인하지 못한 원인은 미확인으로 둔다. 첫 세션의 originalMission이 전체 범위이고, 인계문은 이번 세션에서 먼저 수행할 과제다. 계획과 리뷰에서 이번 과제의 결과와 전체 미션의 남은 범위를 구분한다. 인계문을 작성할 때는 미검증 영역에서 원래 미션에 맞는 다음 과제를 고른다. 전체 미션 달성 여부는 확인한 근거로만 판단한다.',
          }
        : {};
      const append = resume && !resume.fresh;
      const directory = await folder(id, !append);
      log = await open(
        join(directory, 'events.jsonl'),
        append
          ? constants.O_WRONLY |
              constants.O_APPEND |
              constants.O_NOFOLLOW |
              constants.O_NONBLOCK
          : 'ax',
        0o600,
      );
      const stat = await log.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new RunnerError('output');
      execution.logDescriptor = log.fd;
      if (resume?.fresh) {
        for (const { file, text } of produced.values()) {
          signal.throwIfAborted();
          await writeFile(join(directory, file), text, {
            flag: 'wx',
            mode: 0o600,
          });
          state.results = [...state.results, file];
        }
      }
      const restore = resume?.restore;
      if (restore) {
        const steps = orderedSteps(definition);
        const index = steps.findIndex(
          (s) => s.id === resume.stepId && s.kind === 'review',
        );
        const sources = steps.slice(0, index).filter((s) => s.kind === 'task');
        if (
          index < 0 ||
          sources.length !== state.results.length ||
          sources.length !== restore.checkpoint.documentHashes.length
        )
          throw new RunnerError('review_changed');
        for (const [i, source] of sources.entries()) {
          const file = source.id + '.md';
          if (state.results[i] !== file)
            throw new RunnerError('review_changed');
          const text = await artifact(id, file).catch(() => {
            throw new RunnerError('review_changed');
          });
          if (hash(text) !== restore.checkpoint.documentHashes[i])
            throw new RunnerError('review_changed');
          produced.set(source.id, { file, text });
        }
      } else if (resume) persist(execution, 'queued');
      let previous = [...produced.values()].at(-1);
      async function wait(
        kind: Gate['kind'],
        text: string,
        nextSession = false,
      ) {
        signal.throwIfAborted();
        const recovering =
          execution.restored && restore?.checkpoint.stepId === state.stepId;
        const parentId = state.summary.previousSessionId;
        let repeatsSession: string | undefined;
        if (nextSession && parentId) {
          const work = definition.steps.filter(
            (s) => s.kind === 'task' && s.tool === 'workplot-ui',
          );
          const parent = store.run(parentId);
          if (work.length && parent.summary.nextSessionId === id) {
            const comparisons = await Promise.all(
              work.map(async (s) => {
                const doc = produced.get(s.id);
                if (!doc || !parent.results.includes(doc.file)) return false;
                return repeatsUnchangedChecks(
                  doc.text,
                  await artifact(parentId, doc.file),
                );
              }),
            );
            if (comparisons.every(Boolean)) repeatsSession = parentId;
          }
        }
        signal.throwIfAborted();
        state.gate = {
          id: recovering ? restore!.checkpoint.gateId : randomUUID(),
          kind,
          text,
          repeatsSession,
          ...(nextSession && { startNextSession: true as const }),
        };
        if (kind === 'review')
          execution.review = {
            gateId: state.gate.id,
            stepId: state.stepId!,
            documentHashes: [...produced.values()].map((doc) => hash(doc.text)),
          };
        if (!recovering) persist(execution, 'waiting');
        const decision = await new Promise<RunDecision | undefined>(
          (resolve) => {
            execution.decide = resolve;
            if (recovering) restore!.ready();
          },
        );
        state.gate = null;
        execution.review = undefined;
        signal.throwIfAborted();
        return decision;
      }
      const steps = orderedSteps(definition);
      const plan = workflowPlan(definition);
      const startIndex = resume
        ? steps.findIndex((step) => step.id === resume.stepId)
        : 0;
      let startSuccessor = false;
      for (let index = startIndex; index < steps.length; index++) {
        const step = steps[index]!;
        signal.throwIfAborted();
        state.stepId = step.id;
        if (step.kind === 'review') {
          if (previous && previous.text !== (await artifact(id, previous.file)))
            throw new RunnerError('output');
          const next = steps[index + 1];
          const detail =
            next?.kind === 'task'
              ? '\n다음 작업: ' + next.title + '\n' + next.instructions
              : '';
          if (
            step.startNextSession &&
            (!previous || previous.text.trim().length > 8000)
          )
            throw new RunnerError('output');
          const decision = await wait(
            'review',
            step.title + detail,
            step.startNextSession,
          );
          if (
            decision?.decision !== 'accept' &&
            !(step.startNextSession && decision?.decision === 'finish')
          ) {
            state.note = '검토에서 거절하여 다음 단계는 실행하지 않았습니다.';
            persist(execution, 'stopped');
            return;
          }
          if (previous && previous.text !== (await artifact(id, previous.file)))
            throw new RunnerError('output');
          if (!step.startNextSession) logEvent(execution, 'running', true);
          startSuccessor =
            !!step.startNextSession && decision?.decision === 'accept';
          continue;
        }
        answer = resume?.stepId === step.id ? (resume.answerContext ?? '') : '';
        for (
          question =
            resume?.stepId === step.id ? (resume.questionCount ?? 0) : 0;
          ;
          question++
        ) {
          signal.throwIfAborted();
          const documents = [];
          for (const source of plan.steps[index]!.inputs) {
            const document = produced.get(source);
            if (
              !document ||
              document.text !== (await artifact(id, document.file))
            )
              throw new RunnerError('output');
            documents.push({
              stepId: source,
              filename: document.file,
              text: document.text,
            });
          }
          signal.throwIfAborted();
          persist(execution, 'running');
          retryableTask = true;
          const boundSkill = step.codexSkill;
          const skill =
            boundSkill &&
            (await readDesignSkill(boundSkill.id).catch(() => {
              throw new RunnerError('task_skill');
            }));
          if (
            boundSkill &&
            (!skill ||
              skill.digest !== boundSkill.digest ||
              skill.title !== boundSkill.title)
          )
            throw new RunnerError('task_skill');
          signal.throwIfAborted();
          const evidence = steps
            .slice(0, index)
            .filter((s) => s.kind === 'task' && s.tool === 'workplot-ui')
            .map((s) => produced.get(s.id))
            .at(-1);
          // Entry into this task requires acceptance of its preceding review.
          // A rerun of this task starts at that gate; a retry checks document hashes.
          const preceding = steps[index - 1];
          const approval =
            preceding?.kind === 'review' && previous
              ? {
                  reviewStepId: preceding.id,
                  decision: 'accept',
                  document: previous.file,
                  sha256: hash(previous.text),
                }
              : undefined;
          const retryContext =
            resume?.retryCheckpoint && resume.stepId === step.id
              ? {
                  retryHandoff: {
                    runId: id,
                    workflowId: state.summary.workflowId,
                    workflowVersion: state.summary.workflowVersion,
                    resumeStepId: step.id,
                    failureId: resume.retryCheckpoint.failureId,
                    previousFailure: resume.retryCheckpoint.failureNote ?? null,
                    verifiedResults: [
                      ...(resume.documents?.values() ?? []),
                    ].map((doc) => ({
                      file: doc.file,
                      sha256: hash(doc.text),
                    })),
                  },
                }
              : {};
          const tree = isolated
            ? await worktrees.open(state.summary.developmentTaskId!, isolated)
            : undefined;
          const roleWrites = step.workspaceAccess
            ? step.workspaceAccess === 'write'
            : step.tool === 'workplot-ui' ||
              steps.filter((s) => s.kind === 'task').length === 1;
          const gitWrite =
            tree && roleWrites && step.tool !== 'market-calendar';
          if (target && !tree)
            throw new AttachmentError(
              '이 실행은 원본 폴더를 직접 사용한 이전 버전입니다. 기존 결과와 원본 변경을 확인한 뒤 독립 개발 작업을 새로 시작하세요.',
            );
          let callId: number | undefined;
          const observe: Parameters<DocumentRunner['write']>[2] = ({
            pid,
            sessionId,
          }) => {
            if (pid) execution.process = { ownerId, pid };
            if (sessionId) execution.sessionId = sessionId;
            try {
              if (state.summary.developmentTaskId) {
                if (pid) callId = store.startCall(id, step.id, pid);
                if (sessionId && callId) store.identifyCall(callId, sessionId);
              }
              persist(execution, 'running');
            } catch {
              execution.storageFailed = true;
              controller.abort();
            }
          };
          const source =
            evidence?.text ?? material?.source ?? definition.input ?? '';
          let taskSelection;
          if (
            !workspace &&
            !taskRequest &&
            index === 0 &&
            !state.summary.previousSessionId &&
            source.trim() === definition.input?.trim() &&
            source.startsWith(discoveryBrief + '\n') &&
            steps.some(
              (item) => item.kind === 'task' && item.tool === 'workplot-ui',
            )
          ) {
            const recent = [];
            for (const row of store.listRuns()) {
              if (
                row.id === id ||
                row.workflowId !== state.summary.workflowId ||
                expired(row.id)
              )
                continue;
              const names = store.run(row.id).results;
              const name = [
                'session-review.md',
                'change-evidence.md',
                'session-plan.md',
              ].find((file) => names.includes(file));
              if (!name) continue;
              recent.push({
                run: row.id,
                result: (await artifact(row.id, name)).slice(0, 1400),
              });
              if (recent.length === 5) break;
            }
            taskSelection = await selectUiTask(
              directory,
              source,
              recent,
              signal,
              observe,
            );
          }
          const prompt = JSON.stringify({
            ...masterContext,
            ...retryContext,
            approval,
            ...requestContext,
            ...(references?.length && { readOnlyReferences: references }),
            task: step.title,
            workflow: plan,
            ...missionContext,
            currentStepId: step.id,
            instructions: step.instructions,
            documentFormat:
              'Markdown 문서는 주제가 바뀔 때 빈 줄로 문단을 나눈다. 연속된 검사 결과나 단계는 항목마다 한 줄의 목록으로 쓴다. 전후 비교는 소제목으로 구분한다. 사용자가 지정한 출력 형식, 인용 원문, 표, 코드와 diff의 줄바꿈은 보존한다.',
            ...(skill && {
              taskSkill: {
                name: skill.title,
                instructions: skill.instructions,
              },
              skillUse:
                '현재 단계에서 이 스킬의 지침을 문서 작성에 적용하세요. 작업의 허용된 도구와 권한은 그대로입니다.',
            }),
            skill:
              step.skill === 'source-check'
                ? '제공된 자료의 사실을 보존하고, 필수 정보가 빠지거나 충돌하면 질문하세요.'
                : '',
            source,
            ...(taskSelection && {
              taskSelection,
              selectionPolicy:
                '이번 실행에서 직접 캡처한 화면의 finding과 최근 회차 대조를 계획의 근거로 삼으세요. 선택한 과제, 위치, 이유와 확인 기준을 전달하세요. file이 none이면 발견 근거 부족을 그대로 보고하세요.',
            }),
            ...((material || evidence) && {
              sourcePolicy: evidence
                ? '이번 실행의 실제 작업 기록과 inputDocuments가 판정 근거다. 계획과 예상을 관찰 결과로 취급하지 않는다.'
                : step.tool === 'market-calendar'
                  ? '여행 조건은 source, 운영일은 이번 공식 달력 조회 결과에서 확인하세요.'
                  : '이번 실행의 사실은 source에서만 가져오세요. 작업 지침에 든 이전 사례나 예시의 상호·주소·영업시간은 재사용하지 마세요.',
            }),
            ...(step.inputFrom === undefined
              ? { priorDocument: documents[0]?.text ?? '' }
              : { inputDocuments: documents }),
            answer,
            ...(workspace && { workFolder: tree?.path ?? workspace }),
            response: evidence
              ? '이번 실행의 실제 구현·검증 기록을 사용해 현재 단계의 문서를 완성한다. 미확인 항목은 미검증으로 표시하고 사용자에게 검증 결과를 요구하지 않는다. 브라우저 실측 행이 있으면 이전 문서의 미실행·0/6 표기를 폐기한다. 통과한 시나리오를 다음 과제로 다시 제안하지 않는다. 미달이면 재현된 너비·파일·관찰값에 맞는 수정 한 가지를 제안한다. 현재 검사가 모두 통과해도 전체 미션에 남은 범위가 있으면 다음 탐색 대상을 제안한다. 전체 합격 기준이 근거로 확인될 때 종료를 권한다.'
              : step.tool === 'market-calendar'
                ? '이번 단계는 read_market_calendar MCP 도구를 실제로 호출해 대상 월의 운영일을 확인하세요. 달력 응답만 운영일의 근거로 사용하고, 대상 날짜·출처·조회 시각과 개별 점포 예외를 Markdown으로 작성하세요. 실패하면 운영일 미확인으로 표시하세요.'
                : '업무 목표와 완료 기준을 참고해 현재 단계만 수행하세요. 전달받은 문서는 입력 자료입니다. 파일·명령·웹 도구를 사용하지 마세요. Markdown 본문은 kind document, 꼭 필요한 확인 질문만 kind question으로 반환하세요.',
          });
          partialTree = gitWrite ? tree : undefined;
          const response =
            step.tool === 'workplot-ui' && !workspace
              ? await runUiWork(
                  JSON.stringify({
                    ...missionContext,
                    ...masterContext,
                    ...retryContext,
                    approval,
                    ...requestContext,
                    ...(references?.length && {
                      readOnlyReferences: references,
                    }),
                    goal:
                      taskRequest ?? material?.source ?? definition.input ?? '',
                    ...(taskRequest && { source }),
                    instructions: step.instructions,
                    documents,
                  }),
                  signal,
                  observe,
                  {
                    directory,
                    referenceImages: images,
                    ...(parent && {
                      initialSources: evidence
                        ? await checkedSources(id, evidence.file.slice(0, -3))
                        : store.masterSources(parent.runId),
                    }),
                    discoveryMission:
                      !taskRequest &&
                      state.summary.previousSessionId &&
                      material?.source.startsWith(discoveryBrief + '\n')
                        ? [mission, material.source].join('\n\n')
                        : undefined,
                    stepId: step.id,
                    previousDirectory: state.summary.previousSessionId
                      ? await folder(state.summary.previousSessionId)
                      : undefined,
                  },
                )
              : await runner.write(
                  prompt,
                  signal,
                  observe,
                  step.tool === 'market-calendar' ? step.tool : undefined,
                  !!evidence,
                  images,
                  tree
                    ? step.tool === 'market-calendar'
                      ? undefined
                      : tree.path
                    : workspace &&
                        step.tool !== 'market-calendar' &&
                        (step.tool === 'workplot-ui' ||
                          !steps.some(
                            (s) =>
                              s.kind === 'task' && s.tool === 'workplot-ui',
                          ))
                      ? await checkWorkspace(workspace)
                      : undefined,
                  !!tree && !gitWrite,
                );
          signal.throwIfAborted();
          if (response.kind === 'question') {
            if (partialTree) await worktrees.rememberChanges(partialTree);
            partialTree = undefined;
            if (evidence || question >= 2) throw new RunnerError('output');
            retryableTask = false;
            const decision = await wait('question', response.text);
            if (decision?.decision !== 'answer')
              throw new RunnerError('output');
            answer +=
              JSON.stringify({
                question: response.text,
                answer: decision.answer,
              }) + '\n';
            continue;
          }
          if (!response.text.trim() || response.text.length > 32_000)
            throw new RunnerError('output');
          partialTree = undefined;
          if (gitWrite) {
            await worktrees.checkpoint(tree, id, step.id);
            signal.throwIfAborted();
          }
          if (parent && !tree && step.tool === 'workplot-ui') {
            const files = await readUiSources(
              join(directory, 'ui-' + step.id, 'src'),
            );
            store.recordUiDigest(id, step.id, hash(JSON.stringify(files)));
          }
          const file = step.id + '.md';
          const text = response.text + '\n';
          retryableTask = false;
          await writeFile(join(directory, file), text, {
            flag: 'wx',
            mode: 0o600,
          });
          state.results = [...state.results, file];
          if ((await artifact(id, file)) !== text)
            throw new RunnerError('output');
          previous = { file, text };
          produced.set(step.id, previous);
          persist(execution, 'running');
          break;
        }
      }
      signal.throwIfAborted();
      if (!previous || (await artifact(id, previous.file)) !== previous.text)
        throw new RunnerError('output');
      signal.throwIfAborted();
      const finish = () =>
        persist(
          execution,
          'completed',
          undefined,
          [...produced.values()].map((doc) => hash(doc.text)),
        );
      if (startSuccessor) {
        const child = store.recordNextSession(
          id,
          execution.redirected && execution.delegatedBrief
            ? execution.delegatedBrief
            : execution.delegatedBrief
              ? execution.delegatedBrief +
                '\n\n' +
                previous.text
                  .trim()
                  .slice(0, 7800 - execution.delegatedBrief.length)
              : previous.text.trim(),
          finish,
          execution.redirected,
        );
        launch(child, definition);
      } else {
        finish();
        if (parent) gitIntegration.submit(parent.runId);
        if (
          parent &&
          !store.masterStopped(parent.runId) &&
          store.masterSources(parent.runId) &&
          store
            .masterRun(parent.runId)
            ?.children.every(
              (c) => store.run(c.runId).summary.status === 'completed',
            )
        )
          void integrate(parent.runId);
      }
    } catch (error) {
      if (execution.suspended) return;
      state.gate = null;
      if (partialTree)
        await worktrees.rememberChanges(partialTree).catch(() => {});
      const reason = error instanceof RunnerError ? error.reason : 'output';
      const status =
        reason === 'termination' || execution.storageFailed
          ? 'unknown'
          : signal.aborted
            ? 'stopped'
            : 'failed';
      state.note =
        status === 'stopped'
          ? '작업이 중단됐습니다.'
          : error instanceof RunnerError
            ? error.exitSignal
              ? `Codex 프로세스가 ${error.exitSignal} 신호로 종료됐습니다.`
              : failureText[reason]
            : error instanceof AttachmentError
              ? error.message
              : null;
      if (execution.storageFailed)
        state.note = '실행 정보를 저장하지 못했습니다. 종료 상태를 확인하세요.';
      try {
        const retry =
          status === 'failed' && retryableTask && state.stepId
            ? {
                failureId: randomUUID(),
                ...(state.note && { failureNote: state.note.slice(0, 400) }),
                ...(reason === 'timeout' && { timedOut: true as const }),
                ...(error instanceof RunnerError &&
                  error.quotaRetryAt && { quotaRetryAt: error.quotaRetryAt }),
                ...(answer && {
                  answerContext: answer,
                  questionCount: question,
                }),
                stepId: state.stepId,
                documentHashes: [...produced.values()].map((doc) =>
                  hash(doc.text),
                ),
              }
            : undefined;
        persist(execution, status, retry);
        if (retry) {
          state.failureId = retry.failureId;
          state.timedOut = retry.timedOut;
          state.quotaRetryAt = retry.quotaRetryAt;
        }
      } catch {
        state.summary = { ...state.summary, status: 'unknown' };
        state.note = '저장소 오류로 종료 상태를 기록하지 못했습니다.';
      }
    } finally {
      execution.logDescriptor = undefined;
      await log?.close().catch(() => {});
      if (imageFolder) await rm(imageFolder, { recursive: true, force: true });
    }
  }

  function launch(
    summary: RunView['summary'],
    definition: ReturnType<StudioStore['workflow']>['definition'],
  ) {
    const execution: Execution = {
      view: { summary, results: [], gate: null, stepId: null, note: null },
      controller: new AbortController(),
      sessionId: null,
      process: null,
    };
    track(execution);
    execution.done = run(execution, definition);
    return execution.view;
  }

  return {
    async restoreReview() {
      const ids = store.pausedReviews();
      for (const id of ids) {
        const {
          summary,
          results,
          pausedReview: checkpoint,
          sessionId,
        } = store.run(id);
        if (!checkpoint) continue;
        const execution: Execution = {
          view: {
            summary,
            results,
            gate: null,
            stepId: checkpoint.stepId,
            note: null,
          },
          controller: new AbortController(),
          restored: true,
          sessionId,
          process: null,
        };
        const definition = store.executionDefinition(
          summary.workflowId,
          summary.workflowVersion,
        );
        track(execution);
        let restored!: () => void;
        const ready = new Promise<void>((resolve) => {
          restored = resolve;
        });
        execution.done = run(execution, definition, {
          stepId: checkpoint.stepId,
          documents: new Map(),
          restore: { checkpoint, ready: restored },
        });
        await Promise.race([ready, execution.done]);
        if (summary.master && store.masterStopped(summary.master.runId))
          await this.stop(id);
      }
    },
    view,
    canStart: () => !blocked(),
    list: () =>
      store.listRuns().map((row) => {
        const active = executions.get(row.id);
        return {
          ...row,
          ...(active?.view.summary.id === row.id &&
            active.view.gate && { gateKind: active.view.gate.kind }),
          status:
            active?.view.summary.id === row.id
              ? active.view.summary.status
              : terminal.has(row.status)
                ? row.status
                : ('unknown' as const),
        };
      }),
    artifact,
    async captureList(id: string, file: string) {
      const directory = await captureDirectory(id, file);
      if (!directory) return [];
      const images = [];
      for (const image of shots) {
        const phases = [];
        for (const phase of ['before', 'after']) {
          const handle = await captureFile(directory, phase, image).catch(
            () => null,
          );
          if (handle) {
            await handle.close();
            phases.push(phase);
          }
        }
        if (phases.length) images.push({ image, phases });
      }
      return images;
    },
    async capture(id: string, file: string, phase: string, image: string) {
      const directory = await captureDirectory(id, file);
      if (!directory) throw new StoreNotFound();
      const handle = await captureFile(directory, phase, image).catch(() => {
        throw new StoreNotFound();
      });
      try {
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    },
    preserveQuotaReview(id: string, gateId: string) {
      const active = executions.get(id);
      if (
        active?.view.summary.id !== id ||
        active.review?.gateId !== gateId ||
        !active.decide
      )
        throw new StoreConflict();
      store.saveReview(id, active.review);
      active.restored = true;
    },
    async reviewedArtifact(id: string, gateId: string, file: string) {
      const active = executions.get(id);
      const text = await artifact(id, file);
      const index = active?.view.results.indexOf(file) ?? -1;
      if (
        active?.view.summary.id !== id ||
        active.review?.gateId !== gateId ||
        index < 0 ||
        hash(text) !== active.review.documentHashes[index]
      )
        throw new StoreConflict();
      return text;
    },
    async events(id: string) {
      view(id);
      const log = await readRunFile(id, 'events.jsonl', true);
      return runEventsSchema.parse(
        log
          .trimEnd()
          .split('\n')
          .filter(Boolean)
          .slice(-100)
          .map((line) => JSON.parse(line)),
      );
    },
    async start(
      id: string,
      workflowId: string,
      version: number,
      material?: RunMaterial,
      taskRequest?: string,
      requestFiles?: RequestFiles,
    ) {
      function existing() {
        try {
          const found = view(id);
          if (
            found.summary.workflowId !== workflowId ||
            found.summary.workflowVersion !== version ||
            found.summary.taskRequest !== taskRequest ||
            JSON.stringify(found.summary.requestFiles) !==
              JSON.stringify(requestFiles) ||
            JSON.stringify(store.run(id).material) !== JSON.stringify(material)
          )
            throw new StoreConflict();
          return found;
        } catch (error) {
          if (!(error instanceof StoreNotFound)) throw error;
        }
      }
      const existingRun = existing();
      if (existingRun) return existingRun;
      store.allowUse(workflowId);
      const isolatedId = requestFiles?.gitTarget ? id : undefined;
      if (blocked(isolatedId)) throw new StoreConflict();
      const definition = store.executionDefinition(workflowId, version);
      if (
        !definition.steps.some((step) => step.kind === 'task') ||
        definition.steps.some(
          (step) => step.kind === 'task' && step.agent === 'unassigned',
        )
      )
        throw new RunnerError('output');
      const snapshot = requestFiles
        ? await snapshotFiles(requestFiles)
        : undefined;
      const target = requestFiles?.gitTarget;
      if (target && !snapshot?.workspace)
        throw new AttachmentError('등록한 대상 폴더를 확인하세요.');
      const cliVersion = await runner.ready();
      if (snapshot?.workspace) {
        if (target) {
          await verifyBinding(target, snapshot.workspace);
        } else if (await inspectGit(snapshot.workspace))
          throw new AttachmentError('Git 작업은 먼저 실행 대상을 확인하세요.');
      }
      const duplicate = existing();
      if (duplicate) return duplicate;
      if (blocked(isolatedId)) throw new StoreConflict();
      const record: RunInput = {
        developmentTaskId: isolatedId,
        isolatedGit: target ? true : undefined,
        requestFiles,
        snapshotId: snapshot ? id : undefined,
        workflowId,
        workflowVersion: version,
        material,
        taskRequest,
        cliVersion,
        status: 'queued',
        sessionId: null,
        process: null,
        results: [],
      };
      const summary = snapshot
        ? store.recordWithSnapshot(record, id, snapshot)
        : store.recordRun(record, id);
      return launch(summary, definition);
    },
    async verifiedCapture(id: string, name: string) {
      if (!shots.includes(name)) throw new StoreNotFound();
      const report = store.integrationReport(id);
      if (!report?.verifiedStage || !report.directory)
        throw new StoreNotFound();
      const base = resolve(root, 'master-integrations');
      const directory = resolve(report.directory);
      if (
        !/^candidate-[a-zA-Z0-9]+$/.test(directory.slice(base.length + 1)) ||
        !directory.startsWith(base + '/')
      )
        throw new StoreNotFound();
      const stage = resolve(report.verifiedStage);
      if (
        ![join(directory, 'stage-1'), join(directory, 'stage-2')].includes(
          stage,
        )
      )
        throw new StoreNotFound();
      const file = join(stage, name);
      if ((await realpath(file).catch(() => null)) !== file)
        throw new StoreNotFound();
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    },
    integrate,
    requestGitIntegration: gitIntegration.request,
    integrating: (id: string) =>
      integrating.has(id) || gitIntegration.pending(id),
    recoverIntegrations() {
      gitIntegration.recover();
      for (const id of store.unreportedUiMasters()) void integrate(id);
    },
    async startMaster(id: string, planId: string, target?: GitTarget) {
      const existing = () => {
        const row = store.masterRun(id);
        if (store.masterStopped(id)) throw new StoreConflict();
        if (
          row &&
          (row.planId !== planId ||
            JSON.stringify(
              store.run(row.children[0]!.runId).summary.requestFiles?.gitTarget,
            ) !== JSON.stringify(target))
        )
          throw new StoreConflict();
        return row;
      };
      const prior = existing();
      if (prior) return prior;
      const plan = store.masterPlan(planId);
      if (plan.tasks.length !== 2 || plan.tasks.some((t) => t.dependsOn.length))
        throw new RangeError('two_independent_tasks_required');
      const branches = plan.tasks.map((task) => {
        const wf = store.workflow(
          task.workflow.id,
          task.workflow.version,
        ).definition;
        const definition = store.executionDefinition(
          task.workflow.id,
          task.workflow.version,
        );
        store.allowUse(task.workflow.id);
        if (
          !definition.steps.some((s) => s.kind === 'task') ||
          definition.steps.some(
            (s) =>
              (s.kind === 'task' && s.agent === 'unassigned') ||
              (s.kind === 'review' && s.startNextSession),
          )
        )
          throw new RangeError('unsupported_child_workflow');
        const source = wf.input ?? '';
        if (missingInputFields(requiredInputFields(wf), source).length)
          throw new RangeError('missing_material');
        return {
          taskId: task.id,
          workflowId: task.workflow.id,
          version: task.workflow.version,
          definition,
        };
      });
      if (blocked()) throw new StoreConflict();
      if (target) await verifyBinding(target, target.path);
      const baseline =
        !target &&
        branches.some((b) =>
          b.definition.steps.some(
            (s) => s.kind === 'task' && s.tool === 'workplot-ui',
          ),
        )
          ? await readUiSources()
          : undefined;
      const version = await runner.ready();
      const duplicate = existing();
      if (duplicate) return duplicate;
      if (blocked()) throw new StoreConflict();
      const master = store.recordMasterRun(
        id,
        planId,
        version,
        branches,
        baseline,
        target,
      );
      for (const [index, child] of master.children.entries())
        launch(store.run(child.runId).summary, branches[index]!.definition);
      return master;
    },
    async rerun(id: string, stepId: string, instructions: string) {
      const source = store.run(id);
      const { workflowId, workflowVersion } = source.summary;
      const isolatedId = source.summary.isolatedGit
        ? source.summary.developmentTaskId
        : undefined;
      if (
        expired(id) ||
        source.summary.status !== 'completed' ||
        blocked(isolatedId)
      )
        throw new StoreConflict();
      const { definition } = store.workflow(workflowId, workflowVersion);
      const original = definition.steps.find((step) => step.id === stepId);
      if (
        original?.kind !== 'task' ||
        original.workflowRef ||
        original.instructions === instructions
      )
        throw new StoreConflict();
      original.instructions = instructions;
      const expanded = store.executionDefinition(workflowId, workflowVersion);
      const steps = orderedSteps(expanded);
      let index = steps.findIndex((step) => step.id === stepId);
      const target = steps[index];
      if (target?.kind !== 'task' || target.instructions === instructions)
        throw new StoreConflict();
      target.instructions = instructions;
      // A gate immediately before the changed task approved the old instructions.
      while (index > 0 && steps[index - 1]?.kind === 'review') index--;
      const documents = new Map<string, Document>();
      for (const step of steps.slice(0, index)) {
        if (step.kind !== 'task') continue;
        const file = step.id + '.md';
        if (source.results[documents.size] !== file) throw new StoreConflict();
        const text = await artifact(id, file);
        if (
          source.completedHashes &&
          source.completedHashes[documents.size] !== hash(text)
        )
          throw new StoreConflict();
        documents.set(step.id, { file, text });
      }
      const cliVersion = await runner.ready();
      if (blocked(isolatedId)) throw new StoreConflict();
      const summary = store.recordRerun(
        {
          workflowId,
          workflowVersion: workflowVersion + 1,
          cliVersion,
          status: 'queued',
          sessionId: null,
          process: null,
          results: [],
          origin: { runId: id, stepId },
          material: source.material,
          taskRequest: source.summary.taskRequest,
          isolatedGit: source.summary.isolatedGit,
          developmentTaskId: source.summary.developmentTaskId,
          requestFiles: source.summary.requestFiles,
          snapshotId: source.summary.snapshotId,
        },
        workflowVersion,
        definition,
      );
      const startStep = steps[index]!.id;
      const execution: Execution = {
        view: {
          summary,
          results: [],
          stepId: startStep,
          note: null,
          gate: null,
        },
        controller: new AbortController(),
        sessionId: null,
        process: null,
      };
      track(execution);
      execution.done = run(execution, expanded, {
        stepId: startStep,
        documents,
        fresh: true,
      });
      return execution.view;
    },
    async retry(id: string, failureId: string, authorized = () => true) {
      const record = store.run(id);
      const { retry, results, summary } = record;
      const eligible = () =>
        !closing &&
        (summary.isolatedGit && !summary.master
          ? !blocked(summary.developmentTaskId)
          : ![...executions.values()].some(
              (e) =>
                occupied(e) &&
                (!summary.master ||
                  e.view.summary.master?.runId !== summary.master.runId ||
                  e.view.summary.id === id ||
                  e.view.summary.status === 'unknown'),
            )) &&
        (!summary.master || !store.masterStopped(summary.master.runId)) &&
        authorized() &&
        store.run(id).retry?.failureId === failureId;
      if (!retry || summary.status !== 'failed' || !eligible())
        throw new StoreConflict();
      const definition = store.executionDefinition(
        summary.workflowId,
        summary.workflowVersion,
      );
      const steps = orderedSteps(definition);
      const index = steps.findIndex(
        (s) => s.id === retry.stepId && s.kind === 'task',
      );
      const sources = steps.slice(0, index).filter((s) => s.kind === 'task');
      if (
        index < 0 ||
        sources.length !== results.length ||
        sources.length !== retry.documentHashes.length
      )
        throw new StoreConflict();
      const documents = new Map<string, Document>();
      for (const [i, source] of sources.entries()) {
        const file = source.id + '.md';
        if (results[i] !== file) throw new StoreConflict();
        const text = await artifact(id, file);
        if (hash(text) !== retry.documentHashes[i]) throw new StoreConflict();
        documents.set(source.id, { file, text });
      }
      const directory = await folder(id);
      try {
        await lstat(join(directory, retry.stepId + '.md'));
        throw new StoreConflict();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if ((await runner.ready()) !== summary.cliVersion || !eligible())
        throw new StoreConflict();
      const execution: Execution = {
        view: {
          summary,
          results,
          stepId: retry.stepId,
          note: null,
          gate: null,
        },
        controller: new AbortController(),
        sessionId: null,
        process: null,
      };
      // Consume this failure before yielding so a second tab cannot queue another attempt.
      persist(execution, 'queued');
      track(execution);
      execution.done = run(execution, definition, {
        stepId: retry.stepId,
        documents,
        answerContext: retry.answerContext,
        questionCount: retry.questionCount,
        retryCheckpoint: retry,
      });
      return execution.view;
    },
    decide(
      id: string,
      decision: RunDecision,
      delegatedBrief?: string,
      redirect = false,
    ) {
      const active = executions.get(id);
      if (active?.view.summary.id !== id || active.controller.signal.aborted)
        throw new StoreConflict();
      if (
        active.lastGate?.gateId === decision.gateId &&
        JSON.stringify(active.lastGate) === JSON.stringify(decision)
      )
        return active.view;
      const gate = active.view.gate;
      if (
        !gate ||
        gate.id !== decision.gateId ||
        !active.decide ||
        (decision.decision === 'finish' && !gate.startNextSession) ||
        (gate.kind === 'question') !== (decision.decision === 'answer')
      )
        throw new StoreConflict();
      if (gate.kind === 'review' && decision.decision !== 'answer') {
        const receipt = {
          gateId: gate.id,
          stepId: active.view.stepId!,
          decision: decision.decision,
          at: new Date().toISOString(),
        };
        store.recordReviewDecision(id, receipt, !!active.restored);
        active.view.summary = { ...active.view.summary, lastReview: receipt };
        active.restored = false;
      }
      active.redirected = Boolean(
        (redirect || gate.repeatsSession) &&
        decision.decision === 'accept' &&
        delegatedBrief,
      );
      active.delegatedBrief =
        delegatedBrief ??
        (gate.repeatsSession && decision.decision === 'accept'
          ? '접근 변경: 이전 두 세션에서 소스 변경 없이 같은 검사 결과가 반복됐다. 미달 동작이 있으면 실제 처리 함수와 화면 파일을 먼저 대조한다. 직전 후보 파일이 그 동작을 소유하지 않으면 다른 파일을 선택한다. 수정 후 같은 검사로 전후를 비교하고 재현이 안 되면 첫 미션의 미검증 항목을 선택한다.'
          : undefined);
      active.lastGate = decision;
      const resolve = active.decide;
      active.decide = undefined;
      active.view.gate = null;
      resolve(decision);
      return active.view;
    },
    async stopMaster(id: string) {
      const master = store.masterRun(id);
      if (!master) throw new StoreNotFound();
      store.closeMaster(id);
      integrationControllers.get(id)?.abort();
      await Promise.all([
        gitIntegration.stop(id),
        ...master.children.map((child) => this.stop(child.runId)),
        integrating.get(id),
      ]);
      return { stopped: true };
    },
    async stop(id: string) {
      const active = executions.get(id);
      if (
        active?.view.summary.id !== id ||
        terminal.has(active.view.summary.status)
      )
        return view(id);
      const execution = active;
      execution.controller.abort();
      execution.decide?.(undefined);
      execution.decide = undefined;
      await execution.done;
      return execution.view;
    },
    async close() {
      closing = true;
      await Promise.all(
        [...executions.values()].map(async (active) => {
          if (
            active?.review &&
            active.decide &&
            active.view.gate?.kind === 'review'
          ) {
            store.saveReview(active.view.summary.id, active.review);
            active.suspended = true;
          }
          await this.stop(active.view.summary.id);
        }),
      );
      await integrationTail;
      await gitIntegration.close();
    },
  };
}
