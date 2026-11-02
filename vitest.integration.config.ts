import { defineConfig } from 'vitest/config';
let isolatedDatabase = false;
try {
  const url = new URL(process.env.TEST_DATABASE_URL || '');
  isolatedDatabase =
    ['postgres:', 'postgresql:'].includes(url.protocol) && url.pathname.endsWith('_test');
} catch {
  /* Never echo a malformed credential URL. */
}
if (!isolatedDatabase || !process.env.TEST_REDIS_URL)
  throw new Error(
    'Use npm run test:integration for owned services; direct runners require explicit isolated TEST_DATABASE_URL and TEST_REDIS_URL',
  );
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
