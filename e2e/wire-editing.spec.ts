import { prepareThreeStepDraft } from './three-step-draft.js';
import { expect, test, type Locator } from '@playwright/test';

for (const width of [1440, 390]) {
  test(`saves the selected Prompt by keyboard after a failed write (${width}px)`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await prepareThreeStepDraft(page);
    await page.goto('/');
    const rail = page.getByRole('navigation', { name: '작업공간' });
    await expect(rail.getByRole('link')).toHaveText([
      'Runs',
      'Library',
      'Editor',
    ]);
    const entry = rail.getByRole('link', { name: 'Editor' });
    await entry.press('Enter');
    await expect(entry).toHaveAttribute('aria-current', 'page');
    const panel = page.getByRole('region', { name: '와이어 편집기' });
    const save = panel.getByRole('button', { name: 'Save', exact: true });
    const viewRuns = panel.getByRole('link', { name: 'View Runs' });
    const status = panel
      .getByRole('status')
      .filter({ hasText: /Saved|Unsaved|Saving/ });
    await expect(viewRuns).toHaveCount(0);
    await save.click();
    await expect(status).toHaveText('Saved · v1');
    const picker = panel.getByLabel('편집할 단계');
    await picker.press('3');
    await expect(picker).toHaveValue('revision');
    const prompt = panel.getByRole('textbox', { name: 'Prompt', exact: true });
    const original =
      '  이전 초안과 검토 결과를 대조하세요.\n\n  변경 근거를 기록하세요. \n';
    await prompt.fill(original);
    await expect(status).toHaveText('Unsaved changes');
    await expect(viewRuns).toHaveCount(0);
    await expect(save).toBeInViewport({ ratio: 1 });
    await expect(panel.getByLabel('AI에게 지침 수정 요청')).toBeHidden();
    await page.screenshot({ path: info.outputPath('after-edit.png') });
    for (
      let i = 0;
      i < 16 && !(await save.evaluate((el) => el === document.activeElement));
      i++
    ) {
      await page.keyboard.press('Tab');
    }
    await expect(save).toBeFocused();
    await expect(save).toHaveCSS('outline-style', 'solid');
    await page.screenshot({ path: info.outputPath('after-focus.png') });

    await page.route('**/api/workflows/*', async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      await route.fulfill({ status: 500, json: { error: 'storage_error' } });
    });
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(save).toBeEnabled();
    await expect(save).toBeFocused();
    await expect(prompt).toHaveValue(original);
    await expect(viewRuns).toHaveCount(0);

    await page.unroute('**/api/workflows/*');
    const response = page.waitForResponse(
      (res) =>
        res.request().method() === 'PUT' &&
        /\/api\/workflows\//.test(res.url()),
    );
    await page.keyboard.press('Enter');
    expect((await response.then((res) => res.json())).version).toBe(2);
    await expect(status).toHaveText('Saved · v2');
    await expect(save).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(viewRuns).toBeFocused();
    await expect(viewRuns).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/runs$/);
    await expect(rail.getByRole('link', { name: 'Runs' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.goBack();
    await page.reload();
    await picker.selectOption('revision');
    await expect(prompt).toHaveValue(original);
  });
}

