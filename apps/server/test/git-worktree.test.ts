import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectGit } from '../src/git-target.js';
import { manageWorktrees } from '../src/git-worktree.js';
import { openStudioStore } from '../src/studio-store.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=QA',
      '-c',
      'user.email=qa@localhost',
      '-c',
      'commit.gpgSign=false',
      '-C',
      dir,
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();
it('keeps sibling branches independent, preserves partial work and rejects edits made between attempts', async () => {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), 'workplot-worktrees-')),
    ),
    repo = join(root, 'source');
  const db = new Database(':memory:');
  try {
    await mkdir(join(repo, 'web'), { recursive: true });
    await writeFile(join(repo, 'web', 'index.txt'), 'base');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', 'web');
    git(repo, 'commit', '-qm', 'base');
    const store = openStudioStore(db),
      location = await inspectGit(join(repo, 'web'));
    if (!location) throw Error('missing target');
    const target = store.bind('웹', location),
      manager = manageWorktrees(store, root);
    const [a, b] = await Promise.all([
      manager.open(randomUUID(), target),
      manager.open(randomUUID(), target),
    ]);
    expect(a.common).toBe(b.common);
    expect(a.path).not.toBe(b.path);
    const file = join(a.path, 'index.txt');
    await writeFile(file, 'partial');
    await manager.rememberChanges(a);
    const restarted = manageWorktrees(store, root);
    expect((await restarted.open(a.task, target)).head).toBe(a.head);
    await writeFile(file, 'outside edit');
    await expect(restarted.open(a.task, target)).rejects.toThrow('마지막 실행');
    await writeFile(file, 'partial');
    await restarted.open(a.task, target);
    await restarted.checkpoint(a, randomUUID(), 'edit');
    expect(git(a.directory, 'rev-parse', 'HEAD^')).toBe(target.sha);
    expect((await restarted.open(a.task, target)).head).not.toBe(target.sha);
    expect((await restarted.open(b.task, target)).head).toBe(target.sha);
    expect(await readFile(join(b.path, 'index.txt'), 'utf8')).toBe('base');
    expect(await readFile(join(repo, 'web', 'index.txt'), 'utf8')).toBe('base');
    await writeFile(join(b.directory, 'other.txt'), 'out of scope');
    await expect(manager.checkpoint(b, randomUUID(), 'edit')).rejects.toThrow(
      '범위 밖',
    );
    await rm(join(b.directory, 'other.txt'));
    await symlink(file, join(b.path, 'foreign.txt'));
    await expect(manager.checkpoint(b, randomUUID(), 'edit')).rejects.toThrow(
      '링크',
    );
    expect(git(b.path, 'rev-parse', 'HEAD')).toBe(target.sha);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.runIf(process.platform === 'darwin')(
  'commits a deferred change only after the exact candidate passes its tests',
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'workplot-commit-')),
    );
    const repo = join(root, 'repo');
    const db = new Database(':memory:');
    try {
      await mkdir(repo);
      await writeFile(
        join(repo, 'package.json'),
        JSON.stringify({ scripts: { test: 'node check.cjs' } }),
      );
      await writeFile(
        join(repo, 'check.cjs'),
        "require('node:child_process').execFileSync('git', ['--version']); if (require('node:fs').readFileSync('value','utf8') === 'bad') process.exit(1)",
      );
      await writeFile(join(repo, 'value'), 'initial');
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'initial');
      const store = openStudioStore(db),
        manager = manageWorktrees(store, root);
      const target = store.bind('QA', (await inspectGit(repo))!);
      const task = randomUUID(),
        run = randomUUID(),
        signal = new AbortController().signal;
      const tree = await manager.open(task, target);
      await writeFile(join(tree.path, 'value'), 'bad');
      await manager.rememberChanges(tree);
      await expect(
        manager.checkpoint(tree, run, 'verified', signal),
      ).rejects.toThrow('npm run test');
      expect(git(tree.path, 'rev-parse', 'HEAD')).toBe(target.sha);
      await manager.open(task, target);
      await writeFile(join(tree.path, 'value'), 'good');
      await manager.rememberChanges(tree);
      const sha = await manager.checkpoint(tree, run, 'verified', signal);
      expect(git(tree.path, 'rev-parse', 'HEAD')).toBe(sha);
      const same = await manager.open(task, target);
      expect(
        await manager.checkpoint(same, run, 'verified', signal),
      ).toBeUndefined();
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(target.sha);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
