import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../apps/server/dist/app.js';

const fixture = await realpath(await mkdtemp(join(tmpdir(), 'workplot-g2-')));
const repository = join(fixture, 'source'),
  data = join(fixture, 'data');
await mkdir(repository);
await mkdir(data);
const git = (dir, ...args) =>
  execFileSync(
    'git',
    [
      '--no-optional-locks',
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
git(repository, 'init', '-q', '-b', 'main');
await mkdir(join(repository, 'web'));
const file = (dir) => join(dir, 'shared.txt'),
  text = (p) => readFile(p, 'utf8');
await writeFile(file(join(repository, 'web')), 'BASE\n');
git(repository, 'add', 'web');
git(repository, 'commit', '-qm', 'baseline');
await writeFile(file(join(repository, 'web')), '사용자의 미커밋 변경\n');
await writeFile(join(repository, 'private-note.txt'), '사용자의 미추적 파일\n');
async function original() {
  return {
    head: git(repository, 'rev-parse', 'HEAD'),
    status: git(repository, 'status', '--porcelain'),
    content: await text(file(join(repository, 'web'))),
    note: await text(join(repository, 'private-note.txt')),
    index: createHash('sha256')
      .update(await readFile(join(repository, '.git', 'index')))
      .digest('hex'),
    worktrees: git(repository, 'worktree', 'list', '--porcelain'),
    refs: git(repository, 'show-ref'),
  };
}
const before = await original();
const headers = {
  host: '127.0.0.1:4310',
  origin: 'http://127.0.0.1:4310',
  'x-studio-client': 'browser',
};
const app = await buildApp(join(data, 'studio.sqlite'));
const session = await app.inject({
  method: 'POST',
  url: '/api/session',
  headers,
});
headers.cookie = session.headers['set-cookie'].split(';')[0];
async function req(method, route, payload) {
  const r = await app.inject({ method, url: '/api' + route, headers, payload });
  assert(r.statusCode < 300, r.body);
  return r.json();
}
async function until(check) {
  for (let i = 0; i < 1250; i++) {
    const v = await check();
    if (v) return v;
    await delay(120);
  }
  throw Error('QA 대기 시간 초과');
}
const view = (id) => req('GET', '/runs/' + id + '/view');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const report = { fixture, before };
console.log('G2 QA', fixture);
try {
  const tokens = { a: 'A-' + randomUUID(), b: 'B-' + randomUUID() };
  const gitTarget = await req('POST', '/git/targets', {
    path: join(repository, 'web'),
    service: '병렬 QA',
  });
  const tasks = [];
  for (const key of ['a', 'b']) {
    const token = tokens[key];
    const wf = await req('POST', '/workflows', {
      name: '독립 작업 ' + key,
      input: '독립 Git 작업 폴더의 수정 검증',
      inputFields: [],
      steps: [
        {
          id: 'edit',
          kind: 'task',
          title: '파일 수정',
          position: { x: 0, y: 0 },
          workspaceAccess: 'write',
          instructions:
            '현재 작업 폴더의 shared.txt를 읽고 그 파일을 ' +
            token +
            ' 한 줄로 바꾸세요. ' +
            key +
            '.txt를 만들어 같은 값을 쓰세요. ' +
            (key === 'b'
              ? '병렬 재시도 관측을 위해 파일을 쓴 후 sleep 20 명령으로 기다리세요.'
              : '') +
            ' 변경한 내용을 확인한 다음 요약 문서를 반환하세요.',
        },
      ],
      links: [],
    });
    tasks.push({
      id: key,
      workflow: { id: wf.id, version: wf.version },
      dependsOn: [],
      doneWhen: key + ' 변경 확인',
      documents: { needs: [], output: key + ' 결과' },
    });
  }
  const plan = randomUUID(),
    master = randomUUID();
  await req('PUT', '/master-plans/' + plan, {
    goal: '같은 소스를 두 가지로 독립 수정',
    tasks,
  });
  const started = await req(
    'PUT',
    '/master-plans/' + plan + '/runs/' + master,
    { gitTarget },
  );
  const [a, b] = started.children.map((c) => c.runId);
  report.master = master;
  const [va, vb] = await until(async () => {
    const vs = await Promise.all([view(a), view(b)]);
    for (const v of vs) if (v.summary.status === 'failed') throw Error(v.note);
    return (
      vs.every((v) => v.aiCalls?.[0]?.pid && alive(v.aiCalls[0].pid)) && vs
    );
  });
  const pa = va.aiCalls[0].pid,
    pb = vb.aiCalls[0].pid;
  assert.notEqual(pa, pb);
  assert.notEqual(va.worktree.directory, vb.worktree.directory);
  assert.equal(
    git(va.worktree.path, 'rev-parse', '--git-common-dir'),
    git(vb.worktree.path, 'rev-parse', '--git-common-dir'),
  );
  report.concurrent = {
    observedAt: new Date().toISOString(),
    pids: [pa, pb],
    paths: [va.worktree.path, vb.worktree.path],
  };
  process.kill(pa, 'SIGKILL');
  const failed = await until(async () => {
    const v = await view(a);
    return v.summary.status === 'failed' && v;
  });
  assert(!alive(pa));
  assert(alive(pb));
  const bAtRetry = await view(b);
  const siblingState = {
    head: git(vb.worktree.path, 'rev-parse', 'HEAD'),
    files: await readdir(vb.worktree.path),
    content: await text(file(vb.worktree.path)),
  };
  await req('POST', '/runs/' + a + '/retry', { failureId: failed.failureId });
  const afterRetry = await view(b);
  assert.equal(afterRetry.aiCalls[0].pid, pb);
  assert.equal(bAtRetry.worktree.path, afterRetry.worktree.path);
  assert(alive(pb));
  report.retry = {
    failedPid: pa,
    siblingPid: pb,
    siblingAlive: true,
    siblingAtRetry: siblingState,
  };
  for (const [key, id] of [
    ['a', a],
    ['b', b],
  ]) {
    const v = await until(async () => {
      const state = await view(id);
      if (state.summary.status === 'failed') throw Error(state.note);
      return state.summary.status === 'completed' && state;
    });
    const tree = v.worktree,
      changed = git(
        tree.path,
        'diff',
        '--name-only',
        before.head,
        tree.head,
      ).split('\n');
    assert.deepEqual(
      changed.sort(),
      ['web/' + key + '.txt', 'web/shared.txt'].sort(),
    );
    assert.equal((await text(file(tree.path))).trim(), tokens[key]);
    assert.equal(
      (await text(join(tree.path, key + '.txt'))).trim(),
      tokens[key],
    );
    assert.equal(git(tree.path, 'status', '--porcelain'), '');
    assert.equal(git(tree.path, 'rev-parse', 'HEAD^'), before.head);
    assert.equal(v.aiCalls.length, key === 'a' ? 2 : 1);
    assert(v.aiCalls.at(-1).session);
    report[key] = {
      run: id,
      worktree: tree,
      calls: v.aiCalls,
      changed,
      content: (await text(file(tree.path))).trim(),
    };
  }
  const after = await original();
  assert.deepEqual(after, before);
  report.after = after;
  assert.deepEqual(
    (
      await req('PUT', '/master-plans/' + plan + '/runs/' + master, {
        gitTarget,
      })
    ).children,
    started.children,
  );
  assert.equal((await req('GET', '/runs')).length, 2);
  console.log('PASS', join(fixture, 'report.json'));
} finally {
  await writeFile(
    join(fixture, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  if (process.env.STUDIO_QA_DIR)
    await writeFile(
      join(process.env.STUDIO_QA_DIR, 'git-worktrees.json'),
      JSON.stringify(report, null, 2),
    );
  await app.close();
}
