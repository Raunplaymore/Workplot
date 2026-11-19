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

test('the built workspace connects to the local server without pretending to run an agent', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: '워크플로 대시보드' }),
  ).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('로컬 서버 연결됨');
  await page.getByRole('link', { name: '흐름 설계' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await expect(
    page.getByRole('button', { name: '작업 실행 · 연결 준비 중' }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('로컬 서버 연결됨');
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
