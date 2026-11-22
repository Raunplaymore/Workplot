import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyUiWorkspace } from './ui-work.js';

type Sources = Record<string, string>;
type Branch = { id: string; files: Sources };
export async function integrateUiSources(
  root: string,
  base: Sources,
  branches: Branch[],
  signal: AbortSignal,
) {
  const target = join(root, 'master-integrations');
  await mkdir(target, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(target, 'candidate-'));
  const merged = { ...base },
    changed = new Set<string>();
  const stages: { branch: string; files: string[]; checks?: string }[] = [];
  let verifiedStage: string | undefined;
  for (const branch of branches) {
    const files = Object.keys(branch.files).filter(
      (name) => branch.files[name] !== base[name],
    );
    if (
      Object.keys(base).some((name) => !(name in branch.files)) ||
      files.some((name) => !Object.hasOwn(base, name))
    )
      return {
        status: 'failed',
        reason: '작업본 파일 목록이 기준선과 다릅니다.',
        directory,
      };
    const conflicts = files.filter(
      (name) => changed.has(name) && merged[name] !== branch.files[name],
    );
    if (conflicts.length)
      return {
        status: 'conflict',
        files: conflicts,
        branch: branch.id,
        directory,
        verifiedStage,
      };
    const stage = { branch: branch.id, files, checks: '' };
    stages.push(stage);
    for (const file of files) {
      merged[file] = branch.files[file]!;
      changed.add(file);
    }
    if (!files.length) continue;
    const work = join(directory, 'stage-' + stages.length);
    await mkdir(join(work, 'src'), { recursive: true });
    for (const [name, text] of Object.entries(merged))
      await writeFile(join(work, 'src', name), text);
    try {
      stage.checks = await verifyUiWorkspace(work, signal);
      if (!stage.checks.includes(' · 통과') || stage.checks.includes(' · 미달'))
        throw Error('브라우저 회귀 검사 미달');
    } catch (e) {
      await writeFile(
        join(directory, 'stages.json'),
        JSON.stringify(stages, null, 2),
      );
      return {
        status: 'failed',
        branch: branch.id,
        verifiedStage,
        reason: e instanceof Error ? e.message : '검사 실패',
        directory,
      };
    }
    verifiedStage = work;
    await writeFile(
      join(directory, 'stages.json'),
      JSON.stringify(stages, null, 2),
    );
  }
  return {
    status: changed.size ? 'verified' : 'unchanged',
    files: [...changed],
    verifiedStage,
    directory,
  };
}
