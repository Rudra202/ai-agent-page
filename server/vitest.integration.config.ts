import { defineConfig } from 'vitest/config';

/**
 * Integration tests against MongoDB Atlas, using the credentials in server/.env.
 * Each run creates a database named tajir_test_<random>, uses it, and drops only that database.
 * Run with: npm run test:integration --workspace server
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    env: { NODE_ENV: 'test', BCRYPT_ROUNDS: '4', AI_PROVIDER: 'rules', GEMINI_API_KEY: '', OPENAI_API_KEY: '' },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
