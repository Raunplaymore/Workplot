import { reserveQaPort } from './qa-port.js';
import { promisify } from 'node:util';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { constants } from 'node:fs';
import { copyFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import { git } from './git-worktree.js';

// Candidate scripts can only write to the disposable checkout and its private home.
// Never fall back to running project scripts with the server's permissions.
async function runNpm(
  cwd: string,
  scratch: string,
  args: string[],
  signal: AbortSignal,
  qaPort?: number,
  independent?: string,
) {
  signal.throwIfAborted();
  if (process.platform !== 'darwin')
    throw Error('이 환경에는 격리된 npm 검사 실행기가 없습니다.');
  const node = await realpath(process.execPath);
  const bin = dirname(node),
    toolchain = dirname(bin);
  const developer = await realpath(
    execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' }).trim(),
  );
  const gitBin = join(developer, 'usr', 'bin');
  const home = join(scratch, 'home');
  await mkdir(home, { recursive: true });
  const browsers = join(homedir(), 'Library/Caches/ms-playwright');
  // Allow tool discovery using the installed CLI, keeping credentials outside the sandbox.
  const codex = qaPort
    ? await promisify(execFile)('/usr/bin/which', ['codex'])
        .then((r) => r.stdout.trim())
        .catch(() => '')
    : '';
  const cliFile = codex ? await realpath(codex) : '';
  const cliRoot = cliFile.endsWith('/@openai/codex/bin/codex.js')
    ? dirname(dirname(cliFile))
    : cliFile;
  const browserProfile = qaPort
    ? `
    (allow network-bind network-inbound (local ip "localhost:${qaPort}"))
    (allow network-outbound (remote ip "localhost:${qaPort}"))
    (allow file-read* (subpath (param "BROWSERS")))
    ${codex ? '(allow file-read* (literal (param "CODEX_LINK")) (subpath (param "CODEX_CODE")))' : ''}
    (allow mach-register mach-lookup (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer."))
  `
    : '';
  const profile = `(version 1) (deny default) (import "system.sb")
    (allow process-exec process-fork sysctl-read)
    (allow signal (target children) (target same-sandbox))
    ${browserProfile}
    (allow file-read-metadata)
    (allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/System") (subpath "/Library/Apple") (subpath "/private/etc") (subpath "/dev") (subpath (param "DEVELOPER_USR")) (subpath (param "TOOLCHAIN")) (subpath (param "SCRATCH")))
    (allow file-write* (subpath (param "${independent === undefined ? 'SCRATCH' : 'PRIVATE_HOME'}")) (literal "/dev/null"))`;
  const cli = join(toolchain, 'lib/node_modules/npm/bin/npm-cli.js');
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      '/usr/bin/sandbox-exec',
      [
        '-D',
        'TOOLCHAIN=' + toolchain,
        '-D',
        'DEVELOPER_USR=' + join(developer, 'usr'),
        '-D',
        'SCRATCH=' + scratch,
        '-D',
        'PRIVATE_HOME=' + home,
        '-D',
        'BROWSERS=' + browsers,
        '-D',
        'CODEX_LINK=' + (codex || '/dev/null'),
        '-D',
        'CODEX_CODE=' + (cliRoot || '/dev/null'),
        '-p',
        profile,
        node,
        ...(independent === undefined
          ? [cli, ...args]
          : ['--input-type=module', '--eval', independent]),
      ],
      {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: [
            bin,
            ...(codex ? [dirname(codex)] : []),
            gitBin,
            '/usr/bin',
            '/bin',
          ].join(':'),
          GIT_EXEC_PATH: join(developer, 'usr/libexec/git-core'),
          HOME: home,
          TMPDIR: home,
          ...(qaPort && {
            WORKPLOT_QA_PORT: String(qaPort),
            PLAYWRIGHT_BROWSERS_PATH: browsers,
            STUDIO_QA_DIR: home,
          }),
          CI: '1',
          npm_config_offline: 'true',
          npm_config_audit: 'false',
          npm_config_fund: 'false',
          npm_config_userconfig: '/dev/null',
        },
      },
    );
    let log = '',
      timeout = false;
    const capture = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-8000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const stop = () => {
      if (child.pid)
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
    };
    const timer = setTimeout(() => {
      timeout = true;
      stop();
    }, 120000);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.on('exit', stop);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      const label =
        independent === undefined ? 'npm ' + args.join(' ') : '팀 필수 검사';
      if (code === 0 && !timeout && !signal.aborted)
        resolve(label + ' · 통과\n' + log.trim());
      else
        reject(
          Error(
            label +
              ' · ' +
              (timeout
                ? '시간 초과'
                : signal.aborted
                  ? '중단'
                  : '실패 (' + code + ')') +
              '\n' +
              log.trim(),
          ),
        );
    });
  });
}
// Seed only the content-addressed archives explicitly pinned by the candidate lockfile.
// npm verifies their integrity and unpacks them using a private cache.
async function seedOfflineCache(
  common: string,
  candidate: string,
  scratch: string,
) {
  const content = await git(
    common,
    'show',
    candidate + ':package-lock.json',
  ).catch(() => {
    throw Error('의존성을 재현할 package-lock.json이 없습니다.');
  });
  const lock = JSON.parse(content) as {
    packages?: Record<string, { integrity?: string }>;
  };
  const digests = new Set(
    Object.values(lock.packages ?? {}).map((p) => p.integrity),
  );
  for (const integrity of digests) {
    const m = /^(sha512|sha256|sha1)-([A-Za-z0-9+/]+=*)$/.exec(integrity ?? '');
    if (!m) continue;
    const hex = Buffer.from(m[2]!, 'base64').toString('hex');
    if (
      hex.length !==
      ({ sha512: 128, sha256: 64, sha1: 40 } as Record<string, number>)[m[1]!]
    )
      continue;
    const path = join(
      '_cacache',
      'content-v2',
      m[1]!,
      hex.slice(0, 2),
      hex.slice(2, 4),
      hex.slice(4),
    );
    const target = join(scratch, 'home', '.npm', path);
    await mkdir(dirname(target), { recursive: true });
    try {
      await copyFile(
        join(homedir(), '.npm', path),
        target,
        constants.COPYFILE_FICLONE,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}
// Read the team check from the target commit and execute it before any candidate script.
export async function checkTeamPolicy(
  common: string,
  base: string,
  candidate: string,
  checkout: string,
  scratch: string,
  signal: AbortSignal,
) {
  const ref = base + ':.workplot/required-check.mjs';
  const program = await git(common, 'show', ref).catch(() => {
    throw Error(
      '대상 브랜치에 팀 필수 검사 .workplot/required-check.mjs가 없습니다.',
    );
  });
  if (!program.trim()) throw Error('팀 필수 검사 내용이 비어 있습니다.');
  const policy = (await git(common, 'rev-parse', ref)).trim();
  await runNpm(checkout, scratch, [], signal, undefined, program);
  return { policy, base, candidate };
}
export async function checkCandidate(
  common: string,
  base: string,
  candidate: string,
  checkout: string,
  scratch: string,
  signal: AbortSignal,
) {
  async function manifest(sha: string) {
    try {
      return JSON.parse(await git(common, 'show', sha + ':package.json')) as {
        name?: string;
        scripts?: Record<string, string>;
        dependencies?: object;
        devDependencies?: object;
        workspaces?: unknown;
      };
    } catch {
      throw Error('저장소 루트의 package.json과 test 스크립트가 필요합니다.');
    }
  }
  const original = await manifest(base),
    merged = await manifest(candidate);
  if (!original.scripts?.test?.trim())
    throw Error('기준 커밋에 npm test가 없어 통합 후보를 검증할 수 없습니다.');
  const workplot = original.name === 'agent-workflow-studio';
  const commands = ['typecheck', 'build', 'test', 'test:e2e'].filter(
    (k) => original.scripts?.[k] || merged.scripts?.[k],
  );
  const logs: string[] = [];
  try {
    if (
      [merged.dependencies, merged.devDependencies].some(
        (v) => v && Object.keys(v).length,
      ) ||
      merged.workspaces
    ) {
      await seedOfflineCache(common, candidate, scratch);
      logs.push(
        await runNpm(
          checkout,
          scratch,
          ['ci', '--offline', '--ignore-scripts'],
          signal,
        ),
      );
    }
    for (const name of commands) {
      if (
        !merged.scripts?.[name] ||
        (original.scripts?.[name] &&
          merged.scripts[name] !== original.scripts[name])
      )
        throw Error('기준 검사 명령이 달라졌습니다: ' + name);
      // Recognize the legacy Workplot config pinned to the live port. Its tests and script
      // run unchanged, with an alternate Playwright webServer in the disposable checkout.
      const browserQA =
        workplot &&
        name === 'test:e2e' &&
        merged.scripts[name] === 'npm run build && playwright test';
      const args = ['run', name];
      if (!browserQA) {
        logs.push(await runNpm(checkout, scratch, args, signal));
        continue;
      }
      const lease = await reserveQaPort();
      try {
        const { port } = lease;
        const filename = 'workplot-candidate.playwright.config.ts';
        const fixture = 'workplot-qa-server.mjs';
        // Older committed fixtures listen on 5173 and enforce that exact Host.
        // Adapt those two QA-only literals inside the disposable server process.
        await copyFile(
          new URL('../../../qa/candidate-server.mjs', import.meta.url),
          join(checkout, fixture),
          constants.COPYFILE_EXCL,
        );
        await writeFile(
          join(checkout, filename),
          [
            "import config from './playwright.config';",
            "export default {...config, workers:1, use:{...config.use,baseURL:'http://127.0.0.1:" +
              port +
              "'},webServer:{command:'node " +
              fixture +
              "', wait:{stdout:/Workplot QA port " +
              port +
              '\\b/},reuseExistingServer:false}};',
          ].join('\n'),
          { flag: 'wx' },
        );
        args.push('--', '--config', filename);
        logs.push(
          'QA http://127.0.0.1:' +
            port +
            '\n' +
            (await runNpm(checkout, scratch, args, signal, port)),
        );
      } finally {
        lease.release();
      }
    }
    return logs.join('\n');
  } catch (err) {
    throw Error(
      [...logs, err instanceof Error ? err.message : String(err)].join('\n'),
      { cause: err },
    );
  }
}
