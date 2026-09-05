import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    typecheck: { enabled: true, include: ['test/**/*.test-d.ts'] },
  },
});
