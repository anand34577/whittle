import { createRequire } from "node:module";
import { beforeAll, describe, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { drawCircle, setOC } from "replicad";
import { type SketchFeature, createEvaluator, makeSketch, newDocument, uid } from "@whittle/core";
import { sketchDrawing } from "../src/build";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
});

describe("probe3", () => {
  it("time sketchDrawing for N circles; sequential fuse vs tree", () => {
    for (const n of [50, 100, 200]) {
      const doc = newDocument();
      const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
      for (let i = 0; i < n; i++) sk.entities.push({ id: uid(), type: "circle", cx: String((i % 20) * 12), cy: String(Math.floor(i / 20) * 12), r: "4" });
      const ev = createEvaluator([], "mm");
      let t = Date.now();
      sketchDrawing(sk, ev);
      const tSketch = Date.now() - t;
      t = Date.now();
      let d = drawCircle(4);
      for (let i = 1; i < n; i++) d = d.fuse(drawCircle(4).translate((i % 20) * 12, Math.floor(i / 20) * 12));
      const tSeq = Date.now() - t;
      t = Date.now();
      const tree = (items: ReturnType<typeof drawCircle>[]): ReturnType<typeof drawCircle> => (items.length === 1 ? items[0]! : tree(items.slice(0, items.length >> 1)).fuse(tree(items.slice(items.length >> 1))));
      tree(Array.from({ length: n }, (_, i) => drawCircle(4).translate((i % 20) * 12, Math.floor(i / 20) * 12)));
      const tTree = Date.now() - t;
      console.log(`Q4b n=${n}: sketchDrawing ${tSketch} ms; sequential fuse ${tSeq} ms; tree fuse ${tTree} ms`);
    }
  });
});
