import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    coverage: { provider: 'v8', include: ['src/**/*.ts'], reporter: ['text', 'lcov'] },
  },
});
