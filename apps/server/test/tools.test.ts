import { expect, test, vi } from 'vitest';
import { detectTools } from '../src/tools.js';
import { buildApp } from '../src/app.js';

test('versions do not imply authentication or readiness', async () => {
  const result = await detectTools(async (id) =>
    id === 'claude' ? '2.1.293 (Claude Code)\n' : 'codex-cli 0.166.0\n',
  );
  expect(result.map((t) => t.status)).toEqual(['detected', 'detected']);
  expect(result.map((t) => t.authentication)).toEqual([
    'unchecked',
    'unchecked',
  ]);
});

test('missing tools and execution errors are distinct and raw output is not exposed', async () => {
  const result = await detectTools(async (id) => {
    throw Object.assign(new Error('private raw error'), {
      code: id === 'claude' ? 'ENOENT' : 'EACCES',
    });
  });
  expect(result.map((t) => t.status)).toEqual(['not_found', 'check_failed']);
  expect(JSON.stringify(result)).not.toContain('private');
  const invalid = await detectTools(async () => 'unexpected private output');
  expect(
    invalid.every((t) => t.status === 'check_failed' && t.version === null),
  ).toBe(true);
});

test('concurrent status requests share one inspection', async () => {
  const inspect = vi.fn(() => detectTools(async () => 'codex-cli 0.166.0'));
  const app = await buildApp(':memory:', undefined, inspect);
  try {
    const responses = await Promise.all([
      app.inject('/api/tools'),
      app.inject('/api/tools'),
    ]);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(responses[0]?.headers['cache-control']).toBe('no-store');
  } finally {
    await app.close();
  }
});
