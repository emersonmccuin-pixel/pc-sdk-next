import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

// PC-SDK Next defaults stay separate from the working PC-SDK instance. The
// environment overrides still support additional isolated test instances.
const WEB_PORT = Number(process.env.PC_DEV_WEB_PORT ?? 5175);
const API_PORT = Number(process.env.PC_DEV_API_PORT ?? 5124);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
        // During a server-restart window the upstream is briefly unreachable.
        // http-proxy's `error` event fires only on a connection failure (a real
        // 500 passes through untouched), so map it to 503 + Retry-After. The
        // http client's bounded retry rides the window out instead of surfacing
        // a cold-load 500.
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            const httpRes = res as ServerResponse;
            if (httpRes && 'writeHead' in httpRes && !httpRes.headersSent) {
              httpRes.writeHead(503, {
                'Content-Type': 'application/json',
                'Retry-After': '1',
              });
              httpRes.end(JSON.stringify({ ok: false, error: 'api restarting' }));
            }
          });
        },
      },
      '/ws': { target: `ws://127.0.0.1:${API_PORT}`, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
