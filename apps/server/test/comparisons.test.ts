import { describe, expect, it } from 'vitest';
import { applyParts, type FactReport } from '@studio/contracts';
import { checkedFacts, comparisonParts } from '../src/comparisons.js';
const example: FactReport = {
  address: {
    status: 'known',
    evidence: ['새길 2'],
    original: { quote: '옛길 1', verdict: 'mismatch' },
    revision: { quote: '새길 2', verdict: 'match' },
  },
  hours: {
    status: 'known',
    evidence: ['11시'],
    original: { quote: '9시', verdict: 'mismatch' },
    revision: { quote: '11시', verdict: 'match' },
  },
};
describe('문서 비교', () => {
  it('같은 문장의 두 사실을 개별 선택하고 본문과 줄바꿈을 보존한다', () => {
    const a = '가게는 옛길 1에서 9시에 엽니다.\n',
      b = '가게는 새길 2에서 11시에 엽니다!\n';
    const parts = comparisonParts(a, b, example);
    expect(applyParts(parts, [])).toBe(a);
    expect(
      applyParts(parts, [parts.findIndex((p) => p.label === '주소')]),
    ).toBe('가게는 새길 2에서 9시에 엽니다.\n');
    expect(
      applyParts(
        parts,
        parts.map((_, i) => i),
      ),
    ).toBe(b);
    for (const [old, next] of [
      ['옛길 1 옛길 1', '새길 2'],
      ['9시 옛길 1', '새길 2 11시'],
      ['', '새길 2\n'],
    ] as const) {
      const diff = comparisonParts(old, next, example);
      expect(applyParts(diff, [])).toBe(old);
      expect(
        applyParts(
          diff,
          diff.map((_, i) => i),
        ),
      ).toBe(next);
    }
  });
  it('존재하지 않는 인용을 거부하고 충돌을 일치로 판정하지 않는다', () => {
    expect(() =>
      checkedFacts(example, '근거 없음', '옛길 1 9시', '새길 2 11시'),
    ).toThrow();
    const f = structuredClone(example);
    f.hours.status = 'conflict';
    f.hours.evidence = ['9시', '11시'];
    expect(
      checkedFacts(f, '새길 2 9시 11시', '옛길 1 9시', '새길 2 11시').hours
        .revision.verdict,
    ).toBe('uncertain');
  });
});