test('wire editing keeps order, nearby selection and zoom through insertion, movement, deletion and undo', async ({
  page,
}, info) => {
  await prepareThreeStepDraft(page);
  await page.goto('/#/design');
  const graph = page.getByLabel('작업 흐름 노드');
  const step = page.getByLabel('편집할 단계');
  const node = (id: string) =>
    graph.locator('.react-flow__node[data-id="' + id + '"]');
  const position = (id: string) =>
    node(id).evaluate((n) => (n as HTMLElement).style.transform);
  const viewport = () =>
    graph
      .locator('.react-flow__viewport')
      .evaluate((n) => (n as HTMLElement).style.transform);
  const button = (name: string) =>
    page.getByRole('button', { name, exact: true });
  await expect(node('draft')).toBeVisible();
  const initial = await viewport();
  await button('Add').click();
  const added = await step.inputValue();
  expect(await position(added)).toBe('translate(240px, 90px)');
  expect(await position('review')).toBe('translate(480px, 90px)');
  expect(await viewport()).toBe(initial);
  await button('Step connections').click();
  await button('Move later').click();
  expect(await step.inputValue()).toBe(added);
  expect(await position(added)).toBe('translate(480px, 90px)');
  expect(await position('review')).toBe('translate(240px, 90px)');
  await button('Delete step').click();
  await expect(step).toHaveValue('revision');
  expect(await position('revision')).toBe('translate(480px, 90px)');
  await button('Undo').click();
  await expect(step).toHaveValue(added);
  expect(await position(added)).toBe('translate(480px, 90px)');
  await step.selectOption('revision');
  await button('Add').click();
  const tail = await step.inputValue();
  const frame = (await graph.boundingBox())!;
  await expect
    .poll(async () => {
      const box = (await node(tail).boundingBox())!;
      return box.x + box.width;
    })
    .toBeLessThanOrEqual(frame.x + frame.width + 1);
  expect((await viewport())!.split('scale(')[1]).toBe(
    initial!.split('scale(')[1],
  );
  await page.screenshot({ path: info.outputPath('wire-editing.png') });
});

test('wire endpoints follow a dragged node and support reconnect, cancel, cycle rejection and undo', async ({
  page,
}, info) => {
  await prepareThreeStepDraft(page);
  await page.goto('/#/design');
  const graph = page.getByLabel('작업 흐름 노드');
  const edge = (id: string) =>
    graph.locator('.react-flow__edge[data-id="' + id + '"]');
  const node = (id: string) =>
    graph.locator('.react-flow__node[data-id="' + id + '"]');
  const center = async (l: Locator) => {
    const r = (await l.boundingBox())!;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const endpoint = (id: string) =>
    edge(id).locator('.react-flow__edgeupdater-target');
  const reconnect = async (id: string, target: Locator) => {
    const a = await center(endpoint(id)),
      b = await center(target);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 12 });
    await page.mouse.up();
  };
  const points = () =>
    edge('draft:review').locator('.react-flow__edge-path').getAttribute('d');
  const path = await points();
  const a = await center(node('review'));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 12, a.y + 74, { steps: 12 });
  await expect.poll(points).not.toBe(path);
  await page.mouse.up();
  const custom = await node('review').evaluate(
    (n) => (n as HTMLElement).style.transform,
  );
  await expect(page.getByLabel('편집할 단계')).toHaveValue('review');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  expect(
    await node('review').evaluate((n) => (n as HTMLElement).style.transform),
  ).toBe(custom);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const handle = (id: string) => node(id).locator('.react-flow__handle.target');
  await reconnect('review:revision', handle('draft'));
  await expect(page.getByRole('alert')).toContainText('순환');
  await expect(edge('review:revision')).toHaveCount(1);
  const start = await center(endpoint('draft:review'));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 24, start.y - 85, { steps: 12 });
  await page.mouse.up();
  await expect(edge('draft:review')).toHaveCount(1);
  await reconnect('draft:review', handle('revision'));
  await expect(edge('draft:revision')).toHaveCount(1);
  await expect(edge('draft:review')).toHaveCount(0);
  await expect(
    page.getByText('연결되지 않은 흐름', { exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath('wire-reconnected.png') });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(edge('draft:review')).toHaveCount(1);
  await expect(edge('review:revision')).toHaveCount(1);
});

