import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r("."),
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@whittle/core": r("../../packages/core/src/index.ts"),
      "@whittle/kernel": r("../../packages/kernel/src/index.ts"),
    },
  },
  optimizeDeps: {
    exclude: ["replicad-opencascadejs"],
  },
  worker: {
    format: "es",
  },
  server: {
    port: 5173,
    fs: { allow: [r("../..")] },
  },
  build: {
    outDir: r("dist"),
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 4000,
  },
});