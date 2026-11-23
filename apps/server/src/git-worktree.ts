import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { GitTarget } from '@studio/contracts';
import type { StudioStore } from './studio-store.js';
import { AttachmentError } from './request-files.js';

const exec = promisify(execFile);
const within = (parent: string, child: string) =>
  child === parent || child.startsWith(parent + sep);
function problem(message: string): never {
  throw new AttachmentError(message);
}
export async function git(cwd: string, ...args: string[]) {
  return (
    await exec(
      'git',
      [
        '--literal-pathspecs',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'user.name=Workplot',
        '-c',
        'user.email=workplot@localhost',
        '-C',
        cwd,
        ...args,
      ],
      {
        env: {
          PATH: process.env.PATH,
          LC_ALL: 'C',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
      },
    )
  ).stdout;
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
async function dirtyDigest(directory: string) {
  const status = await git(
    directory,
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '-z',
  );
  if (!status) return null;
  const digest = createHash('sha256')
    .update(status)
    .update(await git(directory, 'ls-files', '--stage', '-z'));
  const names = (
    await git(
      directory,
      'ls-files',
      '--modified',
      '--deleted',
      '--others',
      '--exclude-standard',
      '-z',
    )
  )
    .split('\0')
    .filter(Boolean);
  for (const name of new Set(names)) {
    const file = join(directory, name);
    if (!(await exists(file))) continue;
    if ((await realpath(file)) !== file || !(await lstat(file)).isFile())
      problem('링크 또는 하위 저장소 변경은 별도 검토가 필요합니다.');
    digest
      .update(name + '\0')
      .update(await git(directory, 'hash-object', '--no-filters', '--', name));
  }
  return digest.digest('hex');
}
export function manageWorktrees(store: StudioStore, root: string) {
  let creating: Promise<void> = Promise.resolve();
  async function open(task: string, target: GitTarget) {
    const data = await realpath(root);
    let storage = join(data, 'git-development');
    if (within(target.root, storage))
      storage = join(
        homedir(),
        'Library',
        'Application Support',
        'Workplot',
        'git-development',
        createHash('sha256').update(data).digest('hex'),
      );
    if (within(target.root, storage))
      problem('원본 밖에 독립 작업 공간을 만들 수 없습니다.');
    const pool = join(storage, target.checkoutId),
      common = join(pool, 'repo.git');
    const directory = join(pool, 'tasks', task),
      branch = 'workplot/' + task,
      path = join(directory, target.subpath);
    const row = store.worktree(task);
    if (row && (row.directory !== directory || row.base !== target.sha))
      problem('등록된 작업 공간과 실행 대상이 다릅니다.');
    // Create only a new task. An already-opened tree must never be reset or reconstructed.
    if (!row?.ready) {
      await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
      if ((await realpath(dirname(directory))) !== dirname(directory))
        problem('작업 공간 경로가 변경됐습니다.');
      store.planWorktree(task, { directory, path, branch, base: target.sha });
      await mkdir(common, { recursive: true, mode: 0o700 });
      if ((await realpath(common)) !== common)
        problem('Git 보관 폴더가 변경됐습니다.');
      if (!(await exists(join(common, 'HEAD'))))
        await git(
          common,
          'init',
          '--bare',
          ...(target.sha.length === 64 ? ['--object-format=sha256'] : []),
          '.',
        );
      if (!(await exists(directory))) {
        await git(
          common,
          '-c',
          'protocol.file.allow=always',
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          target.root,
          target.sha,
        );
        await git(
          common,
          'worktree',
          'add',
          '-b',
          branch,
          directory,
          target.sha,
        );
      }
    }
    if (!(await exists(path)))
      problem('기준 커밋에 서비스 폴더가 없거나 작업 공간이 이동했습니다.');
    if (
      (await realpath(directory)) !== directory ||
      (await realpath(path)) !== path ||
      !(await lstat(path)).isDirectory()
    )
      problem('작업 폴더가 이동했거나 기준 커밋에 서비스 폴더가 없습니다.');
    if (
      (await git(directory, 'rev-parse', '--show-toplevel')).trim() !==
        directory ||
      (
        await git(
          directory,
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        )
      ).trim() !== common ||
      (await git(directory, 'branch', '--show-current')).trim() !== branch
    )
      problem('작업 브랜치 또는 Git 저장소가 변경됐습니다.');
    const state = store.worktree(task)!;
    let head = (await git(directory, 'rev-parse', 'HEAD')).trim();
    if (state.pending) {
      if (head === state.head) {
        await git(
          common,
          'update-ref',
          'refs/heads/' + branch,
          state.pending,
          head,
        );
        head = state.pending;
      }
      if (head !== state.pending)
        problem(
          '체크포인트를 복원할 수 없습니다. 현재 작업 브랜치를 확인하세요.',
        );
      store.finishWorktree(task, head);
    } else if (head !== state.head)
      problem('작업 브랜치의 커밋이 변경됐습니다. 현재 작업을 확인하세요.');
    if (!state.ready) store.finishWorktree(task, head);
    if (
      (await dirtyDigest(directory)) !==
      (state.pending ? null : state.dirtyHash)
    )
      problem(
        '마지막 실행 이후 작업 폴더 내용이 변경됐습니다. 작업본을 확인하고 복원한 뒤 다시 시도하세요.',
      );
    return { directory, path, branch, head, task, common };
  }
  return {
    open(task: string, target: GitTarget) {
      const work = creating.then(() => open(task, target));
      creating = work.then(
        () => {},
        () => {},
      );
      return work;
    },
    async rememberChanges(tree: Awaited<ReturnType<typeof open>>) {
      store.saveWorktreeChanges(tree.task, await dirtyDigest(tree.directory));
    },
    async checkpoint(
      tree: Awaited<ReturnType<typeof open>>,
      run: string,
      step: string,
      verify?: AbortSignal,
      recordCheck?: (log: string) => Promise<void>,
    ) {
      const { directory, path, head, branch, task, common } = tree;
      if (
        (await git(directory, 'rev-parse', 'HEAD')).trim() !== head ||
        (await git(directory, 'branch', '--show-current')).trim() !== branch ||
        (await realpath(path)) !== path
      )
        problem('검사 중 작업 공간이 변경됐습니다.');
      const scope = relative(directory, path);
      const changed = (
        await git(
          directory,
          'ls-files',
          '-z',
          '--modified',
          '--deleted',
          '--others',
          '--exclude-standard',
        )
      )
        .split('\0')
        .filter(Boolean);
      const staged = (
        await git(
          directory,
          'diff',
          '--cached',
          '--name-only',
          '--no-renames',
          '-z',
        )
      )
        .split('\0')
        .filter(Boolean);
      for (const file of new Set([...changed, ...staged])) {
        if (scope && !file.startsWith(scope + '/'))
          problem('서비스 범위 밖 변경이 있어 체크포인트를 보류했습니다.');
        const p = join(directory, file);
        if (
          (await exists(p)) &&
          ((await realpath(p)) !== p || !(await lstat(p)).isFile())
        )
          problem('링크 또는 하위 저장소 변경은 별도 검토가 필요합니다.');
      }
      if (!changed.length && !staged.length) {
        store.saveWorktreeChanges(task, null);
        return;
      }
      await git(path, 'add', '-A', '--', '.');
      const entries = (
        await git(directory, 'diff', '--cached', '--raw', '--no-renames', '-z')
      ).split('\0');
      for (let i = 0; i + 1 < entries.length; i += 2)
        if (/^:(?:120000|160000) |^:\d+ (?:120000|160000) /.test(entries[i]!))
          problem('링크 또는 하위 저장소 변경은 별도 검토가 필요합니다.');
      const treeId = (await git(directory, 'write-tree')).trim();
      if (
        treeId === (await git(directory, 'rev-parse', 'HEAD^{tree}')).trim()
      ) {
        store.saveWorktreeChanges(task, null);
        return;
      }
      const next = (
        await git(
          common,
          'commit-tree',
          treeId,
          '-p',
          head,
          '-m',
          'Workplot ' + run + ' / ' + step,
        )
      ).trim();
      if (verify) {
        const scratch = await mkdtemp(join(dirname(common), 'commit-check-'));
        const checkout = join(scratch, 'checkout');
        try {
          await git(common, 'worktree', 'add', '--detach', checkout, next);
          const { checkCandidate } = await import('./git-candidate-check.js');
          const log = await checkCandidate(
            common,
            head,
            next,
            checkout,
            scratch,
            verify,
          );
          await recordCheck?.(log);
          verify.throwIfAborted();
          if (
            (await git(directory, 'write-tree')).trim() !== treeId ||
            (await git(directory, 'diff', '--name-only')).trim()
          )
            problem('검사 중 작업 내용이 변경됐습니다.');
        } finally {
          await git(common, 'worktree', 'remove', '--force', checkout).catch(
            () => {},
          );
          await rm(scratch, { recursive: true, force: true });
          store.saveWorktreeChanges(task, await dirtyDigest(directory));
        }
      }
      store.prepareCheckpoint(task, head, next);
      await git(common, 'update-ref', 'refs/heads/' + branch, next, head);
      store.finishWorktree(task, next);
      return next;
    },
  };
}
