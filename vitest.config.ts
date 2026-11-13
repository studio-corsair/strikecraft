import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}', 'apps/*/src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['packages/*/src/**', 'apps/*/src/**'],
    },
  },
});
