import { test, expect } from 'vitest';
import { formatUiEvidenceMarkdown } from '@studio/contracts';
import { repeatsUnchangedChecks } from '../src/repeated-checks.js';
test('legacy evidence remains comparable with grouped Markdown observations', () => {
  const a = '브라우저 실측: 390px · 통과 · 선택 표시';
  const b = '브라우저 실측: 1440px · 미달 · 포커스';
  const raw = [
    '# 구현·검증 기록',
    '변경 없음.',
    '수정 전 검사 (캡처는 before/):',
    a,
    b,
    '수정 후 검사:',
    '실제 검사: 빌드 통과',
    a,
    '작업본: sample',
    '범위: 작업본',
  ].join('\n');
  const md = formatUiEvidenceMarkdown(raw);
  expect(md).toContain('## 수정 전 검사\n\n통과 1건 · 미달 1건');
  expect(md).toContain('- ' + a + '\n- ' + b);
  expect(md).toContain('## 수정 후 검사\n\n통과 1건 · 미달 0건');
  expect(formatUiEvidenceMarkdown(md)).toBe(md);
  expect(repeatsUnchangedChecks(raw, md)).toBe(true);
  const diff = '\n```diff\n+추가\n-제거\n```';
  expect(formatUiEvidenceMarkdown(raw.replace('변경 없음.', diff))).toContain(
    diff,
  );
});
