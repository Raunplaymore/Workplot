import { spawn } from 'node:child_process';

// The IPC channel closes even when SIGKILL prevents the server's shutdown hooks.
if (!process.connected) process.exit(1);
const cli = spawn('codex', process.argv.slice(2), {
  detached: true,
  stdio: 'inherit',
});
function killOwnedGroup() {
  if (!cli.pid) return;
  try {
    process.kill(-cli.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
process.once('disconnect', killOwnedGroup);
cli.once('error', () => process.exit(1));
cli.once('exit', (code) => {
  killOwnedGroup();
  process.exit(code ?? 1);
});
if (cli.pid)
  process.send!(cli.pid, (error) => {
    if (error) killOwnedGroup();
  });
