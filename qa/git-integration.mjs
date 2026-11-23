import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { buildApp } from '../apps/server/dist/app.js';
import { checkCandidate } from '../apps/server/dist/git-candidate-check.js';
const root = await realpath(await mkdtemp(join(tmpdir(), 'workplot-g3-')));
const repo = join(root, 'original'),
  data = join(root, 'data'),
  out = process.env.STUDIO_QA_DIR ?? root;
await mkdir(repo);
await mkdir(data);
const git = (dir, ...args) =>
  execFileSync(
    'git',
    [
      '--no-optional-locks',
      '-c',
      'user.name=Workplot QA',
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
const file = (name, value) => writeFile(join(repo, name), value);
git(repo, 'init', '-q', '-b', 'main');
const lines =
  [
    'top=base',
    ...Array.from({ length: 12 }, (_, i) => 'middle=' + i),
    'bottom=base',
  ].join('\n') + '\n';
await file('shared.txt', lines);
await file('label.txt', 'base\n');
await file('api.cjs', 'exports.value = 42;\n');
await file(
  'base.test.cjs',
  "require('node:assert/strict').ok(require('node:fs').readFileSync('shared.txt','utf8').includes('middle=5'));\n",
);
await file(
  'package.json',
  JSON.stringify({
    name: 'g3-fixture',
    version: '1.0.0',
    scripts: { test: 'node --test *.test.cjs' },
  }),
);
await file('legacy-note.txt', 'this note will move unchanged\n');
await file('obsolete-note.txt', 'this note will disappear\n');
await mkdir(join(repo, '.workplot'));
await file(
  '.workplot/required-check.mjs',
  "import {accessSync} from 'node:fs';accessSync('shared.txt');",
);
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'source');
await file('personal.txt', 'staged personal edit\n');
git(repo, 'add', 'personal.txt');
await file('personal.txt', 'unstaged personal edit\n');
await file('private-note.txt', 'untracked personal edit\n');
async function snapshot() {
  const names = git(
    repo,
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
  ).split('\n');
  const hash = async (p) =>
    createHash('sha256')
      .update(await readFile(join(repo, p)))
      .digest('hex');
  return {
    head: git(repo, 'rev-parse', 'HEAD'),
    refs: git(repo, 'show-ref'),
    worktrees: git(repo, 'worktree', 'list', '--porcelain'),
    index: await hash('.git/index'),
    status: git(repo, 'status', '--porcelain'),
    files: Object.fromEntries(
      await Promise.all(names.map(async (n) => [n, await hash(n)])),
    ),
  };
}
const before = await snapshot();
const report = { root, before, scenarios: [] };
const db = join(data, 'studio.sqlite');
let app = await buildApp(db, resolve('apps/web/dist'));
const headers = {
  host: '127.0.0.1:4310',
  origin: 'http://127.0.0.1:4310',
  'x-studio-client': 'browser',
};
async function login() {
  const s = await app.inject({ method: 'POST', url: '/api/session', headers });
  headers.cookie = s.headers['set-cookie'].split(';')[0];
}
async function req(method, url, payload) {
  const r = await app.inject({ method, url: '/api' + url, headers, payload });
  assert.ok(r.statusCode < 300, r.body);
  return r.json();
}
async function wire(browser, master, scenario, expected) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.route('**/*', async (route) => {
    const req = route.request(),
      url = new globalThis.URL(req.url());
    if (url.origin !== headers.origin) return route.abort();
    const res = await app.inject({
      method: req.method(),
      url: url.pathname + url.search,
      headers: { ...(await req.allHeaders()), host: url.host },
      payload: req.postData() ?? undefined,
    });
    await route.fulfill({
      status: res.statusCode,
      headers: Object.fromEntries(
        Object.entries(res.headers).map(([k, v]) => [k, String(v)]),
      ),
      body: res.rawPayload,
    });
  });
  try {
    await page.goto(headers.origin + '/#/masters/' + master);
    const panel = page.getByLabel('Git 통합 큐');
    await panel.locator('summary').nth(1).click();
    assert.ok((await panel.innerText()).includes(expected));
    await page.screenshot({
      path: join(out, 'git-integration-' + scenario + '.png'),
    });
  } finally {
    await page.close();
  }
}
const browser = await chromium.launch();
try {
  await login();
  const gitTarget = await req('POST', '/git/targets', {
    service: '통합 큐 QA',
    path: repo,
  });
  const scenarios = [
    [
      'parts',
      'shared.txt의 top=base 한 줄만 top=A로 바꾸고 note-new.txt를 새로 만들어 new note를 쓰세요.',
      'shared.txt의 bottom=base 한 줄만 bottom=B로 바꾸고 legacy-note.txt를 내용 그대로 release-note.txt로 이름을 바꾸고 obsolete-note.txt를 삭제하세요.',
      'verified',
      '검증 통과',
    ],
    [
      'line',
      'label.txt의 base를 label-A로 바꾸세요.',
      'label.txt의 base를 label-B로 바꾸세요.',
      'conflict',
      '충돌 대기',
    ],
    [
      'contract',
      'api.cjs에서 exports.value를 exports.answer로 바꾸세요. 값 42는 유지합니다.',
      'consumer.test.cjs를 새로 만드세요. Node strict assert로 require("./api.cjs").value가 42인지 비교하세요. api.cjs와 기존 테스트는 수정하지 마세요.',
      'failed',
      '검증 실패',
    ],
  ];
  let tip = before.head;
  for (const [name, actionA, actionB, expected, statusLabel] of scenarios) {
    const tasks = [];
    for (const [key, action] of [
      ['a', actionA],
      ['b', actionB],
    ]) {
      const wf = await req('POST', '/workflows', {
        name: 'G3 ' + name + ' ' + key,
        input: '지정한 파일 변경',
        inputFields: [],
        steps: [
          {
            id: 'edit',
            kind: 'task',
            title: '개발 작업',
            workspaceAccess: 'write',
            instructions:
              action +
              ' 현재 Git 작업 폴더에서 지정한 변경만 실제로 적용한 뒤 요약하세요. Git 커밋은 Workplot이 수행합니다.',
            position: { x: 0, y: 0 },
          },
        ],
        links: [],
      });
      tasks.push({
        id: key,
        workflow: { id: wf.id, version: wf.version },
        dependsOn: [],
        doneWhen: '변경 완료',
        documents: { needs: [], output: key + ' 결과' },
      });
    }
    const plan = randomUUID(),
      master = randomUUID();
    await req('PUT', '/master-plans/' + plan, { goal: 'G3 ' + name, tasks });
    const start = '/master-plans/' + plan + '/runs/' + master;
    const started = await req('PUT', start, { gitTarget });
    let observed = false,
      m;
    const until = Date.now() + 240000;
    while (Date.now() < until) {
      m = await req('GET', '/master-runs/' + master);
      await Promise.all(
        m.children.map(async (c) => {
          const detail = await req('GET', '/runs/' + c.runId + '/view');
          c.view.aiCalls = detail.aiCalls;
        }),
      );
      if (
        m.children.some((c) =>
          ['unknown', 'stopped', 'failed'].includes(c.view.summary.status),
        )
      )
        throw Error(
          JSON.stringify(
            m.children.map((c) => ({
              status: c.view.summary.status,
              note: c.view.note,
            })),
          ),
        );
      if (
        m.children.every((c) => {
          const pid = c.view.aiCalls?.[0]?.pid;
          if (!pid) return false;
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
      )
        observed = true;
      if (
        m.gitQueue.length === 2 &&
        m.gitQueue.every((j) => !['queued', 'checking'].includes(j.status))
      )
        break;
      await delay(120);
    }
    const jobs = m.gitQueue;
    const proof = {
      name,
      master,
      observed,
      children: m.children.map((c) => ({
        task: c.taskId,
        run: c.runId,
        worktree: c.view.worktree,
        calls: c.view.aiCalls,
      })),
      jobs,
    };
    report.scenarios.push(proof);
    console.log(
      name,
      jobs.map((j) => [j.task, j.status, j.candidate?.slice(0, 12)]),
    );
    assert.ok(observed, '두 Codex 프로세스의 동시 실행 미관측');
    assert.deepEqual(
      jobs.map((j) => j.task),
      ['a', 'b'],
    );
    assert.deepEqual(
      jobs.map((j) => j.status),
      ['verified', expected],
      JSON.stringify(jobs),
    );
    assert.equal(jobs[0].parent, tip);
    assert.equal(jobs[1].parent, jobs[0].candidate);
    assert.ok(jobs[0].sequence < jobs[1].sequence);
    const [a, b] = proof.children;
    assert.notEqual(a.worktree.directory, b.worktree.directory);
    assert.notEqual(a.calls[0].session, b.calls[0].session);
    assert.ok(a.calls[0].session && b.calls[0].session);
    assert.deepEqual(
      jobs.map((j) => j.source),
      [a.worktree.head, b.worktree.head],
    );
    const common = git(a.worktree.directory, 'rev-parse', '--git-common-dir');
    if (name === 'parts') {
      assert.equal(
        git(common, 'show', jobs[1].candidate + ':shared.txt'),
        lines
          .trim()
          .replace('top=base', 'top=A')
          .replace('bottom=base', 'bottom=B'),
      );
      assert.ok(jobs[0].files.includes('A note-new.txt'));
      assert.ok(
        jobs[1].files.includes('R100 legacy-note.txt → release-note.txt'),
      );
      assert.ok(jobs[1].files.includes('D obsolete-note.txt'));
    } else if (name === 'line') {
      assert.deepEqual(jobs[1].files, ['label.txt']);
      assert.equal(jobs[1].candidate, null);
      assert.equal(
        git(common, 'show', jobs[0].candidate + ':label.txt'),
        'label-A',
      );
    } else {
      assert.ok(jobs[1].candidate);
      assert.match(jobs[1].detail, /ERR_ASSERTION|AssertionError/);
      assert.ok(jobs[1].files.includes('A consumer.test.cjs'));
      // Prove the incoming branch is green by itself with the same isolated checker.
      const scratch = await realpath(
          await mkdtemp(join(root, 'isolated-check-')),
        ),
        checkout = join(scratch, 'checkout');
      git(
        common,
        'worktree',
        'add',
        '-q',
        '--detach',
        checkout,
        b.worktree.head,
      );
      try {
        proof.branchAlone = await checkCandidate(
          common,
          before.head,
          b.worktree.head,
          checkout,
          scratch,
          new globalThis.AbortController().signal,
        );
      } finally {
        git(common, 'worktree', 'remove', '--force', checkout);
      }
    }
    tip = jobs[expected === 'verified' ? 1 : 0].candidate;
    proof.verifiedRefs = git(
      common,
      'for-each-ref',
      '--format=%(objectname) %(refname)',
      'refs/workplot/verified',
    ).split('\n');
    assert.ok(proof.verifiedRefs.some((row) => row.startsWith(tip + ' ')));
    if (expected !== 'verified')
      assert.ok(
        !proof.verifiedRefs.some((row) => row.includes('/' + b.run + '/')),
      );
    assert.deepEqual(
      (await req('PUT', start, { gitTarget })).children,
      started.children,
    );
    const repeated = await Promise.all(
      [1, 2].map(() =>
        req('POST', '/master-runs/' + master + '/git-integration'),
      ),
    );
    for (const result of repeated) assert.deepEqual(result, jobs);
    assert.equal(
      (await req('GET', '/master-runs/' + master)).gitVerifiedHead,
      tip,
    );
    assert.deepEqual(await snapshot(), before);
    await wire(browser, master, name, statusLabel);
  }
  await app.close();
  app = await buildApp(db);
  await login();
  for (const p of report.scenarios)
    assert.deepEqual(
      (await req('GET', '/master-runs/' + p.master)).gitQueue,
      p.jobs,
    );
  report.after = await snapshot();
  assert.deepEqual(before, report.after);
  report.lastVerified = tip;
  console.log('G3 PASS', out);
} finally {
  await browser.close();
  await app.close();
  await writeFile(
    join(out, 'git-integration.json'),
    JSON.stringify(report, null, 2),
  );
  console.log('G3 evidence', out);
}
