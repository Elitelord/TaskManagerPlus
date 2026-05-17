import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  // Unit tests (vitest). The suite covers framework-free logic modules
  // (workload detection, app grouping) — pure functions, no DOM needed,
  // so the lightweight `node` environment is enough.
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
  },
}));
