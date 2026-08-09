import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'hidden/**/*.test.ts'],
    environment: 'node',
  },
});
