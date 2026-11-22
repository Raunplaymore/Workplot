import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git } from './git-worktree.js';
import { verifyGit } from './git-target.js';
import { checkCandidate } from './git-candidate-check.js';
import {
  StoreConflict,
  StoreNotFound,
  type StudioStore,
} from './studio-store.js';

export function createGitIntegration(store: StudioStore) {
  const queue = store.gitQueue;
  const workers = new Map<string, Promise<void>>();
  const active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  let closing = false;
  async function processEntry(
    job: NonNullable<ReturnType<typeof queue.next>>,
    parent: string,
    signal: AbortSignal,
  ) {
    const summary = store.run(job.run).summary;
    const target = summary.requestFiles!.gitTarget!;
    let stage: string | undefined,
      scratch: string | undefined,
      candidate: string | null = null,
      common: string | undefined;
    const files: string[] = [];
    try {
      signal.throwIfAborted();
      await verifyGit(target, target.path, false);
      const worktree = store.worktree(summary.developmentTaskId!)!;
      // G2 owns this pool outside the original source. Only use its recorded task directory.
      const pool = dirname(dirname(worktree.directory));
      common = join(pool, 'repo.git');
      if (
        (await realpath(common)) !== common ||
        (await git(common, 'rev-parse', '--is-bare-repository')).trim() !==
          'true'
      )
        throw Error('관리 저장소가 이동했습니다.');
      if (parent !== job.base) {
        const ancestor = (
          await git(common, 'merge-base', parent, job.base)
        ).trim();
        if (ancestor === parent) {
          parent = job.base;
          queue.setParent(job.sequence, parent);
        } else if (ancestor !== job.base)
          throw Error(
            '대상 기준 커밋이 달라져 이전 통합 후보를 이어갈 수 없습니다.',
          );
      }
      await git(common, 'merge-base', '--is-ancestor', job.base, job.source);
      let treeId: string;
      try {
        treeId = (
          await git(
            common,
            'merge-tree',
            '--write-tree',
            '--name-only',
            '--no-messages',
            '-z',
            parent,
            job.source,
          )
        )
          .split('\0')[0]!
          .trim();
      } catch (error) {
        const failure = error as { code?: number; stdout?: string };
        if (failure.code !== 1 || !failure.stdout) throw error;
        const conflicts = failure.stdout.split('\0').slice(1).filter(Boolean);
        if (!conflicts.length) throw error;
        queue.finish(
          job.sequence,
          'conflict',
          null,
          conflicts,
          '같은 변경을 자동 병합할 수 없습니다.',
        );
        return;
      }
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(treeId))
        throw Error('병합 결과 트리를 확인할 수 없습니다.');
      const previousTree = (
        await git(common, 'rev-parse', parent + '^{tree}')
      ).trim();
      candidate =
        treeId === previousTree
          ? parent
          : (
              await git(
                common,
                'commit-tree',
                treeId,
                '-p',
                parent,
                '-p',
                job.source,
                '-m',
                'Workplot integration ' + job.run,
              )
            ).trim();
      await git(
        common,
        'update-ref',
        'refs/workplot/attempts/' + job.run,
        candidate,
      );
      const records = (
        await git(
          common,
          'diff',
          '--name-status',
          '-M',
          '-z',
          parent,
          candidate,
        )
      ).split('\0');
      for (let i = 0; records[i];) {
        const status = records[i++]!,
          name = records[i++]!;
        files.push(
          status +
            ' ' +
            name +
            (/^[RC]/.test(status) ? ' → ' + records[i++] : ''),
        );
      }
      const attempts = join(pool, 'checks');
      await mkdir(attempts, { recursive: true, mode: 0o700 });
      if ((await realpath(attempts)) !== attempts)
        throw Error('검사 폴더가 이동했습니다.');
      scratch = await mkdtemp(join(attempts, job.run + '-'));
      stage = join(scratch, 'checkout');
      await git(common, 'worktree', 'add', '--detach', stage, candidate);
      const log = await checkCandidate(
        common,
        job.base,
        candidate,
        stage,
        scratch,
        signal,
      );
      signal.throwIfAborted();
      // An immutable private ref keeps the exact tested commit reachable. SQLite selects the lane tip.
      await git(
        common,
        'update-ref',
        'refs/workplot/verified/' + job.run + '/' + candidate,
        candidate,
      );
      signal.throwIfAborted();
      queue.finish(
        job.sequence,
        'verified',
        candidate,
        files,
        log.slice(-16000),
      );
    } catch (e) {
      queue.finish(
        job.sequence,
        signal.aborted ? 'stopped' : 'failed',
        candidate,
        files,
        (e instanceof Error ? e.message : String(e)).slice(-16000),
      );
    } finally {
      if (stage && common)
        await git(common, 'worktree', 'remove', '--force', stage).catch(
          () => {},
        );
      if (scratch)
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
  function wake(lane: string) {
    if (workers.has(lane) || closing) return;
    const worker = (async () => {
      while (!closing) {
        const job = queue.next(lane);
        if (!job) break;
        if (store.masterStopped(job.master)) {
          queue.stop(job.master);
          continue;
        }
        const parent = queue.lastVerified(lane) ?? job.base;
        if (!queue.claim(job.sequence, parent)) break;
        const controller = new AbortController();
        const done = processEntry(job, parent, controller.signal);
        active.set(job.master, { controller, done });
        try {
          await done;
        } finally {
          active.delete(job.master);
        }
      }
    })().finally(() => workers.delete(lane));
    workers.set(lane, worker);
  }
  function submit(master: string) {
    if (
      !queue.registered(master) ||
      store.masterStopped(master) ||
      queue.list(master).length
    )
      return;
    const children = store.masterRun(master)!.children;
    const runs = children.map((c) => store.run(c.runId).summary);
    if (!runs.every((s) => s.status === 'completed')) return;
    const target = runs[0]!.requestFiles!.gitTarget!;
    const lane = target.checkoutId + '/' + target.branch;
    queue.enqueue(
      master,
      lane,
      children.map((c, i) => {
        const snapshot = store.worktree(runs[i]!.developmentTaskId!);
        return {
          run: c.runId,
          task: c.taskId,
          base: target.sha,
          source: snapshot?.head ?? target.sha,
        };
      }),
    );
    wake(lane);
  }
  return {
    submit,
    request(master: string) {
      const batch = store.masterRun(master);
      if (!batch) throw new StoreNotFound();
      if (
        store.masterStopped(master) ||
        !batch.children.every((c) => {
          const s = store.run(c.runId).summary;
          return (
            s.isolatedGit &&
            s.status === 'completed' &&
            s.developmentTaskId &&
            store.worktree(s.developmentTaskId)?.ready
          );
        })
      )
        throw new StoreConflict();
      queue.register(master);
      submit(master);
      return queue.list(master);
    },
    recover() {
      queue.recover();
      for (const master of queue.batches()) submit(master);
      for (const lane of queue.queuedLanes()) wake(lane);
    },
    async stop(master: string) {
      queue.stop(master);
      const current = active.get(master);
      current?.controller.abort();
      await current?.done;
    },
    async close() {
      closing = true;
      await Promise.all(workers.values());
    },
    pending: (master: string) =>
      queue
        .list(master)
        .some((r) => r.status === 'checking' || r.status === 'queued'),
  };
}
