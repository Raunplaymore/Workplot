import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('loss of the server IPC channel kills a job that cannot finish on its own', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-supervisor-test-'));
  try {
    await writeFile(join(dir, 'codex'), '#!/bin/sh\nexec sleep 60\n', {
      mode: 0o700,
    });
    const guard = fork(
      new URL('../src/codex-supervisor.ts', import.meta.url),
      [],
      {
        env: { PATH: dir + ':/bin' },
        execArgv: [],
        silent: true,
      },
    );
    const exit = once(guard, 'exit');
    try {
      const [pid] = await once(guard, 'message');
      expect(typeof pid).toBe('number');
      process.kill(pid, 'SIGSTOP');
      expect(process.kill(-pid, 0)).toBe(true);
      guard.disconnect();
      await expect(exit).resolves.toEqual([1, null]);
      for (const target of [pid, -pid]) {
        expect(() => process.kill(target, 0)).toThrowError(
          expect.objectContaining({ code: 'ESRCH' }),
        );
      }
    } finally {
      if (guard.connected) guard.disconnect();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
