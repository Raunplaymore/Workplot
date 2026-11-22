import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import * as ui from '../src/ui-work.js';
import { integrateUiSources } from '../src/master-integration.js';
const base = { 'App.tsx': 'original', 'style.css': 'original' };
const a = { id: 'a', files: { ...base, 'App.tsx': 'first' } };
const signal = new AbortController().signal;
let root: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});
test('conflicting branch preserves the accepted first stage', async () => {
  root = await mkdtemp(join(tmpdir(), 'wp-integration-'));
  const check = vi
    .spyOn(ui, 'verifyUiWorkspace')
    .mockResolvedValue('검사 · 통과');
  const r = await integrateUiSources(
    root,
    base,
    [a, { id: 'b', files: { ...base, 'App.tsx': 'second' } }],
    signal,
  );
  expect(r).toMatchObject({
    status: 'conflict',
    branch: 'b',
    files: ['App.tsx'],
  });
  expect(check).toHaveBeenCalledTimes(1);
  expect(await readFile(join(r.directory, 'stage-1/src/App.tsx'), 'utf8')).toBe(
    'first',
  );
});
test('a failed browser check on the combined stage keeps its evidence and prior passing source', async () => {
  root = await mkdtemp(join(tmpdir(), 'wp-integration-'));
  vi.spyOn(ui, 'verifyUiWorkspace')
    .mockResolvedValueOnce('검사 · 통과')
    .mockResolvedValueOnce('검사 · 미달');
  const r = await integrateUiSources(
    root,
    base,
    [a, { id: 'b', files: { ...base, 'style.css': 'second' } }],
    signal,
  );
  expect(r).toMatchObject({
    status: 'failed',
    branch: 'b',
    verifiedStage: join(r.directory, 'stage-1'),
  });
  expect(await readFile(join(r.directory, 'stage-2/src/App.tsx'), 'utf8')).toBe(
    'first',
  );
  expect(
    await readFile(join(r.directory, 'stage-1/src/style.css'), 'utf8'),
  ).toBe('original');
  expect(await readFile(join(r.directory, 'stages.json'), 'utf8')).toContain(
    '미달',
  );
});
