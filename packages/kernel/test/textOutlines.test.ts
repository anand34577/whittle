/** Text in a sketch comes out as closed outlines for 2D export (DXF, SVG). */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { loadFont, setOC } from "replicad";
import { type SketchFeature, makeEntity, makeSketch, newDocument } from "@whittle/core";
import { textOutlines } from "../src/inspect";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasm = require.resolve("replicad-opencascadejs/wasm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => wasm }));
  const buf = readFileSync(require.resolve("@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff"));
  await loadFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, "sans");
});

it("outlines every letter, holes included", () => {
  const doc = newDocument();
  const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
  const t = makeEntity("text", [5, 2], [6, 3]);
  if (t.type === "text") {
    t.text = "Hello";
    t.size = "10";
  }
  sk.entities.push(t);
  doc.features.push(sk);
  const [item] = textOutlines(doc);
  // H, e (outside and the eye), l, l, o (outside and inside).
  expect(item?.loops.length).toBe(7);
  const xs = item!.loops.flat().map((p) => p[0]);
  expect(Math.min(...xs)).toBeGreaterThan(4);
  expect(Math.max(...xs)).toBeLessThan(5 + 40);
});
