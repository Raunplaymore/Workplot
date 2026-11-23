import { expect, test } from '@playwright/test';

test('tool detection shows partial availability without enabling work', async ({
  page,
}) => {
  await page.route('**/api/tools', (route) =>
    route.fulfill({
      json: [
        {
          id: 'claude',
          status: 'detected',
          version: '2.1.293',
          authentication: 'unchecked',
        },
        {
          id: 'codex',
          status: 'not_found',
          version: null,
          authentication: 'unchecked',
        },
      ],
    }),
  );
  await page.goto('/');
  await page
    .getByText('내 에이전트 도구', { exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.getByText('설치 확인 · 2.1.293')).toBeVisible();
  await expect(page.getByText('서버에서 찾지 못함')).toBeVisible();
  await expect(page.getByText('로그인 미확인', { exact: true })).toHaveCount(2);
  await page.getByRole('link', { name: '흐름 설계' }).click();
  await expect(
    page.getByRole('button', { name: '작업 실행 · 연결 준비 중' }),
  ).toBeDisabled();
});

for (const width of [1440, 390]) {
  test(`실행 현황에서 Codex 상태 바로 열기 (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/tools', (route) =>
      route.fulfill({
        json: [
          {
            id: 'codex',
            status: 'not_found',
            version: null,
            authentication: 'unchecked',
          },
        ],
      }),
    );
    const runStarts: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/runs'
      ) {
        runStarts.push(request.url());
      }
    });
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: '목표로 시작' }),
    ).toBeDisabled();
    const panel = page.getByRole('region', { name: '내 에이전트 도구' });
    await expect(panel).toBeHidden();
    const shortcut = page.getByRole('button', { name: 'Codex 설치 상태 보기' });
    const workspace = page.getByRole('main');
    const scrollTop = await workspace.evaluate((element) => element.scrollTop);
    if (width === 390) {
      await shortcut.focus();
      await page.keyboard.press('Enter');
    } else {
      await shortcut.click();
    }
    const status = panel.getByText('서버에서 찾지 못함');
    await expect(status).toBeInViewport({ ratio: 1 });
    await expect(panel.getByRole('listitem')).toBeFocused();
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);

    const summary = page
      .locator('summary')
      .filter({ hasText: '내 에이전트 도구' });
    await summary.click();
    await expect(panel).toBeHidden();
    await expect(summary).toBeFocused();
    expect(await workspace.evaluate((element) => element.scrollTop)).toBe(
      scrollTop,
    );
    expect(runStarts).toEqual([]);
  });
}

test('the built workspace connects to the local server without pretending to run an agent', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: '워크플로 대시보드' }),
  ).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: '로컬 서버' }),
  ).toHaveText('로컬 서버 연결됨');
  await page.getByRole('link', { name: '흐름 설계' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await expect(
    page.getByRole('button', { name: '작업 실행 · 연결 준비 중' }),
  ).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole('status').filter({ hasText: '로컬 서버' }),
  ).toHaveText('로컬 서버 연결됨');
  expect(errors).toEqual([]);
});

test('a failed server connection is visible on a narrow screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/health', (route) =>
    route.fulfill({ status: 503, body: '{}' }),
  );
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText(
    '로컬 서버에 연결할 수 없음',
  );
  await page.getByRole('link', { name: '흐름 설계' }).click();
  await expect(
    page.getByRole('button', { name: '작업 실행 · 연결 준비 중' }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('390px 실행 목록에서 완료 상태와 결과 열기가 한 줄로 표시된다', async ({
  page,
}) => {
  const id = '00000000-0000-4000-8000-000000000001';
  await page.route('**/api/runs', (route) =>
    route.fulfill({
      json: [
        {
          id,
          workflowId: '00000000-0000-4000-8000-000000000002',
          workflowVersion: 1,
          recordedAt: '2026-01-01T00:00:00.000Z',
          status: 'completed',
          name: '문서 전환 검증',
        },
      ],
    }),
  );
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/#/runs');
  const result = page.getByRole('button', { name: '결과 열기', exact: true });
  const row = page.getByRole('row').filter({ has: result });
  for (const label of [row.getByText('완료', { exact: true }), result]) {
    await expect(label).toBeVisible();
    const lines = await label.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set(
        Array.from(range.getClientRects(), (r) => Math.round(r.top)),
      ).size;
    });
    expect(lines).toBe(1);
  }
  const fits = await row.evaluate((el) => {
    const table = el.closest('table')!;
    const box = table.getBoundingClientRect();
    return (
      box.left >= 0 &&
      box.right <= innerWidth + 1 &&
      table.parentElement!.scrollWidth === table.parentElement!.clientWidth
    );
  });
  expect(fits).toBe(true);
});

test('실행 목록에서 세션 묶음을 유지한 채 페이지와 표시 개수를 변경한다', async ({
  page,
}) => {
  const uuid = (i: number) =>
    '00000000-0000-4000-8000-' + String(i).padStart(12, '0');
  const rows = Array.from({ length: 105 }, (_, i) => ({
    id: uuid(i),
    workflowId: uuid(200),
    workflowVersion: 1,
    recordedAt: '2026-01-01T00:00:00.000Z',
    status: i < 30 ? 'running' : i < 61 ? 'waiting' : 'completed',
    name: '기록 ' + i,
    ...(i === 0 && { previousSessionId: uuid(104) }),
  }));
  await page.route('**/api/runs', (route) => route.fulfill({ json: rows }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/runs');
  const table = page.locator('tbody tr'),
    size = page.getByLabel('페이지당 실행 개수'),
    next = page.getByLabel('다음 페이지'),
    prev = page.getByLabel('이전 페이지');
  await expect(table).toHaveCount(30);
  await expect(prev).toBeDisabled();
  await table.first().getByText('이전 세션 보기').click();
  await expect(table.first().getByRole('link')).toHaveAttribute(
    'href',
    '#/runs/' + uuid(104),
  );
  await next.click();
  await expect(table.first()).toContainText('기록 30');
  await size.selectOption('50');
  await expect(table).toHaveCount(50);
  await next.click();
  await next.click();
  await expect(table).toHaveCount(4);
  await expect(next).toBeDisabled();
  await prev.click();
  await expect(table.first()).toContainText('기록 50');
  await size.selectOption('30');
  await page.getByRole('button', { name: /진행 중/ }).click();
  await expect(table).toHaveCount(30);
  await expect(
    page.getByRole('navigation', { name: '실행 목록 페이지' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: /사용자 확인 대기/ }).click();
  await expect(table).toHaveCount(30);
  await expect(table.first()).toContainText('기록 30');
  await next.click();
  await expect(table).toHaveCount(1);
  await expect(table.first()).toContainText('기록 60');
  await size.selectOption('50');
  await expect(table).toHaveCount(31);
  await expect(size).toHaveValue('50');
  await expect(next).toBeDisabled();
  await page.getByRole('button', { name: /전체 실행/ }).click();
  await size.selectOption('100');
  await expect(table).toHaveCount(100);
  await page.reload();
  await expect(size).toHaveValue('100');
  await expect(table).toHaveCount(100);
  await next.click();
  await expect(table).toHaveCount(4);
  await expect(next).toBeDisabled();
});

for (const width of [390, 1280]) {
  test(`${width}px 활성 세션과 실행 목록에서 대기 유형을 확인하고 해당 상세를 연다`, async ({
    page,
  }) => {
    const rows = [
      {
        name: '기록 1',
        gateKind: 'question',
        expectedStatus: '답변 대기',
        action: '질문 열기',
      },
      {
        name: '기록 2',
        gateKind: 'review',
        expectedStatus: '승인 대기',
        action: '검토 열기',
      },
      {
        name: '기록 3',
        expectedStatus: '사용자 확인 대기',
        action: '대기 단계 열기',
      },
    ].map(({ expectedStatus, action, ...row }, index) => ({
      expectedStatus,
      action,
      row: {
        ...row,
        id: '00000000-0000-4000-8000-00000000000' + (index + 1),
        workflowId: '00000000-0000-4000-8000-000000000010',
        workflowVersion: 1,
        recordedAt: '2026-01-01T00:00:00.000Z',
        status: 'waiting',
      },
    }));
    const responses = rows.map(({ row }) => row);
    await page.route('**/api/runs', (route) =>
      route.fulfill({ json: responses }),
    );
    for (const { name, gateKind, ...summary } of responses) {
      await page.route(`**/api/runs/${summary.id}/view`, (route) =>
        route.fulfill({
          json: {
            summary: { ...summary, provider: 'codex', cliVersion: '1.0.0' },
            stepId: 'stage',
            note: null,
            results: [],
            gate: gateKind
              ? { id: summary.id, kind: gateKind, text: name + '의 대기 내용' }
              : null,
          },
        }),
      );
    }

    const { workflowId, recordedAt } = responses[0]!;
    await page.route(
      `**/api/workflows/${workflowId}/versions/1?expanded=1`,
      (route) =>
        route.fulfill({
          json: {
            id: workflowId,
            version: 1,
            savedAt: recordedAt,
            definition: {
              name: '검사용 워크플롯',
              steps: [
                {
                  id: 'stage',
                  kind: 'task',
                  title: '자료 확인',
                  instructions: '검사용 자료를 확인한다.',
                  position: { x: 0, y: 0 },
                },
              ],
              links: [],
            },
          },
        }),
    );
    await page.route('**/api/runs/*/delivery', (route) =>
      route.fulfill({ json: { receipts: [] } }),
    );
    await page.route('**/api/runs/*/delegation', (route) =>
      route.fulfill({
        json: {
          enabled: false,
          used: 0,
          note: '',
          score: null,
          checks: [],
          config: null,
        },
      }),
    );

    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto('/#/runs');
    const cards = page
      .getByRole('region', { name: '진행 중인 워크플롯' })
      .getByRole('article');
    await expect(cards).toHaveCount(3);
    const cardFor = (name: string) =>
      cards.filter({ has: page.getByRole('heading', { name, exact: true }) });
    for (const {
      row: { name },
      expectedStatus,
      action,
    } of rows) {
      const card = cardFor(name);
      await expect(
        card.getByText(expectedStatus + ' · 자료 확인', { exact: true }),
      ).toBeVisible();
      await expect(
        card.getByRole('link', { name: action + ' →', exact: true }),
      ).toBeVisible();
    }
    for (const {
      row: { id, name, gateKind },
      action,
    } of rows) {
      await cardFor(name)
        .getByRole('link', { name: action + ' →', exact: true })
        .click();
      await expect(page).toHaveURL(new RegExp('#/runs/' + id + '$'));
      if (gateKind) {
        await expect(
          page.getByText(name + '의 대기 내용', { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText(
            gateKind === 'question'
              ? 'Codex가 확인을 요청했습니다'
              : '검토 후 계속할까요?',
            { exact: true },
          ),
        ).toBeVisible();
      }
      await page.goto('/#/runs');
    }

    for (const {
      row: { id, name, gateKind },
      expectedStatus,
      action,
    } of rows) {
      await page.goto('/#/runs');
      await page.getByRole('button', { name: /사용자 확인 대기/ }).click();
      const list = page.locator('tbody');
      await expect(list.getByRole('row')).toHaveCount(3);
      const row = list.getByRole('row').filter({ hasText: name });
      await expect(
        row.getByText(expectedStatus, { exact: true }),
      ).toBeVisible();
      await row.getByRole('button', { name: action, exact: true }).click();
      await expect(page).toHaveURL(new RegExp('#/runs/' + id + '$'));
      if (gateKind) {
        await expect(
          page.getByText(name + '의 대기 내용', { exact: true }),
        ).toBeVisible();
      }
    }
  });
}
