import { defineConfig } from 'vitest/config';

// Real Chromium through an in-process proxy on 127.0.0.1. Needs `npx playwright install chromium`.
export default defineConfig({
  test: { include: ['test/**/*.e2e.test.ts'], environment: 'node', testTimeout: 60_000 },
});
