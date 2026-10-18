/** AutoConstrain adds what a drawing plainly means, once. */
import { describe, expect, it } from "vitest";
import { type SketchFeature, addLine, autoConstrain, clipGeometry, pasteGeometry } from "../src";

describe("autoConstrain", () => {
  it("joins touching ends, pins the origin corner and levels the sides, without repeating itself", () => {
    const sk: Pick<SketchFeature, "geometry" | "constraints"> = { geometry: [], constraints: [] };
    const c = [[0, 0], [40, 0], [40, 20], [0, 20]] as [number, number][];
    for (let i = 0; i < 4; i++) addLine(sk, c[i]!, c[(i + 1) % 4]!);
    addLine(sk, [5, 5], [30, 12]); // a slanted, loose line: left alone
    expect(autoConstrain(sk)).toEqual({ coincident: 5, aligned: 4 });
    const types = sk.constraints!.map((k) => k.type);
    expect(types.filter((t) => t === "horizontal")).toHaveLength(2);
    expect(types.filter((t) => t === "vertical")).toHaveLength(2);
    expect(sk.constraints!.some((k) => k.refs.includes("origin"))).toBe(true);
    expect(autoConstrain(sk)).toEqual({ coincident: 0, aligned: 0 });
  });
});

describe("sketch clipboard", () => {
  it("copies lines with their relations and pastes them under new ids, moved", () => {
    const src: Pick<SketchFeature, "geometry" | "constraints"> = { geometry: [], constraints: [] };
    const l = addLine(src, [0, 0], [10, 0]);
    autoConstrain(src); // origin + horizontal
    const clip = clipGeometry(src, [l])!;
    expect(clip.constraints.map((c) => c.type)).toEqual(["horizontal"]); // the tie to the origin stays behind
    const dst: Pick<SketchFeature, "geometry" | "constraints"> = { geometry: [], constraints: [] };
    const [nl] = pasteGeometry(dst, clip, 5, 5);
    const line = dst.geometry!.find((g) => g.id === nl)!;
    expect(line.type).toBe("line");
    expect(dst.geometry!.filter((g) => g.type === "point").map((g) => (g.type === "point" ? [g.x, g.y] : 0))).toEqual([[5, 5], [15, 5]]);
    expect(dst.constraints![0]!.refs).toEqual([nl]);
    expect(dst.geometry!.some((g) => src.geometry!.some((s) => s.id === g.id))).toBe(false);
  });
});
