// Team-owned regression case for the Workplot session loop. Runs from the base revision.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const observation =
  '# 구현·검증 기록\n변경 없음.\n실제 검사:\n브라우저 실측: 390px 통과';
const program = `
  import { repeatsUnchangedChecks as repeats } from './apps/server/src/repeated-checks.ts';
  const previous = ${JSON.stringify(observation)};
  console.log(JSON.stringify([repeats(previous, previous), repeats(previous.replace('390px', '1440px'), previous)]));
`;
const observed = execFileSync(
  process.execPath,
  ['--input-type=module', '--eval', program],
  { encoding: 'utf8', timeout: 10000 },
);
assert.deepEqual(JSON.parse(observed), [true, false]);
