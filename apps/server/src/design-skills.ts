import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { DesignSkill } from '@studio/contracts';

const project = fileURLToPath(new URL('../../../', import.meta.url));
const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

type Entry = {
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  scope: string;
};

async function discover() {
  const child = spawn('codex', ['app-server'], {
    cwd: project,
    timeout: 10000,
    killSignal: 'SIGKILL',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  // A CLI that exits during its handshake also closes the input pipe.
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const send = (message: object) =>
    child.stdin.write(JSON.stringify(message) + '\n');
  try {
    await once(child, 'spawn');
    send({
      method: 'initialize',
      id: 1,
      params: { clientInfo: { name: 'workplot', version: '0.1' } },
    });
    for await (const line of lines) {
      const reply = JSON.parse(line);
      if (reply.error) throw new Error('Codex skill discovery failed');
      if (reply.id === 1) {
        send({ method: 'initialized' });
        send({ method: 'skills/list', id: 2, params: { cwds: [project] } });
      }
      if (reply.id === 2) {
        const entries: Entry[] = reply.result.data[0].skills;
        return entries
          .filter(
            (e) =>
              e.enabled &&
              isAbsolute(e.path) &&
              basename(e.path) === 'SKILL.md',
          )
          .map((e) => ({
            id: sha256(e.name + '\0' + e.path),
            title: e.name,
            description: e.description,
            scope: e.scope,
            path: e.path,
          }));
      }
    }
    throw new Error('Codex skill discovery stopped');
  } finally {
    lines.close();
    child.stdin.destroy();
    child.kill();
  }
}

let pending: ReturnType<typeof discover> | undefined;
function inventory() {
  return (pending ??= discover().finally(() => {
    pending = undefined;
  }));
}

export async function listDesignSkills() {
  return (await inventory()).map(({ id, title, description, scope }) => ({
    id,
    title,
    description,
    scope,
  }));
}

export async function readDesignSkill(
  id: string,
): Promise<DesignSkill | undefined> {
  const entry = (await inventory()).find((item) => item.id === id);
  if (!entry) return;
  const { path, ...summary } = entry;
  let instructions: string;
  try {
    instructions = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  return { ...summary, digest: sha256(instructions), instructions };
}
