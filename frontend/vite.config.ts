import { defineConfig } from "vite";

// API 进程：.venv/bin/python -m uvicorn app.main:app --port 8031
const API = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.YUCHAO_API ?? "http://127.0.0.1:8031";

export default defineConfig({
  server: {
    port: 5178,
    proxy: {
      "/api": { target: API, changeOrigin: true },
    },
  },
  build: { target: "es2022", sourcemap: false },
});
