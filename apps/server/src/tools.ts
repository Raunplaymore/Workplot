import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolStatus } from '@studio/contracts';

const exec = promisify(execFile);
async function versionOutput(tool: 'claude' | 'codex'): Promise<string> {
  const result = await exec(tool, ['--version'], {
    timeout: 5000,
    killSignal: 'SIGKILL',
    maxBuffer: 8192,
    shell: false,
  });
  return result.stdout;
}

export async function detectTools(run = versionOutput): Promise<ToolStatus[]> {
  return Promise.all(
    (['claude', 'codex'] as const).map(async (id) => {
      const base = { id, authentication: 'unchecked' as const };
      try {
        const output = (await run(id)).trim();
        const pattern =
          id === 'codex'
            ? /^codex-cli (\d+\.\d+\.\d+(?:-[\w.-]+)?)$/
            : /^(\d+\.\d+\.\d+(?:-[\w.-]+)?) \(Claude Code\)$/;
        const version = pattern.exec(output)?.[1];
        return {
          ...base,
          status: version ? ('detected' as const) : ('check_failed' as const),
          version: version ?? null,
        };
      } catch (error) {
        const absent =
          error instanceof Error && 'code' in error && error.code === 'ENOENT';
        return {
          ...base,
          status: absent ? ('not_found' as const) : ('check_failed' as const),
          version: null,
        };
      }
    }),
  );
}
