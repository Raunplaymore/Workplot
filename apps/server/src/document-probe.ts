import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function checkDocumentSwitching(
  work: string,
  signal: AbortSignal,
  dist = join(work, 'dist'),
) {
  const origin = 'http://workplot.test',
    id = '00000000-0000-4000-8000-000000000001',
    wid = '00000000-0000-4000-8000-000000000002';
  const files = ['session-plan.md', 'screen-design--observe.md'],
    texts = files.map((n, i) =>
      [
        '# ' + n,
        '| 항목 | 결과 |\n| --- | --- |\n| 문서 | **확인** |',
        ...Array.from(
          { length: 75 },
          (_, j) => '문서 ' + i + ' 검토 문단 ' + j,
        ),
        '문서 ' + i + ' 끝',
      ].join('\n\n'),
    );
  const summary = {
    id,
    workflowId: wid,
    workflowVersion: 1,
    recordedAt: '2026-01-01T00:00:00.000Z',
    status: 'completed',
    provider: 'codex',
    cliVersion: '1.0.0',
  };
  const view = {
    summary,
    stepId: null,
    note: null,
    gate: null,
    results: files,
  };
  const fixtures: Record<string, unknown> = {
    '/api/health': { status: 'ok', database: 'ready', agent: 'not_connected' },
    '/api/tools': [],
    '/api/workflows': [],
    '/api/runs': [
      {
        id,
        workflowId: wid,
        workflowVersion: 1,
        recordedAt: summary.recordedAt,
        status: 'completed',
        name: '문서 전환 검증',
      },
    ],
    ['/api/runs/' + id + '/view']: view,
  };
  signal.throwIfAborted();
  const browser = await chromium.launch({
    chromiumSandbox: true,
    args: [
      '--disable-background-networking',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
  });
  const abort = () => {
    void browser.close().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  const report: {
    width: number;
    file: string;
    input: string;
    passed: boolean;
    observed: string;
  }[] = [];
  const journey: string[] = [];
  try {
    signal.throwIfAborted();
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        serviceWorkers: 'block',
        acceptDownloads: false,
      });
      await context.routeWebSocket('**/*', (ws) => ws.close());
      await context.route('**/*', async (route) => {
        const u = new URL(route.request().url());
        if (u.origin !== origin || route.request().method() !== 'GET')
          return route.abort();
        if (u.pathname in fixtures)
          return route.fulfill({ json: fixtures[u.pathname] });
        for (const [i, f] of files.entries())
          if (u.pathname === '/api/runs/' + id + '/results/' + f)
            return route.fulfill({
              contentType: 'text/plain;charset=utf-8',
              body: texts[i],
            });
        if (
          u.pathname === '/' ||
          /^\/assets\/[\w.-]+\.(js|css)$/.test(u.pathname)
        ) {
          const path = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
          return route.fulfill({
            body: await readFile(join(dist, path)),
            contentType: path.endsWith('.html')
              ? 'text/html'
              : path.endsWith('.js')
                ? 'application/javascript'
                : 'text/css',
            headers: {
              'Content-Security-Policy':
                "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'",
            },
          });
        }
        return route.fulfill({ status: 404, body: '' });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(3500);
      await page.goto(origin + '/#/runs/' + id);
      // Use the visible contents of this fixture across different snapshot renderers.
      const renderedBody = (index: number) =>
        page
          .getByRole('main')
          .getByText('문서 ' + index + ' 끝', { exact: true })
          .locator('..')
          .filter({
            has: page.getByRole('heading', {
              level: 1,
              name: files[index],
              exact: true,
            }),
          });
      const documentBody = (index: number) =>
        renderedBody(index)
          .or(
            page.locator('main pre:visible').filter({ hasText: texts[index] }),
          )
          .first();
      const sequence = width === 390 ? [0, 1, 0, 1] : [0, 1, 0];
      for (const [i, index] of sequence.entries()) {
        const file = files[index]!,
          keyboard = i === 3;
        let passed = false,
          observed = '';
        try {
          const list = page
            .getByRole('region', { name: '실행 상세' })
            .getByRole('list')
            .filter({
              has: page.getByRole('button', { name: files[0], exact: true }),
            });
          const button = list.getByRole('button', { name: file, exact: true });
          await button.scrollIntoViewIfNeeded();
          let focusVisible = true;
          if (keyboard) {
            await page.keyboard.press('Tab');
            await button.focus();
            focusVisible = await button.evaluate(
              (el) =>
                el.matches(':focus-visible') &&
                (getComputedStyle(el).outlineStyle !== 'none' ||
                  getComputedStyle(el).boxShadow !== 'none'),
            );
            await button.press('Enter');
          } else await button.click();
          const body = documentBody(index);
          await body.waitFor({ state: 'visible' });
          if (keyboard)
            focusVisible =
              focusVisible &&
              (await button.evaluate(
                (el) =>
                  el === document.activeElement && el.matches(':focus-visible'),
              ));
          const states = await Promise.all(
            files.map((f) =>
              list
                .getByRole('button', { name: f, exact: true })
                .evaluate((el) => {
                  const pressed = el.getAttribute('aria-pressed'),
                    current = el.getAttribute('aria-current');
                  if (
                    pressed !== null &&
                    current !== null &&
                    (pressed === 'true') !==
                      (current !== 'false' && current !== '')
                  )
                    return '충돌';
                  return (
                    pressed ??
                    (current && current !== 'false' ? 'true' : 'false')
                  );
                }),
            ),
          );
          const readable = await body.evaluate((el) => {
            const r = document.createRange();
            const node = el.lastElementChild?.lastChild ?? el.lastChild;
            if (!node) return false;
            r.selectNodeContents(node);
            r.collapse(false);
            const h = r.getBoundingClientRect();
            el.scrollTop = el.scrollHeight;
            el.scrollIntoView({ block: 'end' });
            const rect = r.getBoundingClientRect();
            const x = Math.max(1, Math.min(innerWidth - 1, rect.x + 1)),
              y = Math.min(innerHeight - 1, rect.bottom - 1);
            const hit = document.elementFromPoint(x, y);
            return (
              h.height > 0 &&
              y >= 0 &&
              rect.bottom <= innerHeight + 2 &&
              !!hit &&
              el.contains(hit)
            );
          });
          const clickable = await button.evaluate((el) => {
            el.scrollIntoView({ block: 'center' });
            const r = el.getBoundingClientRect();
            return (
              r.left >= 0 &&
              r.right <= innerWidth + 1 &&
              r.height > 0 &&
              el.contains(
                document.elementFromPoint(
                  r.x + r.width / 2,
                  r.y + r.height / 2,
                ),
              )
            );
          });
          passed =
            states[index] === 'true' &&
            states[1 - index] === 'false' &&
            readable &&
            clickable &&
            focusVisible;
          observed =
            '본문 일치, 선택 상태 ' +
            states.join('/') +
            ', 본문 끝 ' +
            readable +
            ', 클릭 영역 ' +
            clickable +
            (keyboard ? ', 키보드 포커스 ' + focusVisible : '');
        } catch (e) {
          signal.throwIfAborted();
          observed = '조작 실패: ' + String(e).split('\n')[0]!.slice(0, 200);
        }
        report.push({
          width,
          file,
          input: keyboard ? 'Enter' : '클릭',
          passed,
          observed,
        });
      }
      // Exercise navigation on the same synthetic run, without writing to a user workflow.
      const capture = async (name: string) => {
        await page.screenshot({
          path: join(work, width + '-' + name + '.png'),
          timeout: 5000,
        });
        return width + '-' + name + '.png';
      };
      let action = '문서 검토 → 흐름 설계';
      try {
        await capture('document');
        const finalIndex = sequence.at(-1)!;
        const rendered = renderedBody(finalIndex);
        const heading = await rendered
          .getByRole('heading', {
            level: 1,
            name: files[finalIndex],
            exact: true,
          })
          .isVisible();
        const header = await rendered
          .getByRole('columnheader', { name: '항목', exact: true })
          .isVisible();
        const emphasis = await rendered
          .locator('td strong')
          .filter({ hasText: /^확인$/ })
          .isVisible();
        const formatted = heading && header && emphasis;
        journey.push(
          '브라우저 실측: ' +
            width +
            'px Markdown 문서 제목·표·강조 · ' +
            (formatted ? '통과' : '미달') +
            ' · 제목 ' +
            heading +
            ', 표 머리글 ' +
            header +
            ', 강조 셀 ' +
            emphasis,
        );

        if (width === 1440) {
          await page.setViewportSize({ width: 1920, height: 900 });
          const card = documentBody(finalIndex).locator('..');
          const paper = card.locator('..');
          const divider = page
            .getByRole('region', { name: '실행 상세', exact: true })
            .locator('[role="separator"][aria-orientation="vertical"]')
            .first();
          const settled = () =>
            page.evaluate(
              () =>
                new Promise<void>((resolve) =>
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => resolve()),
                  ),
                ),
            );
          await settled();
          const available = await paper.evaluate(
            (el) =>
              el.clientWidth -
              parseFloat(getComputedStyle(el).paddingLeft) -
              parseFloat(getComputedStyle(el).paddingRight),
          );
          const cardWidth = Math.round((await card.boundingBox())!.width);
          const shot = '1920-layout.png';
          await page.screenshot({ path: join(work, shot), timeout: 5000 });
          let moved = 0;
          if (await divider.isVisible()) {
            await divider.focus();
            const before = (await paper.boundingBox())!.width;
            await divider.press('ArrowLeft');
            await settled();
            moved = Math.round(before - (await paper.boundingBox())!.width);
            await divider.press('ArrowRight');
          }
          const empty = Math.max(0, Math.round(available - cardWidth));
          const passed = empty <= Math.max(80, available * 0.15) && moved >= 12;
          journey.push(
            '브라우저 실측: 1920px 문서·실행 상세 공간 배분 · ' +
              (passed ? '통과' : '미달') +
              ' · 문서 영역 ' +
              Math.round(available) +
              'px, 본문 카드 ' +
              cardWidth +
              'px, 빈 폭 ' +
              empty +
              'px, 경계 이동 ' +
              moved +
              'px, 캡처 ' +
              shot,
          );
          await page.setViewportSize({ width, height: 900 });
        }
        await page
          .getByRole('link', { name: '흐름 설계', exact: true })
          .click();
        await page
          .getByRole('heading', { name: '와이어 편집기', exact: true })
          .waitFor();
        journey.push(
          '브라우저 실측: ' +
            width +
            'px ' +
            action +
            ' · 통과 · 편집기 표시, 캡처 ' +
            (await capture('editor')),
        );
        action = '흐름 설계 → 실행 현황 필터 → 결과 열기';
        await page
          .getByRole('link', { name: '실행 현황', exact: true })
          .click();
        const running = page.getByRole('button', { name: /진행 중/ }),
          all = page.getByRole('button', { name: /전체 실행/ }),
          result = page.getByRole('button', { name: '결과 열기', exact: true });
        await result.waitFor();
        await running.click();
        await result.waitFor({ state: 'hidden' });
        if ((await running.getAttribute('aria-pressed')) !== 'true')
          throw Error('필터 선택 표시 누락');
        await all.click();
        await result.waitFor();
        const shot = await capture('dashboard');
        await result.click();
        await page
          .getByRole('button', { name: files[0], exact: true })
          .waitFor();
        journey.push(
          '브라우저 실측: ' +
            width +
            'px ' +
            action +
            ' · 통과 · 목록 필터와 검토 복귀, 캡처 ' +
            shot,
        );
      } catch (e) {
        signal.throwIfAborted();
        journey.push(
          '브라우저 실측: ' +
            width +
            'px ' +
            action +
            ' · 미달 · ' +
            String(e).split('\n')[0]!.slice(0, 140),
        );
      }
      await context.close();
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await browser.close();
  }
  const lines = report.map(
    (r) =>
      '브라우저 실측: ' +
      r.width +
      'px ' +
      r.input +
      ' ' +
      r.file +
      ' · ' +
      (r.passed ? '통과' : '미달') +
      ' · ' +
      r.observed,
  );
  await writeFile(
    join(work, 'document-switching.json'),
    JSON.stringify(report, null, 2),
  );
  return [...lines, ...journey].join('\n');
}
