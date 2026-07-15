import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
    fileParallelism: false,
    setupFiles: ['tsx/cjs'],
  },
});
