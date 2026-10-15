/** Tangent chains: one click on a rounded outline takes the whole outline. */
import { createRequire } from "node:module";
import { beforeAll, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { type RectEntity, type SketchFeature, makeExtrude, makeSketch, newDocument, uid } from "@whittle/core";
import { Builder } from "../src/build";
import { tangentChain } from "../../../apps/web/src/state/edgeChain";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
});

it("chains the straight edges and corner arcs of a rounded top outline, and nothing else", () => {
  const doc = newDocument();
  const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
  const rect: RectEntity = { id: uid("e"), type: "rect", x: "0", y: "0", w: "40", h: "30", anchor: "center", corner: "5" };
  sk.entities.push(rect);
  doc.features.push(sk, makeExtrude(doc, sk.id, "new"));
  doc.bodies[doc.features[1]!.id] = { name: "Body 1", color: "#ccc", visible: true };
  const r = new Builder().regen(doc, "final");
  expect(r.status.every((s) => s.state === "ok")).toBe(true);
  const edges = r.bodies[0]!.edges;
  // A vertical straight edge of the box (parallel to Z) belongs to no horizontal outline chain with the top.
  const topLine = edges.findIndex((e) => e.curve === "LINE" && e.mid[2] > 9 && Math.abs(e.tangent[2]) < 0.1);
  const chain = tangentChain(edges, topLine);
  // 4 lines + 4 arcs on the top outline.
  expect(chain).toHaveLength(8);
  for (const i of chain) expect(edges[i]!.mid[2]).toBeGreaterThan(9);
  // The rounded vertical corner edges are tangent to nothing at their ends (perpendicular to the outline).
  const vertical = edges.findIndex((e) => Math.abs(e.tangent[2]) > 0.9);
  expect(tangentChain(edges, vertical)).toHaveLength(1);
});
