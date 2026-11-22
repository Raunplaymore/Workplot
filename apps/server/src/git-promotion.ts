import type Database from 'better-sqlite3';
import type { GitPromotion, PromotionDecision } from '@studio/contracts';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git } from './git-worktree.js';
import { verifyGitLocation, inspectGit } from './git-target.js';
import { checkCandidate } from './git-candidate-check.js';
import { StoreConflict, type StudioStore } from './studio-store.js';

type Status = GitPromotion['status'];
const note = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createGitPromotions(db: Database.Database, store: StudioStore) {
  db.exec(`CREATE TABLE IF NOT EXISTS git_promotions(master TEXT PRIMARY KEY REFERENCES master_runs(id),lane TEXT NOT NULL,status TEXT NOT NULL,record TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS busy_git_promotion ON git_promotions(lane) WHERE status IN ('applying','checking');`);
  function saved(master: string) {
    const row = db
      .prepare('SELECT record FROM git_promotions WHERE master=?')
      .pluck()
      .get(master) as string | undefined;
    return row ? (JSON.parse(row) as GitPromotion) : null;
  }
  function view(master: string): GitPromotion | null {
    const previous = saved(master);
    if (previous) return previous;
    const jobs = store.gitQueue.list(master);
    if (
      store.masterStopped(master) ||
      jobs.some((j) => j.status === 'queued' || j.status === 'checking')
    )
      return null;
    const job = jobs.filter((j) => j.status === 'verified').at(-1);
    if (!job?.candidate) return null;
    return {
      run: job.run,
      ticket: job.run,
      expected: job.base,
      candidate: job.candidate,
      status: job.base === job.candidate ? 'unchanged' : 'ready',
      detail: '',
      checks: '',
      approvedAt: null,
      appliedAt: null,
    };
  }
  function record(master: string, row: GitPromotion) {
    const target = store.run(row.run).summary.requestFiles!.gitTarget!;
    db.prepare(
      `INSERT INTO git_promotions VALUES(?,?,?,?) ON CONFLICT(master) DO UPDATE SET status=excluded.status,record=excluded.record`,
    ).run(
      master,
      target.checkoutId + '/' + target.branch,
      row.status,
      JSON.stringify(row),
    );
    return row;
  }
  const begin = db.transaction(
    (
      master: string,
      decision: PromotionDecision,
      action: 'approve' | 'recheck',
    ) => {
      const row = view(master);
      if (
        !row ||
        row.ticket !== decision.ticket ||
        row.expected !== decision.expected ||
        row.candidate !== decision.candidate
      )
        throw new StoreConflict();
      if (
        action === 'approve' &&
        (row.status === 'applied' || row.status === 'applying')
      )
        return { row, claimed: false };
      if (store.masterStopped(master)) throw new StoreConflict();
      const allowed: Status[] =
        action === 'approve' ? ['ready', 'blocked'] : ['stale', 'failed'];
      if (!allowed.includes(row.status)) throw new StoreConflict();
      const t = store.run(row.run).summary.requestFiles!.gitTarget!;
      if (
        db
          .prepare(
            "SELECT 1 FROM git_promotions WHERE lane=? AND status IN ('applying','checking')",
          )
          .get(t.checkoutId + '/' + t.branch)
      )
        throw new StoreConflict();
      return {
        claimed: true,
        row: record(master, {
          ...row,
          status: action === 'approve' ? 'applying' : 'checking',
          detail: '',
          approvedAt: action === 'approve' ? new Date().toISOString() : null,
        }),
      };
    },
  ).immediate;
  function context(row: GitPromotion) {
    const s = store.run(row.run).summary,
      t = s.requestFiles!.gitTarget!;
    const tree = store.worktree(s.developmentTaskId!);
    if (!tree?.ready) throw Error('검증 작업 폴더를 확인할 수 없습니다.');
    const pool = dirname(dirname(tree.directory));
    return {
      t,
      pool,
      common: join(pool, 'repo.git'),
      receipt: 'refs/workplot/receipts/' + row.ticket,
      ref: 'refs/heads/' + t.branch,
    };
  }
  async function received(row: GitPromotion) {
    const t = store.run(row.run).summary.requestFiles!.gitTarget!;
    const receipt = 'refs/workplot/receipts/' + row.ticket;
    const location = await inspectGit(t.root);
    if (
      location?.checkoutId !== t.checkoutId ||
      location.repositoryId !== t.repositoryId
    )
      throw Error('등록한 원본 저장소를 확인할 수 없습니다.');
    try {
      const value = (
        await git(t.root, 'rev-parse', '--verify', '--quiet', receipt)
      ).trim();
      if (value !== row.candidate)
        throw Error(
          '기존 승인 기록의 후보 SHA가 다릅니다. 원본의 승인 기록을 확인하세요.',
        );
      return true;
    } catch (e) {
      if ((e as { code?: number }).code === 1) return false;
      throw e;
    }
  }
  function applied(master: string, row: GitPromotion) {
    return record(master, {
      ...row,
      status: 'applied',
      detail: '',
      appliedAt: new Date().toISOString(),
    });
  }
  async function approve(master: string, decision: PromotionDecision) {
    const { row, claimed } = begin(master, decision, 'approve');
    if (!claimed) return row;
    let sending = false;
    try {
      if (await received(row)) return applied(master, row);
      const { t, common, receipt, ref } = context(row);
      const observed = await verifyGitLocation(t, t.path);
      if (observed.sha !== row.expected)
        return record(master, {
          ...row,
          status: 'stale',
          detail:
            '검증 후 원본 커밋이 바뀌었습니다. 현재 원본으로 재검사하세요.',
        });
      if (observed.dirty)
        throw Error(
          '원본에 미커밋 변경이 있습니다. 변경을 정리한 뒤 승인하세요.',
        );
      const gitPath = (
        await git(t.root, 'rev-parse', '--absolute-git-dir')
      ).trim();
      for (const name of [
        'MERGE_HEAD',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        'rebase-merge',
        'rebase-apply',
        'sequencer',
        'BISECT_START',
      ]) {
        if (
          await access(join(gitPath, name)).then(
            () => true,
            () => false,
          )
        )
          throw Error('원본에서 진행 중인 Git 작업을 마친 뒤 승인하세요.');
      }
      if (
        (await realpath(common)) !== common ||
        (
          await git(
            common,
            'rev-parse',
            '--verify',
            'refs/workplot/verified/' + row.run + '/' + row.candidate,
          )
        ).trim() !== row.candidate
      )
        throw Error('검증된 후보 커밋을 확인할 수 없습니다.');
      await git(
        common,
        'merge-base',
        '--is-ancestor',
        row.expected,
        row.candidate,
      );
      // updateInstead protects tracked edits, but Git may overwrite an ignored path.
      const ignored = (
        await git(
          t.root,
          'ls-files',
          '--others',
          '--ignored',
          '--exclude-standard',
          '--directory',
          '-z',
        )
      )
        .split('\0')
        .filter(Boolean)
        .map((p) => p.replace(/\/$/, ''));
      const paths = (
        await git(
          common,
          'diff',
          '--no-renames',
          '--name-only',
          '-z',
          row.expected,
          row.candidate,
        )
      )
        .split('\0')
        .filter(Boolean);
      // Sparse and assume-unchanged entries can hide local edits from git status.
      const hidden = (await git(t.root, 'ls-files', '-v', '-z'))
        .split('\0')
        .filter((entry) => /^[a-zS] /.test(entry))
        .map((entry) => entry.slice(2));
      const overlap = [...ignored, ...hidden].find((p) =>
        paths.some(
          (f) => f === p || f.startsWith(p + '/') || p.startsWith(f + '/'),
        ),
      );
      if (overlap)
        throw Error(
          '원본에서 Git이 변경을 추적하지 않는 경로와 겹칩니다: ' + overlap,
        );
      if (store.masterStopped(master))
        throw Error('마스터 실행이 중단되었습니다.');
      sending = true;
      await git(
        common,
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.file.allow=always',
        'push',
        '--atomic',
        '--no-verify',
        '--no-follow-tags',
        '--recurse-submodules=no',
        '--force-with-lease=' + ref + ':' + row.expected,
        '--force-with-lease=' + receipt + ':',
        '--receive-pack=git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c receive.denyDeletes=true -c receive.denyNonFastForwards=true -c receive.denyCurrentBranch=updateInstead receive-pack',
        pathToFileURL(t.root).href,
        row.candidate + ':' + ref,
        row.candidate + ':' + receipt,
      );
      return applied(master, row);
    } catch (e) {
      if (sending) {
        // A lost Git response can follow a successful transaction. Keep the intent on read failure.
        try {
          if (await received(row)) return applied(master, row);
          const { t } = context(row);
          if ((await verifyGitLocation(t, t.path)).sha !== row.expected)
            return record(master, {
              ...row,
              status: 'stale',
              detail: '반영 중 원본이 이동했습니다. 재검사가 필요합니다.',
            });
        } catch (readError) {
          return record(master, {
            ...row,
            status: 'blocked',
            detail: '원본 확인 대기 · ' + note(readError),
          });
        }
      }
      return record(master, { ...row, status: 'blocked', detail: note(e) });
    }
  }
  async function recheck(master: string, decision: PromotionDecision) {
    const { row } = begin(master, decision, 'recheck');
    let scratch: string | undefined,
      stage: string | undefined,
      common: string | undefined;
    try {
      const ctx = context(row);
      const { t, pool } = ctx;
      common = ctx.common;
      const observed = await verifyGitLocation(t, t.path);
      if ((await realpath(common)) !== common)
        throw Error('관리 저장소가 이동했습니다.');
      await git(
        common,
        '-c',
        'protocol.file.allow=always',
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        t.root,
        observed.sha,
      );
      const job = store.gitQueue.list(master).find((j) => j.run === row.run)!;
      await git(
        common,
        'merge-base',
        '--is-ancestor',
        job.base,
        observed.sha,
      ).catch(() => {
        throw Error(
          '원본의 기준 이력이 교체됐습니다. 새 기준에서 개발 작업을 시작하세요.',
        );
      });
      const source = job.candidate!;
      const merged = (
        await git(common, 'merge-tree', '--write-tree', observed.sha, source)
      ).trim();
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(merged))
        throw Error('재검사 후보를 만들 수 없습니다.');
      if (
        merged ===
        (await git(common, 'rev-parse', observed.sha + '^{tree}')).trim()
      )
        return record(master, {
          ...row,
          status: 'unchanged',
          detail: '원본에 후보의 변경이 이미 있습니다.',
        });
      const candidate = (
        await git(
          common,
          'commit-tree',
          merged,
          '-p',
          observed.sha,
          '-p',
          source,
          '-m',
          'Workplot recheck ' + row.run,
        )
      ).trim();
      scratch = await mkdtemp(join(pool, 'recheck-'));
      stage = join(scratch, 'checkout');
      await git(common, 'worktree', 'add', '--detach', stage, candidate);
      const checks = await checkCandidate(
        common,
        observed.sha,
        candidate,
        stage,
        scratch,
        new AbortController().signal,
      );
      if ((await verifyGitLocation(t, t.path)).sha !== observed.sha)
        throw Error('검사 도중 원본이 다시 이동했습니다. 재검사하세요.');
      await git(
        common,
        'update-ref',
        'refs/workplot/verified/' + row.run + '/' + candidate,
        candidate,
      );
      return record(master, {
        ...row,
        ticket: randomUUID(),
        expected: observed.sha,
        candidate,
        status: 'ready',
        detail: '재검사를 통과했습니다. 새 후보를 승인하세요.',
        checks,
        approvedAt: null,
      });
    } catch (e) {
      const f = e as { stdout?: string };
      return record(master, {
        ...row,
        status: 'failed',
        detail: (f.stdout || note(e)).slice(-16000),
      });
    } finally {
      if (stage && common)
        await git(common, 'worktree', 'remove', '--force', stage).catch(
          () => {},
        );
      if (scratch)
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
  async function recover() {
    const rows = db
      .prepare(
        "SELECT master FROM git_promotions WHERE status IN ('applying','checking')",
      )
      .pluck()
      .all() as string[];
    for (const master of rows) {
      const row = saved(master)!;
      if (row.status === 'checking') {
        record(master, {
          ...row,
          status: 'failed',
          detail: '서버 재시작으로 검사가 중단됐습니다. 재검사하세요.',
        });
        continue;
      }
      try {
        if (await received(row)) {
          applied(master, row);
          continue;
        }
        const { t } = context(row),
          observed = await verifyGitLocation(t, t.path);
        record(master, {
          ...row,
          status: observed.sha === row.expected ? 'blocked' : 'stale',
          detail:
            '원본에서 반영 기록을 찾지 못했습니다. 현재 기준을 확인하세요.',
        });
      } catch (e) {
        record(master, {
          ...row,
          status: 'blocked',
          detail: '반영 기록 확인 대기 · ' + note(e),
        });
      }
    }
  }
  return { view, approve, recheck, recover };
}
