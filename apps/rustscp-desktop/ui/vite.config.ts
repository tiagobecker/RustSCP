import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const now = new Date();
const pad = (n: number) => n.toString().padStart(2, '0');
const buildTimestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
const buildNumber = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

/** App version from tauri.conf.json (the version that ships), falling back to package.json. */
function readAppVersion(): string {
  const candidates = ['../src-tauri/tauri.conf.json', './package.json'];
  for (const rel of candidates) {
    try {
      const json = JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));
      if (typeof json.version === 'string' && json.version) return json.version;
    } catch {
      // try the next source
    }
  }
  return 'dev';
}

/** Release builds run natively on each OS in CI, so the build host describes the target. */
function describeBuildTarget(): string {
  const os =
    process.platform === 'darwin'
      ? 'macOS'
      : process.platform === 'win32'
        ? 'Windows'
        : process.platform === 'linux'
          ? 'Linux'
          : process.platform;
  const webview = process.platform === 'darwin' ? 'WKWebView' : process.platform === 'win32' ? 'WebView2' : 'WebKitGTK';
  return `${os} ${process.arch} (Tauri ${webview})`;
}

export default defineConfig({
  plugins: [react()],
  base: './',
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify(readAppVersion()),
    __BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
    __BUILD_NUMBER__: JSON.stringify(buildNumber),
    __BUILD_TARGET__: JSON.stringify(describeBuildTarget()),
  },
});
