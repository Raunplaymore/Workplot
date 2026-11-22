import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { snapshotFiles } from '../src/request-files.js';
import { tmpdir } from 'node:os';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'workplot-ref-test-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it('keeps the selected text and image bytes, omitting hidden and linked folder entries', async () => {
  const folder = join(root, 'folder');
  await mkdir(folder);
  await writeFile(join(folder, 'one.md'), '최초 문서');
  await writeFile(join(folder, 'two.png'), Buffer.from([137, 80, 78, 71]));
  await writeFile(join(folder, '.env'), 'hidden');
  await symlink(join(folder, '.env'), join(folder, 'link.txt'));
  const data = await snapshotFiles({
    references: [folder, join(folder, 'one.md')],
  });
  await writeFile(join(folder, 'one.md'), '새 문서');
  expect(data.workspace).toBeUndefined();
  expect(data.refs).toHaveLength(2);
  expect(data.refs).toContainEqual({
    name: 'folder/one.md',
    text: '최초 문서',
  });
  expect(data.refs).toContainEqual({
    name: 'folder/two.png',
    image: 'iVBORw==',
  });
});
it('rejects reference and writable folder overlap without modifying the file', async () => {
  const file = join(root, 'input.md');
  await writeFile(file, 'original');
  await expect(
    snapshotFiles({ references: [file], workspace: root }),
  ).rejects.toThrow('겹치지');
  expect(await readFile(file, 'utf8')).toBe('original');
});
