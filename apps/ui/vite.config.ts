import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    // Windows 上 Node 把 localhost 解析成 ::1 时，Vite 只监听 IPv6。
    // 浏览器若走 127.0.0.1:5173 会直接连接失败。固定绑 IPv4，与 core-service 的 127.0.0.1 一致。
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  envPrefix: 'VITE_',
});