test('selected task instructions can be refined and applied without changing another task', async ({
  page,
}) => {
  await prepareThreeStepDraft(page);
  await page.goto('/#/design');
  const graph = page.getByLabel('작업 흐름 노드');
  await expect(
    graph.locator('.react-flow__edge[data-id="review:revision"]'),
  ).toContainText('승인 후');
  await graph.locator('.react-flow__node[data-id="draft"] strong').click();
  const editor = page.getByRole('textbox', { name: 'Prompt', exact: true });
  const original = await editor.inputValue();
  await editor.fill(original + ' 직접 편집.');
  await page.route('**/api/node-instructions', async (route) => {
    expect(route.request().postDataJSON().instructions).toContain('직접 편집.');
    await route.fulfill({
      json: { instructions: '출처를 확인하고 초안을 작성한다.' },
    });
  });
  const refine = page.getByRole('button', { name: 'Refine' });
  await expect(page.getByLabel('AI에게 지침 수정 요청')).toBeHidden();
  await refine.press('Enter');
  await expect(refine).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('AI에게 지침 수정 요청')).toBeVisible();
  await refine.press('Enter');
  await expect(page.getByLabel('AI에게 지침 수정 요청')).toBeHidden();
  await refine.press('Enter');
  await page.getByLabel('AI에게 지침 수정 요청').fill('출처 확인을 추가해줘');
  await page.getByRole('button', { name: 'Request revision' }).click();
  await expect(page.getByLabel('AI 수정안')).toHaveValue(
    '출처를 확인하고 초안을 작성한다.',
  );
  await expect(editor).toHaveValue(original + ' 직접 편집.');
  await page.getByRole('button', { name: 'Apply to instructions' }).click();
  await expect(
    graph.locator('.react-flow__node[data-id="draft"]'),
  ).toContainText('출처를 확인하고');
  await graph.locator('.react-flow__node[data-id="revision"] strong').click();
  await expect(editor).not.toHaveValue('출처를 확인하고 초안을 작성한다.');
});

