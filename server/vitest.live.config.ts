import { defineConfig } from 'vitest/config';

/**
 * Live checks against the real OpenAI API, using OPENAI_API_KEY from server/.env.
 * Run with: npm run test:live --workspace server
 * Without a key the tests are skipped. They send only sample text, never user data.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.live.test.ts'],
    env: { NODE_ENV: 'test' },
    testTimeout: 90_000,
    fileParallelism: false,
  },
});
