import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';

async function bind(port: number) {
  const server = createServer((socket) => socket.destroy());
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

// Each QA port has a companion reservation on loopback which stays open
// across npm build, browser startup and teardown, even across server processes.
export async function reserveQaPort() {
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = randomInt(20000, 35000);
    try {
      const lease = await bind(port + 30000);
      try {
        const probe = await bind(port);
        await new Promise<void>((resolve, reject) =>
          probe.close((err) => (err ? reject(err) : resolve())),
        );
        return { port, release: () => lease.close() };
      } catch (error) {
        lease.close();
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw Error('사용 가능한 QA 포트를 확보하지 못했습니다.');
}
