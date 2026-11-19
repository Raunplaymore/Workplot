import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import base from './playwright.config.js';
const dir = process.env.STUDIO_QA_DIR!;
export default defineConfig({
  ...base,
  webServer: undefined, // Each crash test owns its server child and waits for its exit.
  projects: [{ name: 'recovery', testMatch: 'qa/recovery.spec.ts' }],
  outputDir: join(dir, 'recovery-browser'),
  reporter: [['list'], ['json', { outputFile: join(dir, 'recovery.json') }]],
});
