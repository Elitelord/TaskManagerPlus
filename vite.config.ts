import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        // Pull node_modules into one stable `vendor` chunk (react, react-dom,
        // react-query, react-virtual, lucide-react). It's large, changes
        // rarely, and caches across app updates — and it keeps the entry
        // chunk small. The heavy route chunks (Storage / Insights / Settings)
        // split out automatically from the `React.lazy` calls in App.tsx;
        // Rollup's default dedup keeps the shared singletons (settings,
        // usePerformanceData, insightsEngine, …) single-instance in the entry
        // chunk since they're all reachable from the eager entry.
        manualChunks(id) {
          if (id.includes("node_modules")) return "vendor";
        },
      },
    },
  },
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
