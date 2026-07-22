import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': r('./src'),
      '@core': r('./src/core'),
      '@storage': r('./src/storage'),
      '@search': r('./src/search'),
      '@renderer': r('./src/renderer'),
      '@state': r('./src/state'),
      '@ui': r('./src/ui'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    reporters: 'default',
  },
});
