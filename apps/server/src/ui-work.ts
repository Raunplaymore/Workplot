import { discoverUi, reviewUi } from './visual-discovery.js';
import { formatUiEvidenceMarkdown } from '@studio/contracts';
import { checkDocumentSwitching } from './document-probe.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import {
  runCodexJson,
  RunnerError,
  type DocumentRunner,
} from './codex-runner.js';

const project = fileURLToPath(new URL('../../../', import.meta.url));
const web = join(project, 'apps/web');
const exec = promisify(execFile);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const patchSchema = z.object({
  edits: z
    .array(z.object({ before: z.string().min(1), after: z.string() }))
    .max(8),
  reason: z.string().max(1000),
});
export function applyUiEdits(
  source: string,
  edits: z.infer<typeof patchSchema>['edits'],
) {
  let result = source;
  for (const { before, after } of edits) {
    const at = result.indexOf(before);
    if (
      !before ||
      at < 0 ||
      at !== result.lastIndexOf(before) ||
      before === after
    )
      throw new RunnerError('ui_edit');
    result = result.slice(0, at) + after + result.slice(at + before.length);
  }
  if (result === source && edits.length) throw new RunnerError('ui_edit');
  return result;
}

export async function readUiSources(
  source = join(web, 'src'),
): Promise<Record<string, string>> {
  if ((await realpath(source)) !== resolve(source))
    throw new RunnerError('ui_edit');
  const entries = await readdir(source, { withFileTypes: true });
  const files: Record<string, string> = {};
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || !/^[\w.-]+\.(tsx?|css)$/.test(e.name))
      throw new RunnerError('ui_edit');
    files[e.name] = await readFile(join(source, e.name), 'utf8');
  }
  return files;
}
export async function selectUiTask(
  directory: string,
  mission: string,
  recent: { run: string; result: string }[],
  signal: AbortSignal,
  observe: Parameters<DocumentRunner['write']>[2],
) {
  const baselineDir = await mkdtemp(join(directory, 'initial-screen-'));
  const baseline = await checkDocumentSwitching(
    baselineDir,
    signal,
    join(web, 'dist'),
  );
  const files = Object.keys(await readUiSources()).filter(
    (name) => /\.(tsx|css)$/.test(name) && name !== 'main.tsx',
  );
  const finding = await discoverUi(
    baselineDir,
    files,
    files,
    JSON.stringify({
      mission,
      recentSessionResults: recent,
      selection:
        '최근 세션에서 다룬 과제와 겹치지 않는 불편을 선택하고, 최근 과제와의 차이를 설명하세요.',
    }),
    baseline,
    signal,
    observe,
    project,
  );
  const observation = { finding, recentSessions: recent.map((row) => row.run) };
  await writeFile(
    join(baselineDir, 'selection.json'),
    JSON.stringify(observation, null, 2),
  );
  return observation;
}

