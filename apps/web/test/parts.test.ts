/** Every library part must build cleanly with the real kernel. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { loadFont, setOC } from "replicad";
import { newDocument } from "@whittle/core";
import { Builder } from "../../../packages/kernel/src/build";
import { PARTS, PartBuilder } from "../src/state/parts";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
  for (const [file, name] of [
    ["ibm-plex-sans-latin-400-normal.woff", "sans"],
    ["ibm-plex-sans-latin-700-normal.woff", "bold"],
  ] as const) {
    const buf = readFileSync(require.resolve(`@fontsource/ibm-plex-sans/files/${file}`));
    await loadFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, name);
  }
});

describe("parts library", () => {
  for (const part of PARTS) {
    it(`builds ${part.title}`, () => {
      const doc = newDocument();
      const b = new PartBuilder(doc, `${part.id}1`);
      part.build(b);
      doc.parameters.push(...b.params);
      doc.features.push(...b.features);
      for (const [id, name] of b.bodyNames) doc.bodies[id] = { name, color: "#ccc", visible: true };
      const r = new Builder().regen(doc, "final");
      const bad = r.status.filter((s) => s.state !== "ok");
      expect(bad, JSON.stringify(bad)).toHaveLength(0);
      expect(r.bodies.length).toBeGreaterThan(0);
      for (const body of r.bodies) expect(body.volume).toBeGreaterThan(0);
    });
  }
});
