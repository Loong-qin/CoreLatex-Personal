import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const apiTarget = process.env.API_TARGET || 'http://127.0.0.1:3333';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/collab': { target: apiTarget.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vue: ['vue', 'vue-router', 'pinia'],
          'element-plus': ['element-plus', '@element-plus/icons-vue'],
          codemirror: [
            'codemirror',
            '@codemirror/autocomplete',
            '@codemirror/commands',
            '@codemirror/language',
            '@codemirror/search',
            '@codemirror/state',
            '@codemirror/view',
          ],
          echarts: ['echarts'],
          pdfjs: ['pdfjs-dist'],
          yjs: ['yjs', 'y-websocket', 'y-codemirror.next'],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
});
