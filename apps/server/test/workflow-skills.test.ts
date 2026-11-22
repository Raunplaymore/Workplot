import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import type { WorkflowVersion } from '@studio/contracts';
import {
  exportedSkills,
  installWorkflowSkill,
  SkillConflict,
} from '../src/workflow-skills.js';

test('register a pinned personal skill; update explicitly and leave unrelated or edited files intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'workplot-skill-test-'));
  const id = '10000000-0000-4000-8000-000000000001';
  const lookup = (version: number): WorkflowVersion => ({
    id,
    version,
    savedAt: '2026-11-20T00:00:00.000Z',
    definition: {
      name: '매장 안내',
      input: '이전 비공개 자료',
      steps: [
        {
          id: 'draft',
          title: '초안',
          kind: 'task',
          instructions: '비공개 노드 지침',
          position: { x: 0, y: 0 },
        },
      ],
      links: [],
    },
  });
  const put = (name: string, v: number, previous: number | null) =>
    installWorkflowSkill(name, lookup(v), previous, lookup, root);
  try {
    const file = join(root, 'shop-intro', 'SKILL.md');
    put('shop-intro', 1, null);
    const original = readFileSync(file, 'utf8');
    expect(original).toContain(id + ' 1');
    expect(original).not.toMatch(/이전 비공개 자료|비공개 노드 지침/);
    expect(exportedSkills(id, root)).toEqual([
      { name: 'shop-intro', version: 1 },
    ]);
    expect(() => put('shop-intro', 2, null)).toThrow(SkillConflict);
    put('shop-intro', 2, 1);
    expect(readFileSync(file, 'utf8')).toContain(id + ' 2');
    expect(() => put('shop-intro', 3, 1)).toThrow(SkillConflict);
    writeFileSync(file, original + 'personal edits');
    expect(() => put('shop-intro', 2, 1)).toThrow(SkillConflict);
    mkdirSync(join(root, 'existing'));
    writeFileSync(join(root, 'existing', 'SKILL.md'), 'personal');
    expect(() => put('existing', 1, null)).toThrow(SkillConflict);
    symlinkSync(join(root, 'existing'), join(root, 'alias'));
    expect(() => put('alias', 1, null)).toThrow(SkillConflict);
    expect(() => put('../escape', 1, null)).toThrow(SkillConflict);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
