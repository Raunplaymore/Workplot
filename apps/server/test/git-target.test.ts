import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { inspectGit, verifyGit } from '../src/git-target.js';
import { openStudioStore } from '../src/studio-store.js';

let dir: string;
const git = (path: string, ...args: string[]) =>
  execFileSync('git', [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@localhost',
    '-c',
    'commit.gpgsign=false',
    '-C',
    path,
    ...args,
  ]);
async function repo(name: string) {
  const path = join(dir, name);
  await mkdir(path);
  git(path, 'init', '-q', '-b', 'main');
  await mkdir(join(path, 'web'));
  git(path, 'commit', '-qm', 'initial', '--allow-empty');
  git(
    path,
    'remote',
    'add',
    'origin',
    'https://user:password@example.test/app.git?token=private',
  );
  return path;
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workplot-git-target-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
it('distinguishes services, clones and subfolders and omits credentials', async () => {
  const a = await repo('a'),
    b = await repo('b');
  const web = await inspectGit(join(a, 'web')),
    api = await inspectGit(a),
    clone = await inspectGit(join(b, 'web'));
  if (!web || !api || !clone) throw Error('missing Git target');
  expect(web.repository).toBe('example.test/app');
  expect(web.repositoryId).toBe(clone.repositoryId);
  expect(web.checkoutId).toBe(api.checkoutId);
  expect(web.checkoutId).not.toBe(clone.checkoutId);
  expect(web.subpath).toBe('web');
  const db = new Database(':memory:');
  try {
    const store = openStudioStore(db);
    const t = store.bind('웹', web);
    expect(store.bind('웹', clone).serviceId).toBe(t.serviceId);
    expect(store.bind('서버', api).serviceId).not.toBe(t.serviceId);
    expect(store.bind('웹', web)).toEqual(t);
    expect(store.bindings()).toHaveLength(3);
    expect(await inspectGit(dir)).toBeNull();
  } finally {
    db.close();
  }
});
it('detects changed HEAD, branch, initial dirty state, and moved or replaced checkouts', async () => {
  const path = await repo('first');
  const loc = await inspectGit(path);
  if (!loc) throw Error('missing target');
  const t = {
    ...loc,
    service: 'Web',
    serviceId: '00000000-0000-4000-8000-000000000001',
  };
  await writeFile(join(path, 'working.md'), 'dirty');
  await expect(verifyGit(t, path, true)).rejects.toThrow();
  await verifyGit(t, path, false);
  await rm(join(path, 'working.md'));
  git(path, 'switch', '-q', '-c', 'another');
  await expect(verifyGit(t, path, false)).rejects.toThrow();
  git(path, 'switch', '-q', 'main');
  git(path, 'commit', '-qm', 'second', '--allow-empty');
  await expect(verifyGit(t, path, false)).rejects.toThrow();
  await rename(path, join(dir, 'moved'));
  await expect(inspectGit(path)).rejects.toThrow();
  await repo('first');
  await expect(verifyGit(t, path, false)).rejects.toThrow();
});
