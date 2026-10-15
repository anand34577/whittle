/** Every starter template must build cleanly with the real kernel. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { loadFont, setOC } from "replicad";
import { Builder } from "../../../packages/kernel/src/build";
import { TEMPLATES } from "../src/state/templates";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
  const buf = readFileSync(require.resolve("@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff"));
  await loadFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, "sans");
});

describe("templates", () => {
  for (const t of TEMPLATES) {
    it(`builds ${t.title}`, () => {
      const r = new Builder().regen(t.build(), "final");
      const bad = r.status.filter((s) => s.state !== "ok");
      expect(bad, JSON.stringify(bad)).toHaveLength(0);
      expect(r.bodies.length).toBeGreaterThan(0);
      for (const b of r.bodies) expect(b.volume).toBeGreaterThan(0);
    });
  }
});
