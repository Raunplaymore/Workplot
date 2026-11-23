import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredInputFields, type WorkflowVersion } from '@studio/contracts';

export const personalSkills = join(homedir(), '.agents', 'skills');
const launcher = fileURLToPath(
  new URL('../../../scripts/start-workplot.mjs', import.meta.url),
);
const marker = /^<!-- workplot-export ([a-f0-9-]{36}) ([1-9]\d*) -->$/m;
export class SkillConflict extends Error {}

function content(name: string, flow: WorkflowVersion, port: number) {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const description =
    flow.definition.name.replace(/[\r\n]+/g, ' ') +
    ' 워크플롯을 새 자료로 실행하고 결과 또는 사용자 검토 링크를 제공한다.';
  const fields = requiredInputFields(flow.definition);
  return [
    '---',
    'name: ' + name,
    'description: ' + JSON.stringify(description),
    '---',
    '',
    '<!-- workplot-export ' + flow.id + ' ' + flow.version + ' -->',
    '',
    '사용자가 실행을 요청하면 이번 대화에서 제공한 자료를 사용한다. 자료가 없으면 먼저 요청한다.',
    ...(fields.length
      ? [
          '필요한 자료 항목은 ' +
            JSON.stringify(fields) +
            '이다. 사용자가 준 값을 해당 이름으로 표시하고 없는 사실을 만들지 않는다.',
        ]
      : []),
    '다음 명령을 한 번 실행한다. 표준입력으로 이번 원본 자료를 UTF-8 텍스트로 전달한다. 절대 경로이므로 현재 작업 폴더에서 실행할 수 있다.',
    '',
    '```sh',
    'node ' + quote(launcher) + ' ' + flow.id + ' ' + flow.version + ' ' + port,
    '```',
    '',
    '출력의 실행 상태와 Workplot 링크를 사용자에게 전달한다. 승인 또는 질문은 사용자가 그 화면에서 처리한다. 같은 요청의 응답이 끊기면 출력된 실행 ID로 상태를 확인한다. 재전송이 필요하면 같은 명령 끝에 기존 실행 ID를 붙여 같은 자료를 보낸다.',
    '서버에 연결되지 않으면 로컬 Workplot을 먼저 시작하도록 안내한다. 이 스킬에서 문서 단계를 독립적으로 대신 수행하지 않는다.',
    '',
  ].join('\n');
}

function ownedFile(dir: string) {
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
  const path = join(dir, 'SKILL.md');
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > 32768) return;
  const text = readFileSync(path, 'utf8');
  const match = marker.exec(text);
  return match && { id: match[1], version: Number(match[2]), text };
}

export function exportedSkills(id: string, root = personalSkills) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const current = ownedFile(join(root, entry.name));
    return current && current.id === id
      ? [{ name: entry.name, version: current.version }]
      : [];
  });
}

export function installWorkflowSkill(
  name: string,
  flow: WorkflowVersion,
  expected: number | null,
  lookup: (version: number) => WorkflowVersion,
  root = personalSkills,
  port: number = 4310,
) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
    throw new SkillConflict();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = join(root, name),
    path = join(dir, 'SKILL.md');
  const text = content(name, flow, port);
  if (expected === null) {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new SkillConflict();
      throw error;
    }
    try {
      writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      try {
        rmdirSync(dir);
      } catch {
        /* preserve any concurrent file */
      }
      throw error;
    }
  } else {
    const current = ownedFile(dir);
    if (
      !current ||
      current.id !== flow.id ||
      current.version !== expected ||
      current.text !== content(name, lookup(expected), port)
    )
      throw new SkillConflict();
    const temp = join(dir, '.workplot-' + randomUUID());
    try {
      writeFileSync(temp, text, { flag: 'wx', mode: 0o600 });
      renameSync(temp, path);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  return { name, version: flow.version };
}
