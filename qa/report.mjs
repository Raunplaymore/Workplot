import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeReport(dir, checks) {
  function read(name) {
    const file = join(dir, name);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  }
  const unit = read('unit.json');
  const browser = read('browser.json');
  const lines = [
    '# 워크플로 QA 실행 결과',
    '',
    ...Object.entries(checks).map(
      ([name, status]) => '- ' + name + ' · ' + status,
    ),
    '',
    unit
      ? '서버·계약 검사 ' +
        unit.numPassedTests +
        ' / ' +
        unit.numTotalTests +
        '건 통과. [Vitest 결과](unit.json)'
      : '서버 검사 결과 미수집.',
    '',
    ...(read('git-worktrees.json')
      ? [
          '[G2 실제 Git worktree · Codex 병렬 실행 기록](git-worktrees.json)',
          '',
        ]
      : []),
    ...(read('git-promotion.json')
      ? ['[G4 원본 반영·서버 복구 기록](git-promotion.json)', '']
      : []),
    ...(read('git-integration.json')
      ? ['[G3 실제 Codex 통합 큐 기록](git-integration.json)', '']
      : []),
    '| 브라우저 검사 | 판정 | 상태 및 증거 |',
    '| --- | --- | --- |',
  ];
  function addSuite(suite, file) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const passed = test.results.at(-1)?.status === 'passed';
        const label = passed
          ? '통과'
          : (test.results.at(-1)?.status ?? '미실행');
        const code = /^Q\d+/.exec(spec.title)?.[0];
        const evidence = code && read(code + '.json');
        const detail = evidence?.id
          ? [
              evidence.dashboard,
              ...(evidence.facts
                ? [`[비교 화면](${code}-comparison.png)`]
                : []),
              ...(evidence.results ?? []),
              '[기록](' + code + '.json)',
              '[로그](' +
                (evidence.caseDir ? evidence.caseDir + '/' : '') +
                'runs/' +
                evidence.id +
                '/events.jsonl)',
            ]
              .filter(Boolean)
              .join(' · ')
          : (code === 'Q29' || code === 'Q30') && evidence
            ? `[질문](${code}-question.png) · [답변 후 와이어](${code}-wire.png) · [호출 및 저장 기록](${code}.json)`
            : (code === 'Q27' || code === 'Q28' || code === 'Q36') && evidence
              ? '[설계 와이어](' +
                code +
                '-wire.png) · [설계 및 업무 호출 기록](' +
                code +
                '.json)'
              : code === 'Q39' && evidence
                ? '[추천 화면](Q39-match.png) · [선택 후 입력](Q39-material.png) · [실행 증거](Q39.json)'
                : '[브라우저 결과](' + file + ')';
        lines.push('| ' + spec.title + ' | ' + label + ' | ' + detail + ' |');
      }
    }
    for (const child of suite.suites ?? []) addSuite(child, file);
  }
  if (browser) addSuite(browser, 'browser.json');
  else lines.push('| 브라우저 전체 | 결과 미수집 | 실행 콘솔 확인 |');
  const firstUse = read('first-use.json');
  if (firstUse) addSuite(firstUse, 'first-use.json');
  const recovery = read('recovery.json');
  if (recovery) addSuite(recovery, 'recovery.json');
  else lines.push('| 서버 강제 종료 복구 | 결과 미수집 | 실행 콘솔 확인 |');
  lines.push(
    '',
    'Q01–Q13은 [CLI 호출 기록](cli.jsonl), Q14–Q26은 각 사례의 기록에서 강제 종료 전후의 CLI 호출과 PID를 확인할 수 있다.',
    '',
  );
  writeFileSync(join(dir, 'report.md'), lines.join('\n'));
}
