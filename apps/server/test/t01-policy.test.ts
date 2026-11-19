import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const script = fileURLToPath(new URL('../src/t01-probe.ts', import.meta.url));

test('local check does not request API configuration', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('API 호출 경로는 비활성화');
});

test('live flag cannot enable API use even with configuration present', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', script, '--live'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'test-not-a-real-key',
        T01_MODEL: 'test-model',
        T01_BUDGET_USD: '1',
      },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('API 사용 금지');
  expect(result.stdout).toBe('');
});
