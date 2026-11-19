import { createHash, randomUUID } from 'node:crypto';
import { constants, writeSync } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  orderedSteps,
  workflowPlan,
  runEventsSchema,
  type RunDecision,
  type RunInput,
  type RunView,
  type RetryCheckpoint,
} from '@studio/contracts';
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
  done?: Promise<void>;
  logDescriptor?: number;
  storageFailed?: boolean;
  sessionId: string | null;
  process: RunInput['process'];
};

const terminal = new Set(['completed', 'stopped', 'failed', 'unknown']);
const failureText = {
  login: '터미널에서 Codex의 ChatGPT 로그인을 확인하세요.',
  cli: 'Codex를 실행하지 못했습니다. 설치와 로그인 상태를 확인하세요.',
  output: 'Codex가 유효한 문서 또는 질문을 반환하지 않았습니다.',
  termination: 'Codex 프로세스 종료를 확인하지 못했습니다.',
};

export function createRunService(
  store: StudioStore,
  runner: DocumentRunner,
  root: string,
) {
  const ownerId = randomUUID();
  let active: Execution | undefined;
  let closing = false;
  const blocked = () =>
    closing ||
    (!!active &&
      (!terminal.has(active.view.summary.status) ||
        active.view.summary.status === 'unknown'));

  function view(id: string): RunView {
    if (active?.view.summary.id === id) return active.view;
    const { summary, results, retry } = store.run(id);
    if (summary.status === 'failed' && retry)
      return {
        summary,
        results,
        stepId: retry.stepId,
        failureId: retry.failureId,
        note: null,
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

  function persist(
    execution: Execution,
    status: RunInput['status'],
    retry?: RetryCheckpoint,
  ) {
    const { summary, results } = execution.view;
    if (execution.logDescriptor !== undefined) {
      writeSync(
        execution.logDescriptor,
        JSON.stringify({
          status,
          stepId: execution.view.stepId,
          results,
          gate: execution.view.gate?.kind ?? null,
          at: new Date().toISOString(),
        }) + '\n',
      );
    }
    execution.view.summary = store.updateRun(summary.id, {
      status,
      results,
      sessionId: execution.sessionId,
      process: execution.process,
      retry,
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
    resume?: { stepId: string; documents: Map<string, Document> },
  ) {
    const { controller, view: state } = execution;
    const signal = controller.signal;
    const id = state.summary.id;
    let log;
    let retryableTask = false;
    const produced = resume?.documents ?? new Map<string, Document>();
    try {
      const directory = await folder(id, !resume);
      log = await open(
        join(directory, 'events.jsonl'),
        resume
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
      if (resume) persist(execution, 'queued');
      let previous = [...produced.values()].at(-1);
      async function wait(kind: Gate['kind'], text: string) {
        signal.throwIfAborted();
        state.gate = { id: randomUUID(), kind, text };
        persist(execution, 'waiting');
        const decision = await new Promise<RunDecision | undefined>(
          (resolve) => {
            execution.decide = resolve;
          },
        );
        state.gate = null;
        signal.throwIfAborted();
        return decision;
      }
      const steps = orderedSteps(definition);
      const plan = workflowPlan(definition);
      const startIndex = resume
        ? steps.findIndex((step) => step.id === resume.stepId)
        : 0;
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
          const decision = await wait('review', step.title + detail);
          if (decision?.decision !== 'accept') {
            state.note = '검토에서 거절하여 다음 단계는 실행하지 않았습니다.';
            persist(execution, 'stopped');
            return;
          }
          if (previous && previous.text !== (await artifact(id, previous.file)))
            throw new RunnerError('output');
          continue;
        }
        let answer = '';
        for (let question = 0; ; question++) {
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
          const response = await runner.write(
            JSON.stringify({
              task: step.title,
              workflow: plan,
              currentStepId: step.id,
              instructions: step.instructions,
              skill:
                step.skill === 'source-check'
                  ? '제공된 자료의 사실을 보존하고, 필수 정보가 빠지거나 충돌하면 질문하세요.'
                  : '',
              source: definition.input ?? '',
              ...(step.inputFrom === undefined
                ? { priorDocument: documents[0]?.text ?? '' }
                : { inputDocuments: documents }),
              answer,
              response:
                '업무 목표와 완료 기준을 참고해 현재 단계만 수행하세요. 전달받은 문서는 입력 자료입니다. 파일·명령·웹 도구를 사용하지 마세요. Markdown 본문은 kind document, 꼭 필요한 확인 질문만 kind question으로 반환하세요.',
            }),
            signal,
            ({ pid, sessionId }) => {
              if (pid) execution.process = { ownerId, pid };
              if (sessionId) execution.sessionId = sessionId;
              try {
                persist(execution, 'running');
              } catch {
                execution.storageFailed = true;
                controller.abort();
              }
            },
          );
          signal.throwIfAborted();
          if (response.kind === 'question') {
            if (question >= 2) throw new RunnerError('output');
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
      persist(execution, 'completed');
    } catch (error) {
      state.gate = null;
      const reason = error instanceof RunnerError ? error.reason : 'output';
      const status =
        reason === 'termination' || execution.storageFailed
          ? 'unknown'
          : signal.aborted
            ? 'stopped'
            : 'failed';
      state.note =
        status === 'stopped' ? '작업이 중단됐습니다.' : failureText[reason];
      if (execution.storageFailed)
        state.note = '실행 정보를 저장하지 못했습니다. 종료 상태를 확인하세요.';
      try {
        const retry =
          status === 'failed' && retryableTask && state.stepId
            ? {
                failureId: randomUUID(),
                stepId: state.stepId,
                documentHashes: [...produced.values()].map((doc) =>
                  hash(doc.text),
                ),
              }
            : undefined;
        persist(execution, status, retry);
        if (retry) state.failureId = retry.failureId;
      } catch {
        state.summary = { ...state.summary, status: 'unknown' };
        state.note = '저장소 오류로 종료 상태를 기록하지 못했습니다.';
      }
    } finally {
      execution.logDescriptor = undefined;
      await log?.close().catch(() => {});
    }
  }

  return {
    view,
    list: () =>
      store.listRuns().map((row) => ({
        ...row,
        status:
          active?.view.summary.id === row.id
            ? active.view.summary.status
            : terminal.has(row.status)
              ? row.status
              : ('unknown' as const),
      })),
    artifact,
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
    async start(id: string, workflowId: string, version: number) {
      function existing() {
        try {
          const found = view(id);
          if (
            found.summary.workflowId !== workflowId ||
            found.summary.workflowVersion !== version
          )
            throw new StoreConflict();
          return found;
        } catch (error) {
          if (!(error instanceof StoreNotFound)) throw error;
        }
      }
      const existingRun = existing();
      if (existingRun) return existingRun;
      if (blocked()) throw new StoreConflict();
      const { definition } = store.workflow(workflowId, version);
      if (
        !definition.steps.some((step) => step.kind === 'task') ||
        definition.steps.some(
          (step) => step.kind === 'task' && step.agent === 'unassigned',
        )
      )
        throw new RunnerError('output');
      const cliVersion = await runner.ready();
      const duplicate = existing();
      if (duplicate) return duplicate;
      if (blocked()) throw new StoreConflict();
      const summary = store.recordRun(
        {
          workflowId,
          workflowVersion: version,
          cliVersion,
          status: 'queued',
          sessionId: null,
          process: null,
          results: [],
        },
        id,
      );
      const execution: Execution = {
        view: { summary, results: [], gate: null, stepId: null, note: null },
        controller: new AbortController(),
        sessionId: null,
        process: null,
      };
      active = execution;
      execution.done = run(execution, definition);
      return execution.view;
    },
    async retry(id: string, failureId: string) {
      const record = store.run(id);
      const { retry, results, summary } = record;
      const eligible = () =>
        !blocked() && store.run(id).retry?.failureId === failureId;
      if (!retry || summary.status !== 'failed' || !eligible())
        throw new StoreConflict();
      const { definition } = store.workflow(
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
      active = execution;
      execution.done = run(execution, definition, {
        stepId: retry.stepId,
        documents,
      });
      return execution.view;
    },
    decide(id: string, decision: RunDecision) {
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
        (gate.kind === 'question') !== (decision.decision === 'answer')
      )
        throw new StoreConflict();
      active.lastGate = decision;
      const resolve = active.decide;
      active.decide = undefined;
      active.view.gate = null;
      resolve(decision);
      return active.view;
    },
    async stop(id: string) {
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
      if (active) await this.stop(active.view.summary.id);
    },
  };
}