export async function verifyUiWorkspace(work: string, signal: AbortSignal) {
  await writeFile(
    join(work, 'tsconfig.json'),
    JSON.stringify({ extends: join(web, 'tsconfig.json'), include: ['src'] }),
  );
  await copyFile(join(web, 'index.html'), join(work, 'index.html'));
  const checks = [
    [
      join(project, 'node_modules/typescript/bin/tsc'),
      '--project',
      join(work, 'tsconfig.json'),
      '--noEmit',
    ],
    [
      join(project, 'node_modules/vite/bin/vite.js'),
      'build',
      work,
      '--config',
      join(web, 'vite.config.ts'),
      '--logLevel',
      'error',
    ],
  ];
  for (const args of checks) {
    try {
      await exec(process.execPath, args, {
        cwd: project,
        signal,
        timeout: 90000,
        maxBuffer: 256000,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new RunnerError('ui_check');
    }
  }
  const browserEvidence = await checkDocumentSwitching(work, signal).catch(
    () => {
      signal.throwIfAborted();
      throw new RunnerError('ui_browser');
    },
  );
  return browserEvidence;
}
type Context = {
  directory: string;
  previousDirectory?: string;
  initialSources?: Record<string, string>;
  discoveryMission?: string;
  referenceImages?: readonly string[];
  stepId: string;
};
export async function runUiWork(
  task: string,
  signal: AbortSignal,
  observe: Parameters<DocumentRunner['write']>[2],
  ctx: Context,
) {
  const key = 'ui-' + ctx.stepId;
  const dest = join(ctx.directory, key);
  const fingerprint = digest(task);
  // If the process stopped after publishing the workspace but before recording its document,
  // reuse the exact checked result on retry.
  const saved = await readFile(join(dest, 'record.json'), 'utf8').catch(
    (e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
      return null;
    },
  );
  if (saved) {
    const record = JSON.parse(saved);
    if (record.fingerprint !== fingerprint) throw new RunnerError('ui_edit');
    return { kind: 'document' as const, text: String(record.text) };
  }
  let source = join(web, 'src');
  if (ctx.previousDirectory) {
    const prior = join(ctx.previousDirectory, key, 'src');
    const stat = await lstat(prior).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
      return null;
    });
    if (stat) {
      if (!stat.isDirectory() || (await realpath(prior)) !== resolve(prior))
        throw new RunnerError('ui_edit');
      source = prior;
    }
  }
  const work = await mkdtemp(join(ctx.directory, '.ui-work-'));
  try {
    const src = join(work, 'src');
    await mkdir(src);
    const sources = ctx.initialSources ?? (await readUiSources(source));
    for (const [name, text] of Object.entries(sources))
      await writeFile(join(src, name), text);
    const files = Object.keys(sources).filter(
      (n) => /\.(tsx|css)$/.test(n) && n !== 'main.tsx',
    );
    const fileGuide = await Promise.all(
      files.map(async (file) => {
        const source = await readFile(join(src, file), 'utf8');
        const symbols = Array.from(
          source.matchAll(
            /(?:function|const)\s+([A-Za-z][A-Za-z0-9]*)\s*(?:\(|=\s*\()/g,
          ),
          (m) => m[1],
        );
        const headings = Array.from(
          source.matchAll(/<h[1-4][^>]*>([^<>{}]{1,80})<\//g),
          (m) => m[1],
        );
        return { file, symbols: symbols.slice(0, 160), headings };
      }),
    );
    let baseline = '';
    const previousDist = join(source, '..', 'dist');
    if (
      ctx.previousDirectory &&
      source !== join(web, 'src') &&
      (await realpath(previousDist).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      })) === resolve(previousDist)
    ) {
      const before = join(work, 'before');
      await mkdir(before);
      baseline = await checkDocumentSwitching(before, signal, previousDist);
    }
    const finding = ctx.discoveryMission
      ? await discoverUi(
          join(work, 'before'),
          files,
          fileGuide,
          ctx.discoveryMission,
          baseline,
          signal,
          observe,
          project,
        )
      : undefined;
    const selected =
      finding ??
      z
        .object({
          file: z.enum(['none', ...files]),
          reason: z.string().max(1000),
        })
        .parse(
          await runCodexJson(
            JSON.stringify({
              task,
              files: fileGuide,
              baseline,
              instruction:
                '파일의 함수와 제목을 대조해 실제 해당 동작을 소유한 React 파일을 고른다. 문서 목록에서 파일을 여는 동작은 showFile 등 실제 처리 함수가 있는 파일을 우선한다. 편집 불필요·검증 전용 또는 이 범위로 구현이 불가능하면 none과 이유를 적는다. baseline은 인계 이후 작업본에서 새로 관찰한 결과다. Markdown 검사 미달이면 결과 문서가 제목·표·강조로 표시되는지 확인한다. 1920px 공간 배분에서 빈 폭이 크거나 경계를 옮길 수 없으면 실제 레이아웃 결함으로 취급한다. 문서 카드 폭, 그리드 열, 분할 경계의 키보드·포인터 조작 중 실측으로 확인한 문제를 소유하는 CSS나 컴포넌트를 고른다. 이미 통과한 동작을 다시 고치지 말고 위임된 다음 과제에 맞는 다른 컴포넌트나 실제 미달 동작을 고른다.',
            }),
            signal,
            observe,
            {
              type: 'object',
              properties: {
                file: { enum: [...files, 'none'] },
                reason: { type: 'string' },
              },
              required: ['file', 'reason'],
              additionalProperties: false,
            },
            undefined,
            undefined,
            true,
          ),
        );
    let evidence = '변경 없음. ' + selected.reason;
    if (selected.file !== 'none') {
      const name = selected.file,
        file = join(src, name),
        original = await readFile(file, 'utf8');
      const proposal = patchSchema.parse(
        await runCodexJson(
          JSON.stringify({
            task: finding ? { mission: ctx.discoveryMission, finding } : task,
            file: name,
            sourceCode: original,
            language: name.endsWith('.css') ? 'CSS' : 'TSX',
            baseline: finding ? undefined : baseline,
            instruction:
              '이 파일에서 목표를 실제 구현할 최소 변경을 반환한다. before는 원문에 정확히 한 번 나타나는 연속 부분, after는 그 대체 문자열이다. 변경할 것이 없으면 edits는 빈 배열로 반환하고 이유를 적는다. 실행이나 테스트 성공을 주장하지 않는다.',
          }),
          signal,
          observe,
          {
            type: 'object',
            additionalProperties: false,
            required: ['edits', 'reason'],
            properties: {
              reason: { type: 'string' },
              edits: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['before', 'after'],
                  properties: {
                    before: { type: 'string' },
                    after: { type: 'string' },
                  },
                },
              },
            },
          },
          undefined,
          undefined,
          true,
          [
            ...(ctx.referenceImages ?? []),
            ...(finding ? [join(work, 'before', finding.screen)] : []),
          ],
        ),
      );
      const updated = applyUiEdits(original, proposal.edits);
      if (updated !== original) {
        const patch = createTwoFilesPatch(
          'a/apps/web/src/' + name,
          'b/apps/web/src/' + name,
          original,
          updated,
        );
        if (patch.length > 18000) throw new RunnerError('ui_edit');
        await writeFile(file, updated);
        await writeFile(join(work, 'change.patch'), patch);
        evidence = [
          '변경 파일: apps/web/src/' + name,
          proposal.reason,
          '원본 SHA256 ' + digest(original),
          '결과 SHA256 ' + digest(updated),
          '\n```diff',
          patch.trimEnd(),
          '```',
        ].join('\n');
      } else evidence = '변경 없음. ' + proposal.reason;
    }
    signal.throwIfAborted();
    const browserEvidence = await verifyUiWorkspace(work, signal);
    const review =
      finding && selected.file !== 'none'
        ? await reviewUi(work, finding, signal, observe)
        : undefined;
    if (finding)
      await writeFile(
        join(work, 'discovery.json'),
        JSON.stringify({ finding, review }, null, 2),
      );
    const text = formatUiEvidenceMarkdown(
      [
        '# 구현·검증 기록',
        evidence,
        ...(finding
          ? [
              '',
              '## 자율 화면 탐색',
              '',
              finding.reason,
              '',
              '비교 기준 · ' + finding.verification,
              '',
              '장면 · ' + finding.screen,
              '',
              review
                ? '캡처 대조 · ' + review.status + ' · ' + review.observation
                : '수정 없음',
            ]
          : []),
        '',
        ...(baseline
          ? ['수정 전 검사 (캡처는 before/):', baseline, '수정 후 검사:']
          : []),
        '실제 검사: TypeScript --noEmit 통과, Vite 프로덕션 빌드 통과.',
        browserEvidence,
        '작업본: ' + dest,
        '범위: 실행별 화면 소스 작업본. Chromium 합성 문서 전환 검사. 실사용자 검증과 운영 반영은 별도입니다.',
      ].join('\n'),
    );
    await writeFile(
      join(work, 'record.json'),
      JSON.stringify({ fingerprint, text }),
    );
    signal.throwIfAborted();
    await rename(work, dest);
    return { kind: 'document' as const, text };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