test('wire menu inserts an editable improvement router between two stages', async ({
  page,
}) => {
  await prepareThreeStepDraft(page);
  await page.goto('/#/design');
  const edge = page.locator(
    '.react-flow__edge[data-id="draft:review"] .react-flow__edge-interaction',
  );
  await expect(edge).toBeAttached();
  const point = await edge.evaluate((el) => {
    const path = el as SVGPathElement;
    const middle = path.getPointAtLength(path.getTotalLength() / 2);
    const screen = middle.matrixTransform(path.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page
    .getByRole('menuitem', { name: 'Insert improvement router' })
    .click();
  const criteria = page.getByRole('group', {
    name: '개선 경로 선택 조건과 역할',
  });
  await criteria.getByLabel('화면 개선').fill('화면의 글자를 읽기 어려울 때');
  await expect(criteria.getByLabel('화면 개선')).toHaveValue(
    '화면의 글자를 읽기 어려울 때',
  );
  const id = await page.getByLabel('편집할 단계').inputValue();
  for (const link of ['draft:' + id, id + ':review'])
    await expect(
      page.locator('.react-flow__edge[data-id="' + link + '"]'),
    ).toBeAttached();
});

test('an added AI review stays put after a missed mouse release', async ({
  page,
}) => {
  await page.goto('/#/design');
  await page.getByLabel('추가할 단계 유형').selectOption('ai-review');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const id = await page.getByLabel('편집할 단계').inputValue();
  const node = page.locator('.react-flow__node[data-id="' + id + '"]');
  const position = () =>
    node.evaluate((el) => (el as HTMLElement).style.transform);
  await expect(node).toContainText('AI 검토');
  const title = await node.locator('strong').boundingBox();
  const x = title!.x + 10,
    y = title!.y + 5;
  const initial = await position();
  await page.mouse.move(x, y);
  expect(await position()).toBe(initial);
  // Model a release outside the window: the drag library gets no mouseup.
  await page.evaluate(() =>
    window.addEventListener('mouseup', (e) => e.stopImmediatePropagation(), {
      capture: true,
      once: true,
    }),
  );
  await page.mouse.down();
  await page.mouse.move(x + 20, y + 10, { steps: 8 });
  await expect.poll(position).not.toBe(initial);
  await page.mouse.up();
  const dropped = await position();
  await page.mouse.move(x + 100, y + 20, { steps: 8 });
  await expect.poll(position).toBe(dropped);
});

test('a recovered edit with a deleted document source saves on the first click', async ({
  page,
}) => {
  await page.goto('/#/design');
  const id = await page.evaluate(async () => {
    await fetch('/api/session', {
      method: 'POST',
      headers: { 'X-Studio-Client': 'browser' },
    });
    const task = (id: string, x: number) => ({
      id,
      title: id,
      kind: 'task',
      agent: 'codex',
      instructions: '검토한다',
      position: { x, y: 0 },
    });
    const definition = {
      name: '문서 연결 복원 검사',
      steps: [
        task('first', 0),
        task('second', 240),
        { ...task('last', 480), inputFrom: ['first', 'second'] },
      ],
      links: [
        { from: 'first', to: 'second' },
        { from: 'second', to: 'last' },
      ],
    };
    const res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(definition),
    });
    if (!res.ok) throw Error('fixture ' + res.status);
    const saved = await res.json();
    const draft = {
      ...definition,
      steps: definition.steps.slice(1),
      links: definition.links.slice(1),
    };
    sessionStorage.setItem(
      'workplot.editor-draft.v1.' + saved.id,
      JSON.stringify({
        saved,
        baseline: saved.definition,
        draft,
        selected: 'second',
        flowSettings: false,
      }),
    );
    return saved.id as string;
  });
  await page.goto('/#/design/' + id);
  await page.reload();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved · v2', { exact: true })).toBeVisible();
  const saved = await page.evaluate(
    async (id) => (await fetch('/api/workflows/' + id)).json(),
    id,
  );
  expect(saved.definition.steps.map((s: { id: string }) => s.id)).toEqual([
    'second',
    'last',
  ]);
  expect(saved.definition.steps[1].inputFrom).toEqual(['second']);
});

test('a new flow starts with one AI task and an empty instruction field', async ({
  page,
}) => {
  await page.goto('/#/design');
  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(1);
  await expect(nodes).toContainText('AI 작업');
  const field = page.getByRole('textbox', { name: 'Prompt', exact: true });
  await expect(field).toHaveValue('');
  await expect(field).toHaveAttribute('placeholder', /어떤 결과/);
  await field.fill('작업 기록에서 남은 일을 정리하세요.');
  await expect(nodes).toContainText('작업 기록에서 남은 일');
});

test('a multi-task Git node shows its effective permission before granting write access', async ({
  page,
}) => {
  await prepareThreeStepDraft(page);
  await page.goto('/#/design');
  await page.getByLabel('단계 제목').fill('개발 및 Git 반영');
  await page
    .getByRole('button', { name: 'Tools and permissions', exact: true })
    .click();
  const panel = page.getByRole('region', { name: '개발 실행 권한' });
  await expect(panel).toContainText('Git 개발 실행 시 · 읽기 전용');
  await panel.getByRole('button', { name: 'Allow file edits' }).click();
  await expect(panel.getByRole('combobox')).toHaveValue('write');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/#\/design\/[a-f0-9-]+/);
  await page.reload();
  await page
    .getByRole('button', { name: 'Tools and permissions', exact: true })
    .click();
  await expect(panel).toContainText('Git 개발 실행 시 · 파일 수정 허용');
});

test('keeps each node’s refinement request and restores discarded edits in one Undo', async ({
  page,
}) => {
  await prepareThreeStepDraft(page);
  await page.goto('/#/design');
  const picker = page.getByLabel('편집할 단계');
  await picker.selectOption('draft');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await save.click();
  await expect(page.getByText('Saved · v1', { exact: true })).toBeVisible();
  const refine = page.getByRole('button', { name: 'Refine', exact: true });
  await refine.click();
  const request = page.getByLabel('AI에게 지침 수정 요청');
  await request.fill('Keep the original wording');
  const prompt = page.getByPlaceholder(
    'AI가 어떤 자료로 무엇을 하고, 어떤 결과를 내야 하는지 적어 주세요.',
  );
  await prompt.fill('Draft A');
  await picker.selectOption('revision');
  await refine.click();
  await expect(request).toHaveValue('');
  await prompt.fill('Draft B');
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(prompt).toHaveValue('Draft B');
  await picker.selectOption('draft');
  await expect(prompt).toHaveValue('Draft A');
  await refine.click();
  await expect(request).toHaveValue('Keep the original wording');
});
