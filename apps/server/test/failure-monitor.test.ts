import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { inspectGit } from '../src/git-target.js';
import * as checks from '../src/git-candidate-check.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, vi } from 'vitest';
import { openStudioStore } from '../src/studio-store.js';
import { createRunService } from '../src/run-service.js';
import { createDelegation } from '../src/delegation.js';
import {
  createFailureMonitor,
  installFailureMonitor,
} from '../src/failure-monitor.js';
import { codexCallContext, RunnerError } from '../src/codex-runner.js';

it.each([false, true])(
  'dispatches one Astra workflow per failed step and bounds failed recovery (%s)',
  async (failRepair) => {
    const db = new Database(':memory:'),
      store = openStudioStore(db),
      dir = await mkdtemp(join(tmpdir(), 'workplot-monitor-'));
    const flow = installFailureMonitor(db, store),
      id = randomUUID();
    expect(installFailureMonitor(db, store)).toBe(flow);
    let originals = 0;
    const models: string[] = [];
    const runs = createRunService(
      store,
      {
        ready: async () => '1.0.0',
        async write(prompt) {
          const step = JSON.parse(prompt).currentStepId;
          if (step === 'original') {
            if (++originals === 1) throw new RunnerError('output');
          } else {
            models.push(codexCallContext.getStore()?.settings?.model ?? '');
            if (failRepair) throw new RunnerError('output');
          }
          return {
            kind: 'document',
            text: step === 'verify-repair' ? '검증 통과' : '작업 결과',
          };
        },
      },
      dir,
      () => false,
    );
    const delegation = createDelegation(db, store, runs, vi.fn()),
      monitor = createFailureMonitor(db, store, runs, delegation);
    try {
      const wf = store.createWorkflow({
        name: '원본',
        steps: [
          {
            kind: 'task',
            id: 'original',
            title: '원본 단계',
            instructions: '작업',
            position: { x: 0, y: 0 },
          },
        ],
        links: [],
      });
      await runs.start(id, wf.id, 1);
      await vi.waitFor(() =>
        expect(runs.view(id).summary.status).toBe('failed'),
      );
      await Promise.all([monitor.tick(), monitor.tick()]);
      const report = store.recoveryReport(id)!;
      expect(report.state).toBe('복구 실행 중');
      await vi.waitFor(() =>
        expect(runs.view(report.repair).summary.status).toBe(
          failRepair ? 'failed' : 'completed',
        ),
      );
      await monitor.tick();
      if (!failRepair) {
        await vi.waitFor(() =>
          expect(runs.view(id).summary.status).toBe('completed'),
        );
        await monitor.tick();
      }
      expect(store.recoveryReport(id)?.state).toBe(
        failRepair ? '복구 중단 · 검토 필요' : '복구 확인',
      );
      expect(originals).toBe(failRepair ? 1 : 2);
      expect(new Set(models)).toEqual(new Set(['gpt-6.2-astra']));
      expect(
        db.prepare('SELECT count(*) FROM failure_monitor').pluck().get(),
      ).toBe(1);
    } finally {
      await monitor.close();
      await delegation.close();
      await runs.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it('reuses the verified repair commit on the original worktree without a second commit', async () => {
  const db = new Database(':memory:'),
    store = openStudioStore(db),
    dir = await mkdtemp(join(tmpdir(), 'workplot-repair-git-')),
    repo = join(dir, 'source');
  const id = randomUUID(),
    flow = installFailureMonitor(db, store);
  const check = vi
    .spyOn(checks, 'checkCandidate')
    .mockResolvedValue('후보 검사 통과');
  let originalChecks = 0;
  const runs = createRunService(
    store,
    {
      ready: async () => '1.0.0',
      async write(
        prompt,
        _signal,
        _observe,
        _tool,
        _evidence,
        _images,
        workDir,
      ) {
        const step = JSON.parse(prompt).currentStepId;
        if (step === 'draft')
          await writeFile(join(workDir!, 'change.txt'), 'original edit');
        if (step === 'check') {
          originalChecks++;
          return { kind: 'document', text: '검증 보류' };
        }
        if (step === 'repair')
          await writeFile(join(workDir!, 'repair.txt'), 'repair');
        return {
          kind: 'document',
          text: step === 'verify-repair' ? '검증 통과' : '완료',
        };
      },
    },
    dir,
    () => false,
  );
  const delegation = createDelegation(db, store, runs, vi.fn()),
    m = createFailureMonitor(db, store, runs, delegation);
  try {
    await mkdir(repo);
    execFileSync('git', ['-C', repo, 'init', '-qb', 'main']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=QA',
      '-c',
      'user.email=qa@localhost',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'base',
    ]);
    const target = store.bind('QA', (await inspectGit(repo))!);
    const wf = store.createWorkflow({
      name: '원본',
      steps: [
        {
          id: 'draft',
          kind: 'task',
          title: '작성',
          workspaceAccess: 'write',
          instructions: '작성',
          position: { x: 0, y: 0 },
        },
        {
          id: 'check',
          kind: 'task',
          tool: 'verified-commit',
          title: '검증',
          instructions: '검증',
          position: { x: 200, y: 0 },
        },
      ],
      links: [{ from: 'draft', to: 'check' }],
    });
    await runs.start(id, wf.id, 1, undefined, undefined, {
      references: [],
      workspace: repo,
      gitTarget: target,
    });
    await vi.waitFor(() => expect(runs.view(id).summary.status).toBe('failed'));
    await m.tick();
    const repair = store.recoveryReport(id)!.repair;
    await vi.waitFor(
      () => expect(runs.view(repair).summary.status).toBe('completed'),
      { timeout: 5000 },
    );
    expect(runs.view(repair).summary.workflowId).toBe(flow);
    await m.tick();
    await vi.waitFor(() =>
      expect(runs.view(id).summary.status).toBe('completed'),
    );
    await m.tick();
    expect(originalChecks).toBe(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(await runs.artifact(id, 'check.md')).toContain(
      '복구 실행에서 검증된 커밋 · ' + store.worktree(id)!.head,
    );
    expect(store.recoveryReport(id)?.state).toBe('복구 확인');
  } finally {
    await m.close();
    await delegation.close();
    await runs.close();
    check.mockRestore();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
