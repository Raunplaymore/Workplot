import { prepareThreeStepDraft } from './three-step-draft.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { buildApp } from '../apps/server/src/app.js';

test.use({ hasTouch: true });

test('edits a saved flow by keyboard and passes that version through review to the runner', async ({
  page,
}) => {
  const folder = await mkdtemp(join(tmpdir(), 'studio-workflow-e2e-'));
  const prompts: string[] = [];
  const reviewText = Array.from(
    { length: 50 },
    (_, i) => `검토 항목 ${i + 1}의 근거를 확인했습니다.`,
  ).join('\n');
  const app = await buildApp(
    join(folder, 'fixture.sqlite'),
    undefined,
    async () => [
      {
        id: 'codex',
        status: 'detected',
        version: '0.166.0',
        authentication: 'unchecked',
      },
    ],
    {
      ready: async () => '0.166.0',
      async write(prompt) {
        prompts.push(prompt);
        return {
          kind: 'document',
          text:
            ['가상 초안 결과', reviewText, '가상 수정 결과'][
              prompts.length - 1
            ] ?? '예상하지 않은 호출',
        };
      },
    },
  );
  const headers = {
    host: '127.0.0.1:4310',
    origin: 'http://127.0.0.1:4310',
    'x-studio-client': 'browser',
  };
  try {
    const session = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers,
    });
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const response = await app.inject({
        method:
          request.method() === 'PUT'
            ? 'PUT'
            : request.method() === 'POST'
              ? 'POST'
              : 'GET',
        url: new URL(request.url()).pathname,
        headers: {
          ...headers,
          cookie,
          'content-type': request.headers()['content-type'],
        },
        payload: request.postData() ?? undefined,
      });
      await route.fulfill({
        status: response.statusCode,
        contentType: String(
          response.headers['content-type'] ?? 'application/json',
        ),
        body: response.body,
      });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await prepareThreeStepDraft(page);
    await page.goto('/');
    await page.getByRole('link', { name: '흐름 설계' }).click();
    const reviewStep = page.getByRole('button', { name: '2. 초안 검토' });
    expect((await reviewStep.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await reviewStep.tap();
    await expect(page.getByLabel('단계 제목')).toHaveValue('초안 검토');
    await page.getByRole('button', { name: '1. 초안 작성' }).tap();
    const editor = page.getByLabel('편집할 단계');
    const next = page.getByLabel('다음 단계 연결');
    const paths = page.getByLabel('작업 순서', { exact: true });
    await expect(paths.getByLabel('초안 검토 → 수정본 작성')).toHaveText(
      '↓ 승인 후',
    );
    await page.getByRole('button', { name: '단계 연결', exact: true }).click();
    await expect(
      page.getByRole('status', { name: '선행 문서 연결' }),
    ).toHaveText(/자동 연결.*연결된 선행 문서 없음/);
    await next.selectOption('revision');
    await expect(
      page.getByText('연결되지 않은 흐름', { exact: false }),
    ).toBeVisible();
    await expect(paths.getByLabel('초안 작성 → 수정본 작성')).toBeVisible();
    await expect(paths.getByLabel('초안 검토 → 수정본 작성')).toHaveCount(0);
    await expect(paths.getByText('연결 없음', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '흐름 저장', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('하나의 흐름');
    await editor.selectOption('revision');
    await page.getByRole('button', { name: '단계 연결', exact: true }).click();
    await next.selectOption('review');
    await expect(editor.locator('option').last()).toHaveText('3. 초안 검토');
    await next.selectOption('draft');
    await expect(page.getByRole('alert')).toContainText('순환');
    await page.getByRole('button', { name: '변경 취소' }).click();
    await expect(editor).toHaveValue('revision');
    await editor.selectOption('draft');
    await page.getByRole('button', { name: '흐름 설정', exact: true }).click();
    await page.getByLabel('흐름 이름').fill('브라우저 검증 흐름');
    await page.getByLabel('입력 자료').fill('가상 원본 자료');
    await page.getByRole('button', { name: '단계 속성', exact: true }).click();
    await page
      .getByRole('button', { name: '추가', exact: true })
      .press('Enter');
    await expect(page.getByLabel('편집할 단계').locator('option')).toHaveCount(
      4,
    );
    await page.getByLabel('단계 제목').fill('임시 작업');
    await page.getByRole('button', { name: '단계 연결', exact: true }).click();
    await page.getByRole('button', { name: '뒤로 이동' }).press('Enter');
    await expect(
      page.getByLabel('편집할 단계').locator('option').nth(2),
    ).toHaveText('3. 임시 작업');
    await page
      .getByRole('button', { name: '되돌리기', exact: true })
      .press('Enter');
    await expect(
      page.getByLabel('편집할 단계').locator('option').nth(1),
    ).toHaveText('2. 임시 작업');
    await expect(
      page.getByRole('button', { name: '단계 연결', exact: true }),
    ).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: '단계 삭제' }).press('Enter');
    await expect(page.getByLabel('편집할 단계').locator('option')).toHaveCount(
      3,
    );
    await page.getByLabel('편집할 단계').selectOption('draft');
    await page.getByLabel('작업 지침').fill('브라우저에서 편집한 지침');
    await page
      .getByRole('button', { name: '도구와 권한', exact: true })
      .click();
    await page.getByLabel('담당 도구').selectOption('unassigned');
    await page
      .getByRole('button', { name: '흐름 저장', exact: true })
      .press('Enter');
    await expect(
      page.getByText('저장된 버전 1', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '저장한 버전 실행' }),
    ).toBeDisabled();
    const toolsPanel = page.getByRole('button', {
      name: '도구와 권한',
      exact: true,
    });
    if ((await toolsPanel.getAttribute('aria-expanded')) === 'false')
      await toolsPanel.click();
    await page.getByLabel('담당 도구').selectOption('codex');
    await page.getByLabel('작업 스킬').selectOption('source-check');
    await page.getByText('업무 설계서', { exact: true }).click();
    await page.getByLabel('업무 목표').fill('자료에 맞는 소개문 만들기');
    await page.getByLabel('완료 기준').fill('주소와 영업시간이 정확함');
    await page.getByLabel('추가할 단계 유형').selectOption('ai-review');
    await page
      .getByRole('button', { name: '추가', exact: true })
      .press('Enter');
    const steps = page.getByLabel('편집할 단계');
    const plan = page.getByRole('list', { name: '단계별 결과 전달' });
    await expect(plan.getByRole('listitem').nth(1)).toContainText('AI 검토');
    await steps.selectOption('revision');
    await page.getByRole('button', { name: '단계 연결', exact: true }).click();
    await page.getByText('전달받을 문서', { exact: true }).click();
    await page
      .getByRole('checkbox', { name: '직전 작업 문서 자동 연결' })
      .uncheck();
    await page
      .getByRole('checkbox', { name: '초안 작성', exact: true })
      .check();
    await expect(
      page.getByRole('checkbox', { name: 'AI 검토', exact: true }),
    ).toBeChecked();
    await expect(plan.getByRole('listitem').last()).toContainText(
      'AI 검토, 초안 작성',
    );
    await expect(
      page.getByRole('status', { name: '선행 문서 연결' }),
    ).toContainText('직접 선택');
    await expect(
      page.getByRole('status', { name: '선행 문서 연결' }),
    ).toContainText('초안 작성');
    await steps.selectOption({ label: '2. AI 검토' });
    await page.getByRole('button', { name: '단계 연결', exact: true }).click();
    await page.getByRole('button', { name: '단계 삭제' }).press('Enter');
    await page
      .getByRole('button', { name: '흐름 저장', exact: true })
      .press('Enter');
    await expect(
      page.getByText('저장된 버전 2', { exact: true }),
    ).toBeVisible();
    await expect(plan.getByRole('listitem').last()).not.toContainText(
      'AI 검토',
    );
    await page
      .getByRole('button', { name: '되돌리기', exact: true })
      .press('Enter');
    await page
      .getByRole('button', { name: '흐름 저장', exact: true })
      .press('Enter');
    await expect(
      page.getByText('저장된 버전 3', { exact: true }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '흐름 목록' }).click();
    await page
      .getByLabel('저장한 흐름')
      .selectOption({ label: '브라우저 검증 흐름 · v3' });
    await page.getByRole('button', { name: '흐름 열기' }).press('Enter');
    await expect(page.getByLabel('작업 지침')).toHaveValue(
      '브라우저에서 편집한 지침',
    );
    await expect(page.getByLabel('작업 스킬')).toHaveValue('source-check');
    let releaseDocument!: () => void;
    const documentReady = new Promise<void>((resolve) => {
      releaseDocument = resolve;
    });
    await page.route('**/api/runs/*/results/*', async (route) => {
      await documentReady;
      await route.fallback();
    });
    await page.getByRole('button', { name: '저장한 버전 실행' }).press('Enter');
    await expect(page.getByText('검토 후 계속할까요?')).toBeVisible();
    expect(prompts).toHaveLength(2);
    expect(JSON.parse(prompts[1]!)).toMatchObject({
      task: 'AI 검토',
      priorDocument: '가상 초안 결과\n',
    });
    expect(JSON.parse(prompts[0]!)).toMatchObject({
      workflow: {
        goal: '자료에 맞는 소개문 만들기',
        doneWhen: '주소와 영업시간이 정확함',
      },
      instructions: '브라우저에서 편집한 지침',
      source: '가상 원본 자료',
      skill: expect.stringContaining('자료의 사실'),
    });
    await expect(
      page.getByRole('button', { name: '승인하고 계속' }),
    ).toBeDisabled();
    releaseDocument();
    await expect(page.locator('[data-markdown-source]')).toHaveText(reviewText);
    await expect(
      page.getByRole('button', { name: '승인하고 계속' }),
    ).toBeEnabled();
    await page.evaluate(() => sessionStorage.removeItem('studio-run'));
    await page.reload();
    await page.getByRole('link', { name: '실행 현황' }).click();
    const pending = page.getByRole('button', { name: '사용자 확인 대기 1' });
    await pending.click();
    await page.getByRole('button', { name: '검토 열기' }).click();
    await page.getByRole('button', { name: '검토할 문서 열기' }).tap();
    await expect(page.locator('[data-markdown-source]')).toHaveText(reviewText);
    const reader = page.getByRole('region', { name: '실행 상세' });
    expect(
      await reader.evaluate((el) => el.scrollHeight > el.clientHeight),
    ).toBe(true);
    const jump = page.getByRole('button', { name: '검토로 이동' });
    await jump.tap();
    await expect(page.getByText('검토 후 계속할까요?')).toBeInViewport();
    const approve = page.getByRole('button', { name: '승인하고 계속' });
    await expect(approve).toBeEnabled();
    await approve.tap();
    await expect(
      page.getByText('버전 3 · 완료', { exact: true }),
    ).toBeVisible();
    expect(prompts).toHaveLength(3);
    expect(JSON.parse(prompts[2]!)).toMatchObject({
      currentStepId: 'revision',
      inputDocuments: [
        { text: reviewText + '\n' },
        { stepId: 'draft', text: '가상 초안 결과\n' },
      ],
    });
    await page.getByRole('button', { name: 'revision.md' }).press('Enter');
    await expect(page.locator('[data-markdown-body]')).toContainText(
      '가상 수정 결과',
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByText('실행 로그', { exact: true }).click();
    await expect(
      page.getByRole('list', { name: '최근 실행 이벤트' }),
    ).toContainText('완료');
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole('button', { name: '저장 흐름 편집' }).click();
    await expect(
      page.getByRole('heading', { name: '다음 실행의 GPT 설정' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '단계 속성', exact: true }).click();
    await expect(page.getByLabel('작업 지침')).toHaveValue(
      '브라우저에서 편집한 지침',
    );
    await editor.selectOption({ label: '2. AI 검토' });
    const aiId = await editor.inputValue();
    const graph = page.locator('.react-flow');
    await graph.getByRole('button', { name: 'Fit View', exact: false }).click();
    const handle = (id: string, side: string) =>
      graph.locator(`[data-id="${id}"] .react-flow__handle.${side}`);
    const edge = graph.locator('.react-flow__edge').first();
    await edge.focus();
    await edge.press('Delete');
    await expect(graph.locator('.react-flow__edge')).toHaveCount(2);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect(graph.locator('.react-flow__edge')).toHaveCount(3);
    await handle(aiId, 'source').dragTo(handle('revision', 'target'));
    await expect(
      page.getByText('연결되지 않은 흐름', { exact: false }),
    ).toBeVisible();
    await handle('revision', 'source').dragTo(handle('review', 'target'));
    await expect(editor.locator('option').last()).toHaveText('4. 초안 검토');
    await page.getByRole('link', { name: '실행 현황' }).click();
    await page.goBack();
    await expect(editor.locator('option').last()).toHaveText('4. 초안 검토');
    await page.getByRole('button', { name: '흐름 저장', exact: true }).click();
    await expect(
      page.getByText('저장된 버전 4', { exact: true }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '흐름 목록' }).click();
    await page
      .getByLabel('저장한 흐름')
      .selectOption({ label: '브라우저 검증 흐름 · v4' });
    await page.getByRole('button', { name: '흐름 열기', exact: true }).click();
    await expect(editor.locator('option').last()).toHaveText('4. 초안 검토');
    await page
      .getByRole('button', { name: 'GPT 실행 설정', exact: true })
      .click();
    const model = page.getByLabel('모델', { exact: true });
    await expect(model).toHaveValue('');
    await model.selectOption('custom');
    await page.getByLabel('모델 ID', { exact: true }).fill('gpt-6.1-sol');
    await model.selectOption({ label: 'Sol (gpt-6.2-sol)' });
    await expect(page.getByLabel('모델 ID', { exact: true })).toHaveCount(0);
    await page.getByLabel('추론 강도').selectOption('medium');
    await page.getByRole('button', { name: '저장한 버전 실행' }).click();
    await page.getByText('AI 실행 설정과 호출 기록', { exact: true }).click();
    await expect(
      page.getByText('요청 모델 gpt-6.2-sol · 추론 강도 medium'),
    ).toBeVisible();
    await expect(page.getByText('검토 후 계속할까요?')).toBeVisible();
    expect(
      prompts.slice(3).map((prompt) => JSON.parse(prompt).currentStepId),
    ).toEqual(['draft', aiId, 'revision']);
    await page.getByRole('button', { name: '작업 중단' }).click();
    await expect(
      page.getByText('버전 4 · 중단됨', { exact: false }),
    ).toBeVisible();
  } finally {
    await app.close();
    await rm(folder, { recursive: true, force: true });
  }
});
