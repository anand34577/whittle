import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Files under public/, relative to it. */
const publicFiles = (dir = r("public"), base = ""): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? publicFiles(`${dir}/${d.name}`, `${base}${d.name}/`) : [`${base}${d.name}`]));

/**
 * Writes the offline service worker (sw.js) with this build's version and file list in it.
 * The version hashes the built names (which carry content hashes), the static files and the worker itself, so any change makes a new version.
 */
function offlineWorker(): Plugin {
  return {
    name: "whittle-offline",
    apply: "build",
    generateBundle(_, bundle) {
      const built = Object.keys(bundle).filter((f) => !f.endsWith(".map"));
      const extra = publicFiles();
      const files = ["./", ...[...built, ...extra].sort().map((f) => `./${f}`)];
      const hash = createHash("sha256").update(files.join(" "));
      for (const f of extra) hash.update(readFileSync(r(`public/${f}`)));
      const worker = readFileSync(r("sw.js"), "utf8");
      const version = hash.update(worker).digest("hex").slice(0, 12);
      this.emitFile({ type: "asset", fileName: "sw.js", source: `const BUILD = ${JSON.stringify({ version, files })};\n${worker}` });
    },
  };
}

export default defineConfig({
  root: r("."),
  base: "./",
  plugins: [react(), offlineWorker()],
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