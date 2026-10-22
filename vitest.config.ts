import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/main.ts', 'src/**/types.ts'],
      thresholds: { lines: 80, statements: 80, functions: 75, branches: 70 },
    },
  },
});
