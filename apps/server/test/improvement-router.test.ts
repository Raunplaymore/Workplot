import { it, expect } from 'vitest';
import { routeImprovements } from '../src/improvement-router.js';
const roles = { screen: '화면', feature: '기능' };
const doc = (text: string) => ({ kind: 'document' as const, text });

it.each([[], ['feature'], ['screen'], ['screen', 'feature']])(
  'runs selected routes %j',
  async (...args) => {
    const routes = args.filter((arg): arg is string => typeof arg === 'string');
    const started: string[] = [];
    const result = await routeImprovements(
      roles,
      '{}',
      new AbortController().signal,
      async (prompt, _signal, phase) => {
        const { selectedRole } = JSON.parse(prompt);
        expect(phase).toBe(selectedRole ? 'review' : 'select');
        if (!selectedRole)
          return doc(JSON.stringify({ reason: '계획 근거', routes }));
        started.push(selectedRole);
        await Promise.resolve();
        expect(started.length).toBe(routes.length);
        return doc(selectedRole + ' 결과');
      },
    );
    expect(started).toHaveLength(routes.length);
    expect(result.text).toContain('계획 근거');
  },
);
it('rejects unknown routes before dispatch', async () => {
  let calls = 0;
  await expect(
    routeImprovements(roles, '{}', new AbortController().signal, async () => {
      calls++;
      return doc('{"routes":["other"],"reason":"test"}');
    }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
