import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const env = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  LANG: 'en_US.UTF-8',
};
const login = 'forced_login_method="chatgpt"';

export class RunnerError extends Error {
  constructor(
    public readonly reason: 'login' | 'cli' | 'output' | 'termination',
  ) {
    super(reason);
  }
}

export interface DocumentRunner {
  ready(): Promise<string>;
  write(
    prompt: string,
    signal: AbortSignal,
    observe: (info: { pid?: number; sessionId?: string }) => void,
  ): Promise<{ kind: 'document' | 'question'; text: string }>;
}

export const codexRunner: DocumentRunner = {
  async ready() {
    const options = {
      env,
      timeout: 5000,
      maxBuffer: 8192,
      killSignal: 'SIGKILL',
    } as const;
    let version: string | undefined;
    try {
      const { stdout } = await exec('codex', ['--version'], options);
      version = /^codex-cli (\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.exec(
        stdout.trim(),
      )?.[1];
    } catch {
      throw new RunnerError('cli');
    }
    if (!version) throw new RunnerError('cli');
    try {
      const result = await exec('codex', ['login', 'status'], options);
      if (
        !/^Logged in using ChatGPT\s*$/m.test(
          result.stdout + '\n' + result.stderr,
        )
      ) {
        throw new RunnerError('login');
      }
    } catch {
      throw new RunnerError('login');
    }
    return version;
  },

  async write(prompt, signal, observe) {
    const value = await runCodexJson(prompt, signal, observe, {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'text'],
      properties: {
        kind: { enum: ['document', 'question'] },
        text: { type: 'string' },
      },
    });
    if (
      !value ||
      typeof value !== 'object' ||
      !('kind' in value) ||
      !('text' in value) ||
      (value.kind !== 'document' && value.kind !== 'question') ||
      typeof value.text !== 'string' ||
      !value.text.trim() ||
      value.text.length > 32_000
    )
      throw new RunnerError('output');
    return { kind: value.kind, text: value.text };
  },
};

export async function runCodexJson(
  prompt: string,
  signal: AbortSignal,
  observe: Parameters<DocumentRunner['write']>[2],
  outputSchema: object,
): Promise<unknown> {
  const cwd = await mkdtemp(join(tmpdir(), 'pixel-studio-codex-'));
  try {
    const schema = join(cwd, 'response.json');
    await writeFile(schema, JSON.stringify(outputSchema), {
      mode: 0o600,
      flag: 'wx',
    });
    if (signal.aborted) throw new RunnerError('cli');
    const supervisor = join(
      import.meta.dirname,
      'codex-supervisor' + extname(import.meta.filename),
    );
    const child = spawn(
      process.execPath,
      [
        supervisor,
        'exec',
        '--ignore-user-config',
        '--ephemeral',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--disable',
        'shell_tool',
        '--disable',
        'unified_exec',
        '--disable',
        'hooks',
        '--disable',
        'plugins',
        '--disable',
        'multi_agent',
        '--disable',
        'skill_mcp_dependency_install',
        '-c',
        login,
        '-c',
        'mcp_servers={}',
        '-c',
        'web_search="disabled"',
        '-c',
        'analytics.enabled=false',
        '--json',
        '--output-schema',
        schema,
        '-',
      ],
      { cwd, env, stdio: ['pipe', 'pipe', 'ignore', 'ipc'], detached: true },
    );
    let pid: number | undefined;
    let output = '';
    let closing = false;
    let overflow = false;
    let force: NodeJS.Timeout | undefined;
    let limit: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    const signalGroup = (value: NodeJS.Signals | 0) => {
      if (!pid) return false;
      try {
        return process.kill(-pid, value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        return true; // A failed probe does not prove termination.
      }
    };
    let timedOut = false;
    let abort: () => void;
    const result = await new Promise<{
      code: number | null;
      confirmed: boolean;
    }>((resolve) => {
      function terminate() {
        if (closing) return;
        closing = true;
        if (pid) signalGroup('SIGTERM');
        else if (child.connected) child.disconnect();
        force = setTimeout(() => signalGroup('SIGKILL'), 800);
        limit = setTimeout(
          () => resolve({ code: null, confirmed: false }),
          4000,
        );
      }
      abort = terminate;
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, 120_000);
      child.once('error', terminate);
      child.once('close', (code) => {
        if (signalGroup(0)) {
          terminate();
          setTimeout(() => resolve({ code, confirmed: !signalGroup(0) }), 1000);
        } else resolve({ code, confirmed: true });
      });
      child.stdin!.on('error', () => {});
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        if (output.length + chunk.length > 524_288) {
          overflow = true;
          terminate();
        } else if (!overflow) output += chunk;
      });
      child.on('message', (value) => {
        if (typeof value === 'number' && value > 0) {
          pid = value;
          observe({ pid });
        }
      });
      child.stdin!.end(prompt);
      if (signal.aborted) terminate();
    }).finally(() => {
      if (abort) signal.removeEventListener('abort', abort);
      clearTimeout(force);
      clearTimeout(limit);
      clearTimeout(timer);
    });
    if (!result.confirmed) throw new RunnerError('termination');
    if (signal.aborted || timedOut || result.code !== 0)
      throw new RunnerError('cli');
    if (overflow) throw new RunnerError('output');
    let text: string | undefined;
    let completed = false;
    for (const line of output.split('\n').filter(Boolean)) {
      const event = JSON.parse(line);
      if (
        event.type === 'thread.started' &&
        typeof event.thread_id === 'string'
      )
        observe({ sessionId: event.thread_id });
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'item.completed') {
        if (!['agent_message', 'reasoning'].includes(event.item?.type))
          throw new RunnerError('output');
        if (event.item.type === 'agent_message') text = event.item.text;
      }
    }
    if (!completed || !text) throw new RunnerError('output');
    return JSON.parse(text);
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
