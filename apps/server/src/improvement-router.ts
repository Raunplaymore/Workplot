import { z } from 'zod';
import { RunnerError } from './codex-runner.js';

const route = z.enum(['screen', 'feature']);
const selection = z.strictObject({
  reason: z.string().trim().min(1).max(2000),
  routes: z.array(route).max(2),
  sequential: z.boolean().optional(),
});
const titles = { screen: '화면 개선', feature: '기능 개선' };

export async function routeImprovements(
  roles: Record<keyof typeof titles, string>,
  context: string,
  signal: AbortSignal,
  write: (
    prompt: string,
    signal: AbortSignal,
  ) => Promise<{ kind: 'question' | 'document'; text: string }>,
) {
  const inputs = JSON.parse(context);
  const result = await write(
    JSON.stringify({
      inputs,
      roles,
      instructions:
        '현재 계획에 필요한 경로를 선택한다. 화면은 screen, 기능은 feature다. 둘 다 필요하면 둘 다, 필요 없으면 빈 배열로 답한다. 한쪽의 결과가 다른 쪽의 입력이면 routes를 실행 순서대로 적고 sequential을 true로 설정한다. text에는 JSON 객체만 쓴다. 형식은 {"reason":"선택 근거","routes":["screen"]}이다.',
    }),
    signal,
  );
  signal.throwIfAborted();
  if (result.kind !== 'document') throw new RunnerError('output');
  const decision = selection.parse(JSON.parse(result.text));
  const routes = [...new Set(decision.routes)];
  const stop = new AbortController();
  const branchSignal = AbortSignal.any([signal, stop.signal]);
  const runBranch = async (
    key: keyof typeof titles,
    precedingReport?: string,
  ) => {
    const response = await write(
      JSON.stringify({
        inputs,
        selectedRole: titles[key],
        ...(precedingReport && { precedingReport }),
        instructions: roles[key],
        selectionReason: decision.reason,
        output:
          '선택된 역할에 해당하는 개선안과 검증 방법을 다음 구현 단계에 전달한다.',
      }),
      branchSignal,
    );
    if (response.kind !== 'document' || !response.text.trim())
      throw new RunnerError('output');
    return '## ' + titles[key] + '\n\n' + response.text.trim();
  };
  const tasks: Promise<string>[] = [];
  try {
    for (const key of routes) {
      const prior = decision.sequential ? await tasks.at(-1) : undefined;
      signal.throwIfAborted();
      tasks.push(runBranch(key, prior));
    }
    const reports = await Promise.all(tasks);
    signal.throwIfAborted();
    const choices = route.options.map(
      (key) => titles[key] + ' · ' + (routes.includes(key) ? '선택' : '건너뜀'),
    );
    return {
      kind: 'document' as const,
      text: [
        '# 개선 경로 결정',
        choices.join(' / '),
        ...(routes.length === 2
          ? [decision.sequential ? '순서대로 실행' : '병렬 실행']
          : []),
        decision.reason,
        ...reports,
      ].join('\n\n'),
    };
  } finally {
    stop.abort();
    await Promise.allSettled(tasks);
  }
}
