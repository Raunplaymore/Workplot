import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
const dir = process.env.STUDIO_QA_DIR;
if (!dir) throw new Error('npm run qa 로 실행하세요.');
export default defineConfig({
  testDir: '..',
  workers: 1,
  timeout: 180_000,
  outputDir: join(dir, 'browser'),
  reporter: [['list'], ['json', { outputFile: join(dir, 'browser.json') }]],
  projects: [
    { name: 'browser', testMatch: 'e2e/*.spec.ts' },
    { name: 'codex', testMatch: 'qa/live.spec.ts' },
  ],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    browserName: 'chromium',
    viewport: { width: 1360, height: 900 },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node qa/server.mjs',
    cwd: '..',
    url: 'http://127.0.0.1:5173/api/health',
    reuseExistingServer: false,
  },
});
