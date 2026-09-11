import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const now = new Date();
const pad = (n: number) => n.toString().padStart(2, '0');
const buildTimestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
const buildNumber = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

export default defineConfig({
  plugins: [react()],
  base: './',
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify('0.1.0'),
    __BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
    __BUILD_NUMBER__: JSON.stringify(buildNumber),
    __BUILD_TARGET__: JSON.stringify('macOS (Tauri WKWebView)'),
  },
});
