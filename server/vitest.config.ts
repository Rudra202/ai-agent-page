import { defineConfig } from 'vitest/config';

/**
 * Unit and API tests. They use the in-memory repositories and never touch the real
 * database, the OpenAI API or the secrets in .env: every external setting is blanked here.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/*.live.test.ts', 'node_modules/**'],
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: '',
      MONGODB_USER: '',
      MONGODB_PASSWORD: '',
      MONGODB_HOST: '',
      AI_PROVIDER: 'rules',
      GEMINI_API_KEY: '',
      OPENAI_API_KEY: '',
      BCRYPT_ROUNDS: '4',
      JWT_SECRET: 'unit-test-secret-unit-test-secret-0123456789',
    },
  },
});
