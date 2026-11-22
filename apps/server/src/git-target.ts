import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, relative } from 'node:path';
import { promisify } from 'node:util';
import { AttachmentError, canonicalWorkspace } from './request-files.js';
import type { GitTarget } from '@studio/contracts';

const exec = promisify(execFile);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
function displayRemote(value: string) {
  try {
    const url = new URL(value);
    if (['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol))
      return url.host + url.pathname.replace(/\.git$/, '');
    if (url.protocol === 'file:') return url.pathname;
    return '';
  } catch {
    const scp = /^(?:[^@/]+@)?([\w.-]+):([\w./-]+)$/.exec(value);
    return scp
      ? scp[1] + '/' + scp[2]!.replace(/\.git$/, '')
      : value.startsWith('/')
        ? value
        : '';
  }
}
export async function inspectGit(folder: string) {
  const path = await canonicalWorkspace(folder);
  async function git(...args: string[]) {
    return (
      await exec(
        'git',
        [
          '--no-optional-locks',
          '-c',
          'core.fsmonitor=false',
          '-C',
          path,
          ...args,
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            LC_ALL: 'C',
            GIT_TERMINAL_PROMPT: '0',
          },
          timeout: 6000,
          maxBuffer: 1024 * 1024,
        },
      )
    ).stdout.trim();
  }
  let root: string;
  try {
    root = await realpath(await git('rev-parse', '--show-toplevel'));
  } catch (e) {
    if ((e as { stderr?: string }).stderr?.includes('not a git repository'))
      return null;
    throw new AttachmentError('이 폴더의 Git 작업 트리를 확인할 수 없습니다.');
  }
  try {
    const [common, sha, branch, status, origin, rootStat] = await Promise.all([
      git('rev-parse', '--path-format=absolute', '--git-common-dir').then((p) =>
        realpath(p),
      ),
      git('rev-parse', '--verify', 'HEAD^{commit}'),
      git('branch', '--show-current'),
      git('status', '--porcelain', '--untracked-files=normal'),
      git('config', '--get', 'remote.origin.url').catch(() => ''),
      stat(root, { bigint: true }),
    ]);
    if (!branch)
      throw new AttachmentError(
        '개발 대상은 브랜치가 체크아웃된 폴더를 선택하세요.',
      );
    const remote = displayRemote(origin);
    return {
      path,
      root,
      repository: remote || basename(root),
      repositoryId: digest(remote || common),
      checkoutId: digest([common, root, rootStat.dev, rootStat.ino].join('\0')),
      subpath: relative(root, path) || '.',
      branch,
      sha,
      dirty: Boolean(status),
    };
  } catch (e) {
    if (e instanceof AttachmentError) throw e;
    throw new AttachmentError(
      '첫 커밋과 현재 브랜치가 있는 Git 폴더를 선택하세요.',
    );
  }
}
export async function verifyGitLocation(target: GitTarget, path: string) {
  const observed = await inspectGit(path);
  if (
    !observed ||
    (
      [
        'path',
        'root',
        'repository',
        'checkoutId',
        'repositoryId',
        'subpath',
        'branch',
      ] as const
    ).some((k) => target[k] !== observed[k])
  )
    throw new AttachmentError(
      '확인한 Git 대상이 달라졌습니다. 서비스·폴더·브랜치·커밋을 다시 확인하세요.',
    );
  return observed;
}
export async function verifyGit(
  target: GitTarget,
  path: string,
  starting: boolean,
) {
  const observed = await verifyGitLocation(target, path);
  if (
    target.sha !== observed.sha ||
    (starting && observed.dirty !== target.dirty)
  )
    throw new AttachmentError(
      '확인한 Git 대상이 달라졌습니다. 서비스·폴더·브랜치·커밋을 다시 확인하세요.',
    );
  return observed;
}
