import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 30_000,
    include: ['tests/**/*.test.ts'],
    reporters: ['verbose'],
  },
});
