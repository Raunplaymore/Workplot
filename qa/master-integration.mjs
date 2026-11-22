import { buildApp } from '../apps/server/dist/app.js';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import console from 'node:console';
import assert from 'node:assert/strict';
await mkdir('.local/master-integration-qa', { recursive: true });
const root = await mkdtemp(resolve('.local/master-integration-qa/live-'));
console.log(root);
const app = await buildApp(join(root, 'qa.sqlite'));
const headers = {
  host: '127.0.0.1:4310',
  origin: 'http://127.0.0.1:4310',
  'x-studio-client': 'browser',
};
const cookie = (
  await app.inject({ method: 'POST', url: '/api/session', headers })
).headers['set-cookie'].split(';')[0];
async function req(method, path, payload) {
  const r = await app.inject({
    method,
    url: '/api' + path,
    headers: { ...headers, cookie },
    payload,
  });
  assert.ok(r.statusCode < 300, r.body);
  return r.json();
}
try {
  const tasks = [];
  const changes = [
    ['MarkdownDocument.tsx', '원문 보기', 'Markdown 원문 보기'],
    ['SessionTrail.tsx', '이전 세션 보기', '이전 세션 목록 보기'],
  ];
  for (const [i, [file, before, after]] of changes.entries()) {
    const instruction =
      file +
      ' 컴포넌트에서 기존 사용자 문구 ' +
      before +
      '를 ' +
      after +
      '로 정확히 변경한다. 이 문구 한 곳만 수정한다.';
    const wf = await req('POST', '/workflows', {
      name: '격리 통합 QA ' + i,
      input: instruction,
      inputFields: [],
      steps: [
        {
          id: 'edit',
          kind: 'task',
          title: '화면 수정',
          instructions: instruction,
          tool: 'workplot-ui',
          position: { x: 0, y: 0 },
        },
      ],
      links: [],
    });
    tasks.push({
      id: i ? 'b' : 'a',
      workflow: { id: wf.id, version: wf.version },
      dependsOn: [],
      documents: { needs: [], output: '변경 근거' },
      doneWhen: instruction,
    });
  }
  const plan = randomUUID(),
    id = randomUUID();
  await req('PUT', '/master-plans/' + plan, {
    goal: '두 화면 문구 변경 검증',
    tasks,
  });
  await req('PUT', '/master-plans/' + plan + '/runs/' + id);
  for (let i = 0; i < 480; i++) {
    const master = await req('GET', '/master-runs/' + id);
    assert.ok(
      !master.children.some((c) =>
        ['failed', 'unknown', 'stopped'].includes(c.view.summary.status),
      ),
      JSON.stringify(master),
    );
    if (master.integration) {
      await writeFile(
        join(root, 'evidence.json'),
        JSON.stringify(master, null, 2),
      );
      assert.equal(
        master.integration.status,
        'verified',
        JSON.stringify(master.integration),
      );
      const target = master.integration.directory;
      for (const [j, [file, before, after]] of changes.entries()) {
        const final = await readFile(
          join(target, 'stage-2', 'src', file),
          'utf8',
        );
        assert.ok(final.includes(after));
        const sibling = await readFile(
          join(
            root,
            'runs',
            master.children[1 - j].runId,
            'ui-edit',
            'src',
            file,
          ),
          'utf8',
        );
        assert.ok(sibling.includes(before) && !sibling.includes(after));
      }
      console.log('PASS', target);
      break;
    }
    if (i === 479) throw Error('timeout');
    await delay(1000);
  }
} finally {
  await app.close();
}
