import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { buildApp } from '../apps/server/dist/app.js';
import { codexRunner } from '../apps/server/dist/codex-runner.js';

const teamCheckOnly = process.argv.includes('--team-check-only');
const weakenedTask = 'weakened-checks';
const policyPath = '.workplot/required-check.mjs';
const missingFile = 'G4 팀 필수 파일 a.txt 누락';
const runner = {
  ready: teamCheckOnly ? async () => '0.166.0' : codexRunner.ready,
  async write(...args) {
    const { masterTask, workFolder } = JSON.parse(args[0]);
    if (masterTask?.taskId === weakenedTask) {
      await unlink(join(workFolder, 'a.txt'));
      await writeFile(
        join(workFolder, 'test.cjs'),
        "require('node:test')('weakened candidate test', () => {});\n",
      );
      await writeFile(join(workFolder, policyPath), 'process.exitCode = 0;\n');
      execFileSync('npm', ['test'], { cwd: workFolder });
      execFileSync(process.execPath, [policyPath], { cwd: workFolder });
    } else if (masterTask?.taskId === 'control') {
      // The second independent task contributes no source changes.
    } else if (teamCheckOnly) {
      const task = masterTask.taskId;
      assert.ok(['a', 'b'].includes(task));
      await writeFile(join(workFolder, task + '.txt'), task + '-first\n');
    } else {
      return codexRunner.write(...args);
    }
    args[2]({ sessionId: randomUUID() });
    return { kind: 'document', text: 'QA 작업 완료' };
  },
};

if (process.argv[2] === 'serve') {
  const app = await buildApp(
    process.argv[3],
    resolve('apps/web/dist'),
    undefined,
    runner,
  );
  await app.listen({ host: '127.0.0.1', port: 5173 });
  process.once('SIGTERM', () => app.close().then(() => process.exit(0)));
  process.send('ready');
} else await verify();

