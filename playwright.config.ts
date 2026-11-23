import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: 'http://127.0.0.1:' + process.env.WORKPLOT_TEST_PORT,
    browserName: 'chromium',
  },
  webServer: {
    command: 'node qa/server.mjs',
    env: { WORKPLOT_QA_PORT: '0' },
    wait: { stdout: /Workplot QA port (?<workplot_test_port>\d+)/ },
    reuseExistingServer: false,
  },
});
