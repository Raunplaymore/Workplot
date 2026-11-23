import { expect, test } from 'vitest';
import { verificationRecovery } from '../src/verification-recovery.js';
test('recovers the observed QA failure for the same task and ignores an unrelated score', () => {
  const previous = {
    runId: 'prior',
    results: {
      'change-evidence.md':
        '1440px와 390px 기준 화면을 확보하지 못했다.\nQA 실행: listen EPERM',
      'verified-commit.md': '세션 검증 미충족 · 커밋 생략',
    },
  };
  expect(verificationRecovery(previous)).toMatchObject({
    sourceRun: 'prior',
    resumeAt: 'QA 서버 기동',
  });
  expect(
    verificationRecovery({
      ...previous,
      results: { 'change-evidence.md': '개발 과제 0/2' },
    }),
  ).toBeUndefined();
});
