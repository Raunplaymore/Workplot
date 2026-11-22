import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
const root = process.env.STUDIO_QA_DIR!;
export default defineConfig({
  testDir: '.',
  testMatch: 'first-use.spec.ts',
  workers: 1,
  timeout: 450000,
  outputDir: join(root, 'first-use-browser'),
  reporter: [['list'], ['json', { outputFile: join(root, 'first-use.json') }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    actionTimeout: 15000,
    viewport: { width: 1360, height: 900 },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node qa/server.mjs',
    cwd: '..',
    url: 'http://127.0.0.1:5173/api/health',
    reuseExistingServer: false,
    env: { STUDIO_QA_DIR: join(root, 'first-use'), STUDIO_FIRST_USE: '1' },
  },
});