async function verify() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workplot-g4-'))),
    repo = join(root, 'source'),
    data = join(root, 'data'),
    bin = join(root, 'bin'),
    out = process.env.STUDIO_QA_DIR ?? root;
  for (const d of [repo, data, bin]) await mkdir(d);
  const database = join(data, 'studio.sqlite'),
    events = join(root, 'successful-pushes'),
    arm = join(root, 'crash-after-push');
  const realGit = execFileSync('/usr/bin/which', ['git'], {
    encoding: 'utf8',
  }).trim();
  const git = (...args) =>
    execFileSync(
      realGit,
      [
        '--no-optional-locks',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=G4 QA',
        '-c',
        'user.email=g4@localhost',
        '-c',
        'commit.gpgSign=false',
        '-C',
        repo,
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim();
  const q = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  // The shim kills only this QA server after the real local receive-pack has returned success.
  // No fault switches or injectable hooks in the product.
  await writeFile(
    join(bin, 'git'),
    [
      '#!/bin/sh',
      'for arg in "$@"; do',
      '  if [ "$arg" = push ]; then',
      '    ' + q(realGit) + ' "$@" || exit "$?"',
      '    echo "$PPID" >> ' + q(events),
      '    if [ -f ' +
        q(arm) +
        ' ] && [ "$(cat ' +
        q(arm) +
        ')" = "$PPID" ]; then kill -KILL "$PPID"; fi',
      '    exit 0',
      '  fi',
      'done',
      'exec ' + q(realGit) + ' "$@"',
      '',
    ].join('\n'),
  );
  await chmod(join(bin, 'git'), 0o700);
  await writeFile(events, '');
  git('init', '-q', '-b', 'main');
  const file = (n, value) => writeFile(join(repo, n), value);
  await file(
    'package.json',
    JSON.stringify({
      name: 'promotion-qa',
      scripts: { test: 'node --test test.cjs' },
    }),
  );
  await file(
    'test.cjs',
    "require('node:assert/strict').ok(require('node:fs').existsSync('a.txt'));\n",
  );
  for (const key of ['a', 'b']) await file(key + '.txt', 'base\n');
  await mkdir(join(repo, '.workplot'));
  await file(
    policyPath,
    "import {existsSync} from 'node:fs';if (!existsSync('a.txt')) throw Error(" +
      JSON.stringify(missingFile) +
      ');',
  );
  git('add', '.');
  git('commit', '-qm', 'original');
  const head = () => git('rev-parse', 'HEAD'),
    receipts = () =>
      git(
        'for-each-ref',
        '--format=%(objectname) %(refname)',
        'refs/workplot/receipts',
      )
        .split('\n')
        .filter(Boolean);
  const count = async () =>
    (await readFile(events, 'utf8')).trim().split('\n').filter(Boolean).length;
  const origin = 'http://127.0.0.1:5173',
    headers = { origin, 'x-studio-client': 'browser' };
  let child, browser, app;
  async function start() {
    if (teamCheckOnly) {
      app = await buildApp(database, undefined, undefined, runner);
      const res = await app.inject({
        method: 'POST',
        url: '/api/session',
        headers: { ...headers, host: new URL(origin).host },
      });
      assert.equal(res.statusCode, 204);
      headers.cookie = res.headers['set-cookie'].split(';')[0];
      return;
    }
    child = fork(fileURLToPath(import.meta.url), ['serve', database], {
      env: { ...process.env, PATH: bin + ':' + process.env.PATH },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    await new Promise((ok, bad) => {
      child.once('message', ok);
      child.once('exit', (code) => bad(Error('QA server exit ' + code)));
    });
    const res = await globalThis.fetch(origin + '/api/session', {
      method: 'POST',
      headers,
    });
    assert.equal(res.status, 204);
    headers.cookie = res.headers.get('set-cookie').split(';')[0];
  }
  async function call(method, path, body, expected = 200) {
    if (app) {
      const res = await app.inject({
        method,
        url: '/api' + path,
        headers: { ...headers, host: new URL(origin).host },
        payload: body,
      });
      assert.ok(
        expected === 200 ? res.statusCode < 300 : res.statusCode === expected,
        res.body,
      );
      return res.json();
    }
    const res = await globalThis.fetch(origin + '/api' + path, {
      method,
      headers: {
        ...headers,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const obj = await res.json();
    assert.ok(
      expected === 200 ? res.ok : res.status === expected,
      JSON.stringify(obj),
    );
    return obj;
  }
  async function prepare(round, weakened = false) {
    const target = await call('POST', '/git/targets', {
        path: repo,
        service: 'G4 검증 저장소',
      }),
      tasks = [];
    for (const k of weakened ? [weakenedTask, 'control'] : ['a', 'b']) {
      const wf = await call('POST', '/workflows', {
        name: 'G4 ' + round + ' ' + k,
        input: '명시한 파일 수정',
        inputFields: [],
        steps: [
          {
            id: 'edit',
            kind: 'task',
            title: '개발',
            workspaceAccess: 'write',
            instructions:
              k +
              '.txt 파일의 내용을 정확히 ' +
              k +
              '-' +
              round +
              ' 한 줄로 교체하세요. 다른 파일을 변경하거나 커밋하지 마세요. 현재 작업 폴더에서 실제 수정하고 요약하세요.',
            position: { x: 0, y: 0 },
          },
        ],
        links: [],
      });
      tasks.push({
        id: k,
        workflow: { id: wf.id, version: wf.version },
        dependsOn: [],
        doneWhen: '파일 수정 완료',
        documents: { needs: [], output: k + ' 수정 결과' },
      });
    }
    const plan = randomUUID(),
      master = randomUUID(),
      route = '/master-runs/' + master;
    await call('PUT', '/master-plans/' + plan, { goal: 'G4 ' + round, tasks });
    await call('PUT', '/master-plans/' + plan + '/runs/' + master, {
      gitTarget: target,
    });
    for (let i = 0; i < 1000; i++) {
      const m = await call('GET', route);
      if (
        m.children.some((c) =>
          ['failed', 'unknown', 'waiting', 'stopped'].includes(
            c.view.summary.status,
          ),
        )
      )
        throw Error(
          JSON.stringify(
            m.children.map((c) => [c.view.summary.status, c.view.note]),
          ),
        );
      if (
        weakened &&
        m.gitQueue.some((j) => j.task === weakenedTask && j.status === 'failed')
      ) {
        assert.equal(m.gitQueue.length, 2);
        assert.ok(!m.gitPromotion || m.gitPromotion.status === 'unchanged');
        return { route, job: m.gitQueue.find((j) => j.task === weakenedTask) };
      }
      if (m.gitQueue.some((j) => ['failed', 'conflict'].includes(j.status)))
        throw Error(JSON.stringify(m.gitQueue));
      if (m.gitPromotion?.status === 'ready') {
        assert.equal(weakened, false, '약화 후보가 승인 대기에 도달했습니다.');
        const calls = await Promise.all(
          m.children.map(
            async (c) =>
              (await call('GET', '/runs/' + c.runId + '/view')).aiCalls,
          ),
        );
        assert(calls.every((c) => c.length === 1 && c[0].session));
        assert.equal(m.gitQueue.length, 2);
        assert.equal(head(), target.sha);
        return { master, route, initial: m.gitPromotion, calls };
      }
      await delay(250);
    }
    throw Error('G3 후보 대기 시간 초과');
  }
  function decision(p) {
    return { expected: p.expected, candidate: p.candidate, ticket: p.ticket };
  }
  async function pagesFor(s) {
    const pages = await Promise.all([browser.newPage(), browser.newPage()]);
    await Promise.all(
      pages.map((p) => p.goto(origin + '/#/masters/' + s.master)),
    );
    return pages;
  }
  const approve = (p) =>
      p.getByRole('button', { name: 'Approve and apply to target' }),
    recheck = (p) =>
      p.getByRole('button', { name: 'Recheck against current target' });
  const report = { fixture: root, initialHead: head() };
  console.log('G4 QA', root);
  try {
    await start();
    const { route, job } = await prepare('weakened', true);
    const { base, candidate, source, run } = job;
    assert.equal(base, report.initialHead);
    assert.match(candidate, /^[a-f0-9]{40}$/);
    const { worktree } = await call('GET', '/runs/' + run + '/view');
    const gitPool = (...args) =>
      execFileSync(
        realGit,
        ['-C', join(dirname(dirname(worktree.directory)), 'repo.git'), ...args],
        { encoding: 'utf8' },
      ).trim();
    assert.equal(
      gitPool('rev-parse', candidate + '^{tree}'),
      gitPool('rev-parse', source + '^{tree}'),
    );
    const policy = git('rev-parse', base + ':' + policyPath);
    assert.notEqual(gitPool('rev-parse', candidate + ':' + policyPath), policy);
    const db = new Database(database, { readonly: true });
    try {
      assert.equal(
        db
          .prepare(
            'SELECT policy FROM team_check_receipts WHERE base=? AND candidate=?',
          )
          .get(base, candidate),
        undefined,
      );
    } finally {
      db.close();
    }
    await call(
      'POST',
      route + '/git-promotion/approve',
      { expected: base, candidate, ticket: run },
      409,
    );
    assert.equal(head(), base);
    assert.equal(await count(), 0);
    report.teamCheckFailure = {
      base,
      candidate,
      policy,
      status: job.status,
      detail: job.detail,
      candidateTestExit: 0,
      candidatePolicyExit: 0,
      receipt: null,
      promotion: null,
      approvalStatus: 409,
      head: head(),
    };
    assert.match(job.detail, /팀 필수 검사 · 실패 \(1\)/);
    assert.ok(job.detail.includes(missingFile), job.detail);
    console.log('PASS weakened candidate', base, candidate, policy);

    if (teamCheckOnly) return;
    const s = await prepare('first');
    report.concurrent = s;
    const api = s.route + '/git-promotion/approve';
    // Old candidates have no team receipt. Both an absent receipt and one for a different SHA must fail closed.
    const probeDb = new Database(database);
    const receipt = probeDb
      .prepare('SELECT * FROM team_check_receipts WHERE base=? AND candidate=?')
      .get(s.initial.expected, s.initial.candidate);
    assert.ok(receipt?.policy);
    assert.equal(
      receipt.policy,
      git('rev-parse', receipt.base + ':' + policyPath),
    );
    assert.ok(
      s.initial.checks.includes(
        '팀 필수 검사 통과 · 기준 ' +
          receipt.base +
          ' · 검사 버전 ' +
          receipt.policy +
          ' · 후보 ' +
          receipt.candidate,
      ),
    );
    report.teamCheckPass = receipt;
    try {
      probeDb
        .prepare('DELETE FROM team_check_receipts WHERE base=? AND candidate=?')
        .run(receipt.base, receipt.candidate);
      probeDb
        .prepare('INSERT INTO team_check_receipts VALUES(?,?,?)')
        .run(receipt.base, '0'.repeat(40), receipt.policy);
      await call('POST', api, decision(s.initial), 409);
      assert.equal(head(), receipt.base);
    } finally {
      probeDb
        .prepare('INSERT INTO team_check_receipts VALUES(?,?,?)')
        .run(receipt.base, receipt.candidate, receipt.policy);
      probeDb.close();
    }
    console.log(
      'PASS verified candidate',
      receipt.base,
      receipt.candidate,
      receipt.policy,
    );

    browser = await chromium.launch();
    const pages = await pagesFor(s);
    const scope = await call('GET', s.route + '/git-promotion/scope');
    assert.deepEqual(decision(scope), decision(s.initial));
    assert.deepEqual(scope.included.map((j) => j.task).sort(), ['a', 'b']);
    assert.deepEqual(scope.files, ['M\ta.txt', 'M\tb.txt']);
    const review = pages[0].getByRole('region', {
      name: '원본 반영',
      exact: true,
    });
    await review.getByText('반영 범위 · 변경 파일 2개').waitFor();
    await review.getByText('View full diff').click();
    assert.match(
      await review.locator('details pre').last().innerText(),
      /\+a-first/,
    );
    assert.match(
      await review.locator('details pre').last().innerText(),
      /\+b-first/,
    );
    await file('personal.txt', '사용자 메모\n');
    await call('POST', api, decision(s.initial), 409);
    assert.equal(head(), s.initial.expected);
    assert.equal(
      await readFile(join(repo, 'personal.txt'), 'utf8'),
      '사용자 메모\n',
    );
    await unlink(join(repo, 'personal.txt'));
    git('update-index', '--assume-unchanged', 'a.txt');
    await file('a.txt', 'local edit hidden from status\n');
    assert.equal(git('status', '--porcelain'), '');
    await call('POST', api, decision(s.initial), 409);
    assert.equal(head(), s.initial.expected);
    assert.equal(
      await readFile(join(repo, 'a.txt'), 'utf8'),
      'local edit hidden from status\n',
    );
    assert.equal(await count(), 0);
    git('update-index', '--no-assume-unchanged', 'a.txt');
    await file('a.txt', 'base\n');
    // Synchronize both real UI POSTs after the click, so both tabs submit the same approval ticket.
    const submitted = [];
    let release;
    const both = new Promise((ok) => {
      release = ok;
    });
    for (const p of pages)
      await p.route('**' + api, async (route) => {
        submitted.push(route.request().postDataJSON());
        if (submitted.length === 2) release();
        await both;
        await route.continue();
      });
    await Promise.all(pages.map((p) => approve(p).click()));
    await Promise.all(
      pages.map((p) => p.getByText('원본 반영 · 원본 반영 완료').waitFor()),
    );
    assert.deepEqual(submitted, [decision(s.initial), decision(s.initial)]);
    s.after = head();
    s.successfulPushes = await count();
    s.receipts = receipts();
    s.reflog = git('reflog', 'show', '--format=%H', 'refs/heads/main').split(
      '\n',
    );
    assert.equal(s.after, s.initial.candidate);
    assert.equal(s.successfulPushes, 1);
    assert.equal(s.receipts.length, 1);
    assert.equal(s.reflog.filter((v) => v === s.after).length, 1);
    assert.equal(git('status', '--porcelain'), '');
    for (const k of ['a', 'b'])
      assert.equal(
        (await readFile(join(repo, k + '.txt'), 'utf8')).trim(),
        k + '-first',
      );
    await pages[0].screenshot({ path: join(out, 'g4-concurrent.png') });
    await Promise.all(pages.map((p) => p.close()));
    console.log('PASS concurrent', s.after);
    const t = await prepare('second');
    report.changed = t;
    const [one, two] = await pagesFor(t);
    // Move the original after verification and introduce a failing check, then repair it in a later commit.
    await file('outside.txt', '사용자가 추가한 변경\n');
    await file('test.cjs', "throw Error('G4 원본의 실패 테스트');\n");
    git('add', '.');
    git('commit', '-qm', 'external edits');
    t.moved = head();
    await approve(one).click();
    await recheck(one).waitFor();
    assert.equal(head(), t.moved);
    assert.equal(await count(), 1);
    await one.screenshot({ path: join(out, 'g4-stale.png') });
    await recheck(one).click();
    await one.getByText('원본 반영 · 재검사 미통과').waitFor();
    t.failed = (await call('GET', t.route)).gitPromotion;
    assert.match(t.failed.detail, /G4 원본의 실패 테스트/);
    assert.equal(head(), t.moved);
    git('restore', '--source=' + t.initial.expected, '--', 'test.cjs');
    git('add', 'test.cjs');
    git('commit', '-qm', 'repair original test');
    t.repaired = head();
    await recheck(one).click();
    await approve(one).waitFor();
    t.rechecked = (await call('GET', t.route)).gitPromotion;
    assert.equal(t.rechecked.status, 'ready');
    assert.equal(t.rechecked.expected, t.repaired);
    assert.notEqual(t.rechecked.ticket, t.initial.ticket);
    assert.notEqual(t.rechecked.candidate, t.initial.candidate);
    assert.match(t.rechecked.checks, /통과/);
    await call(
      'POST',
      t.route + '/git-promotion/approve',
      decision(t.initial),
      409,
    );
    assert.equal(await count(), 1);
    assert.equal(head(), t.repaired);
    const databaseState = () => {
      const db = new Database(database, { readonly: true });
      try {
        return JSON.parse(
          db
            .prepare('select record from git_promotions where master=?')
            .pluck()
            .get(t.master),
        );
      } finally {
        db.close();
      }
    };
    await writeFile(arm, String(child.pid));
    const old = child.pid,
      death = once(child, 'exit');
    await approve(one).click();
    const [, signal] = await death;
    assert.equal(signal, 'SIGKILL');
    report.crash = {
      old,
      signal,
      head: head(),
      journal: databaseState(),
      receipts: receipts(),
      successfulPushes: await count(),
    };
    assert.equal(report.crash.journal.status, 'applying');
    assert.equal(head(), t.rechecked.candidate);
    assert.equal(await count(), 2);
    await start();
    await Promise.all([one.reload(), two.reload()]);
    await Promise.all(
      [one, two].map((p) =>
        p.getByText('원본 반영 · 원본 반영 완료').waitFor(),
      ),
    );
    const repeat = await call(
      'POST',
      t.route + '/git-promotion/approve',
      decision(t.rechecked),
    );
    assert.equal(repeat.status, 'applied');
    report.recovery = {
      pid: child.pid,
      journal: databaseState(),
      receipts: receipts(),
      head: head(),
      successfulPushes: await count(),
      reflog: git('reflog', 'show', '--format=%H', 'refs/heads/main').split(
        '\n',
      ),
    };
    assert.equal(report.recovery.successfulPushes, 2);
    assert.equal(report.recovery.receipts.length, 2);
    assert.deepEqual(report.recovery.receipts, report.crash.receipts);
    assert.equal(report.recovery.head, report.crash.head);
    assert.equal(
      report.recovery.reflog.filter((v) => v === t.rechecked.candidate).length,
      1,
    );
    for (const k of ['a', 'b'])
      assert.equal(
        (await readFile(join(repo, k + '.txt'), 'utf8')).trim(),
        k + '-second',
      );
    assert.equal(
      await readFile(join(repo, 'outside.txt'), 'utf8'),
      '사용자가 추가한 변경\n',
    );
    assert.equal(git('status', '--porcelain'), '');
    await one.screenshot({ path: join(out, 'g4-recovered.png') });
    console.log('PASS stale, recheck, SIGKILL recovery', head(), out);
  } finally {
    await writeFile(
      join(out, 'git-promotion.json'),
      JSON.stringify(report, null, 2),
    );
    await browser?.close();
    await app?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const gone = once(child, 'exit');
      child.kill('SIGTERM');
      await gone;
    }
  }
}
