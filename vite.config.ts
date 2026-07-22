import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Tauri injects these when it drives the dev server; they are absent for plain web dev.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],

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

  // Tauri expects a fixed port and must not fall back to a random one.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 5174 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },

  envPrefix: ['VITE_', 'TAURI_'],

  build: {
    // Tauri v2 ships a modern webview on every target platform.
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: !!process.env.TAURI_DEBUG,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
