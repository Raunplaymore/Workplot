import { expect, test, type Locator } from '@playwright/test';

test('wire editing keeps order, nearby selection and zoom through insertion, movement, deletion and undo', async ({
  page,
}, info) => {
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
  await button('추가').click();
  const added = await step.inputValue();
  expect(await position(added)).toBe('translate(240px, 90px)');
  expect(await position('review')).toBe('translate(480px, 90px)');
  expect(await viewport()).toBe(initial);
  await button('단계 연결').click();
  await button('뒤로 이동').click();
  expect(await step.inputValue()).toBe(added);
  expect(await position(added)).toBe('translate(480px, 90px)');
  expect(await position('review')).toBe('translate(240px, 90px)');
  await button('단계 삭제').click();
  await expect(step).toHaveValue('revision');
  expect(await position('revision')).toBe('translate(480px, 90px)');
  await button('되돌리기').click();
  await expect(step).toHaveValue(added);
  expect(await position(added)).toBe('translate(480px, 90px)');
  await step.selectOption('revision');
  await button('추가').click();
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
  await page.getByRole('button', { name: '추가', exact: true }).click();
  expect(
    await node('review').evaluate((n) => (n as HTMLElement).style.transform),
  ).toBe(custom);
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
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
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect(edge('draft:review')).toHaveCount(1);
  await expect(edge('review:revision')).toHaveCount(1);
});

test('selected task instructions can be refined and applied without changing another task', async ({
  page,
}) => {
  await page.goto('/#/design');
  const graph = page.getByLabel('작업 흐름 노드');
  await expect(
    graph.locator('.react-flow__edge[data-id="review:revision"]'),
  ).toContainText('승인 후');
  await graph.locator('.react-flow__node[data-id="draft"] strong').click();
  const editor = page.getByRole('textbox', { name: '작업 지침', exact: true });
  const original = await editor.inputValue();
  await editor.fill(original + ' 직접 편집.');
  await page.route('**/api/node-instructions', async (route) => {
    expect(route.request().postDataJSON().instructions).toContain('직접 편집.');
    await route.fulfill({
      json: { instructions: '출처를 확인하고 초안을 작성한다.' },
    });
  });
  await page.getByLabel('AI에게 지침 수정 요청').fill('출처 확인을 추가해줘');
  await page.getByRole('button', { name: '수정안 요청' }).click();
  await expect(page.getByLabel('AI 수정안')).toHaveValue(
    '출처를 확인하고 초안을 작성한다.',
  );
  await expect(editor).toHaveValue(original + ' 직접 편집.');
  await page.getByRole('button', { name: '지침에 적용' }).click();
  await expect(
    graph.locator('.react-flow__node[data-id="draft"]'),
  ).toContainText('출처를 확인하고');
  await graph.locator('.react-flow__node[data-id="revision"] strong').click();
  await expect(editor).not.toHaveValue('출처를 확인하고 초안을 작성한다.');
});
