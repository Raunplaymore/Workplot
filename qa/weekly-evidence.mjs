import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

export async function writeWeeklyEvidence(dir, records, rule, page) {
  const report = (text) =>
    h(
      Markdown,
      {
        skipHtml: true,
        allowedElements: [
          'h1',
          'h2',
          'h3',
          'p',
          'ul',
          'ol',
          'li',
          'strong',
          'em',
          'blockquote',
          'code',
          'br',
        ],
        components: { h1: 'h4', h2: 'h5', h3: 'h5' },
      },
      text,
    );
  const cards = records.map((r, i) =>
    h(
      'article',
      { key: r.id },
      h(
        'header',
        null,
        h('h2', null, i + 1 + '주차 · 흐름 v' + r.version),
        h('span', null, '승인 전 수정 ' + r.edits + '회'),
      ),
      h('h3', null, '작업 기록'),
      h('p', null, r.source),
      h('h3', null, '승인된 보고서'),
      h('section', null, report(r.accepted)),
      h(
        'details',
        null,
        h('summary', null, 'Codex 초안과 공유용 최종본'),
        h('h3', null, '초안'),
        report(r.original),
        h('h3', null, '공유용 최종본'),
        report(r.final),
      ),
      h('small', null, '실행 ' + r.id),
    ),
  );
  const html =
    '<!doctype html>' +
    renderToStaticMarkup(
      h(
        'html',
        { lang: 'ko' },
        h(
          'head',
          null,
          h('meta', { charSet: 'utf-8' }),
          h('meta', {
            name: 'viewport',
            content: 'width=device-width, initial-scale=1',
          }),
          h('title', null, '두 주의 보고서'),
          h(
            'style',
            null,
            `*{box-sizing:border-box}body{margin:32px auto;padding:0 24px;max-width:1120px;color:#203b31;background:#f4f7f4;font:16px/1.6 system-ui}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:16px}article{background:white;border:1px solid #bdcfc2;border-radius:12px;padding:24px}header{display:flex;align-items:baseline;justify-content:space-between;gap:8px}header span{font-weight:650;color:#37684d}h1,h2{line-height:1.2}h2{margin:0}h3{font-size:.95rem;color:#58685e;margin:22px 0 6px}section{background:#f3f6f0;padding:18px;border-radius:8px}h4{font-size:1.2rem;margin:0}h5{margin:16px 0 4px;font-size:1rem}section p,section ul{margin:4px 0}ul{padding-left:22px}details{margin:15px 0}small,footer{color:#59665f;overflow-wrap:anywhere}footer{margin:16px 0}`,
          ),
        ),
        h(
          'body',
          null,
          h('h1', null, '두 주의 주간 보고서'),
          h('p', null, '첫 승인에서 저장한 규칙 · ' + rule),
          h('main', null, ...cards),
          h(
            'footer',
            null,
            '실제 Codex로 작성하고 예시 기록과 QA 검토 동작으로 확인했습니다.',
          ),
        ),
      ),
    );
  await writeFile(join(dir, 'comparison.html'), html);
  await writeFile(join(dir, 'evidence.json'), JSON.stringify(records, null, 2));
  await page.setContent(html);
  await page.screenshot({ path: join(dir, 'comparison.png'), fullPage: true });
}
