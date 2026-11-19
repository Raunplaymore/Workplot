import process from 'node:process';
import console from 'node:console';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { writeReport } from './report.mjs';
mkdirSync('.local', { recursive: true });
const dir = mkdtempSync(resolve('.local/qa-'));
const env = { ...process.env, STUDIO_QA_DIR: dir };
const checks = {};
function check(name, cmd, args) {
  console.log(name);
  const result = spawnSync(cmd, args, { env, stdio: 'inherit' });
  checks[name] = result.status === 0 ? 'PASS' : 'FAIL';
  writeFileSync(
    join(dir, 'checks.json'),
    JSON.stringify(checks, null, 2) + '\n',
  );
  if (result.error) console.error(result.error.message);
  return result.status === 0;
}
console.log('QA 결과', dir);
for (const name of ['typecheck', 'lint', 'format:check'])
  check(name, 'npm', ['run', name]);
if (check('build', 'npm', ['run', 'build'])) {
  check('vitest', 'node', [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--reporter=default',
    '--reporter=json',
    '--outputFile.json=' + join(dir, 'unit.json'),
  ]);
  check('crash-recovery', 'node', [
    'node_modules/@playwright/test/cli.js',
    'test',
    '--config',
    'qa/recovery.config.ts',
  ]);
  check('playwright', 'node', [
    'node_modules/@playwright/test/cli.js',
    'test',
    '--config',
    'qa/playwright.config.ts',
  ]);
}
writeReport(dir, checks);
console.log(join(dir, 'report.md'), checks);
if (Object.values(checks).includes('FAIL')) process.exitCode = 1;
