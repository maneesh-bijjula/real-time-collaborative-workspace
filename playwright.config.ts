import { defineConfig } from '@playwright/test';

let isolatedDatabase = false;
try {
  const url = new URL(process.env.DATABASE_URL || '');
  isolatedDatabase =
    ['postgres:', 'postgresql:'].includes(url.protocol) && url.pathname.endsWith('_test');
} catch {
  /* Report only the fixed guard message. */
}
if (process.env.E2E_MANAGED_RUN !== '1' || !isolatedDatabase)
  throw new Error(
    'Use npm run test:e2e for owned test services or validated disposable external services',
  );

export default defineConfig({
  testDir: './tests/e2e',
  // Playwright clears outputDir at startup. Keep benchmark evidence outside it.
  outputDir: './test-results/browser',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: process.env.E2E_EXTERNAL
    ? undefined
    : {
        command: 'npm run start -w apps/web',
        url: process.env.E2E_BASE_URL!,
        reuseExistingServer: false,
        timeout: 120_000,
        env: { NEXT_TELEMETRY_DISABLED: '1', HOSTNAME: '127.0.0.1' },
      },
});
