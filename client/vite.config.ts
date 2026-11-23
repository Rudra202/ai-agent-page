import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  // Vite shuts the dev server down when the terminal it was started from closes its input. Some terminals and
  // launchers do that right after start, which looks like the server crashing. "CI" turns that behaviour off.
  // (Only for the dev server: tests and builds are left alone.)
  if (command === 'serve' && !process.env.VITEST) process.env.CI ??= 'true';

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      // If 5173 is taken (an old dev server still running), stop with a clear message instead of quietly
      // starting on 5174. A site on another port is not an address the server accepts, which shows up as "Origin not allowed".
      strictPort: true,
      proxy: {
        // Forward API calls to the Express server during development.
        '/api': { target: process.env.TAJIR_API_URL ?? 'http://localhost:4000', changeOrigin: true },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      css: false,
      testTimeout: 20000,
    },
  };
});
