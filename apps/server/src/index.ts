import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildApp } from './app.js';

const dataDir = fileURLToPath(new URL('../../../.local/', import.meta.url));
const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const app = await buildApp(
  join(dataDir, 'studio.sqlite'),
  existsSync(webRoot) ? webRoot : undefined,
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({ host: '127.0.0.1', port: 4310 });
  console.info('Workplot: http://127.0.0.1:4310');
} catch (error) {
  console.error(error);
  await app.close();
  process.exitCode = 1;
}
