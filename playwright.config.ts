import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests: the real client in Chrome, the real server behind it.
 *
 * - The server runs on its own port with in-memory data and the built-in rules (no AI key), so a run never
 *   touches the Atlas database or OpenAI and always starts empty. Uploaded files go to a scratch folder.
 * - Two projects run every test: a desktop window and a phone (Pixel 7).
 * - Chrome is the one already installed on the machine (no browser download).
 *
 * Run: npm run test:e2e
 */
const SERVER_PORT = 4100;
const CLIENT_PORT = 5273;
const ORIGIN = `http://localhost:${CLIENT_PORT}`;

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/results',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/report' }]],
  use: {
    baseURL: ORIGIN,
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel: 'chrome' } },
  ],
  webServer: [
    {
      command: 'node server/dist/index.js',
      url: `http://localhost:${SERVER_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(SERVER_PORT),
        NODE_ENV: 'development',
        CLIENT_ORIGIN: ORIGIN,
        // In-memory data, the built-in rules, scratch uploads. Blank values stop server/.env (including any real AI key) from being used.
        MONGODB_URI: '',
        MONGODB_USER: '',
        MONGODB_PASSWORD: '',
        MONGODB_HOST: '',
        AI_PROVIDER: 'rules',
        GEMINI_API_KEY: '',
        OPENAI_API_KEY: '',
        UPLOAD_DIR: '../e2e/.uploads',
        BCRYPT_ROUNDS: '4',
        // One address runs the whole suite, so it needs a bigger request budget than a person does. Production keeps 1000.
        API_RATE_LIMIT_MAX: '50000',
      },
    },
    {
      command: `npx vite --port ${CLIENT_PORT} --strictPort`,
      cwd: 'client',
      url: ORIGIN,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { TAJIR_API_URL: `http://localhost:${SERVER_PORT}` },
    },
  ],
});
