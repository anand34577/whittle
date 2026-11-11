import { describe, expect, it } from "vitest";
import { type SketchFeature, addConstraint, addLine, addPoint, makeSketch, newDocument, sketchCountText, sketchCounts, uid } from "../src";

const sketch = () => makeSketch(newDocument(), { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
const line = (sk: SketchFeature, a: string, b: string) => {
  const id = addLine(sk, a, b);
  if (typeof id !== "string") throw new Error("line");
  return id;
};

describe("sketch counts, one rule everywhere (audit B-4)", () => {
  it("a whole-shape rectangle is one closed shape", () => {
    const sk = sketch();
    sk.entities.push({ id: uid(), type: "rect", x: "0", y: "0", w: "60", h: "40", anchor: "corner" });
    expect(sketchCountText(sk)).toBe("1 closed shape");
  });

  it("four lines sharing corners are one closed shape, not four or eight", () => {
    const sk = sketch();
    const p = [addPoint(sk, [0, 0]), addPoint(sk, [60, 0]), addPoint(sk, [60, 40]), addPoint(sk, [0, 40])];
    for (let i = 0; i < 4; i++) line(sk, p[i]!, p[(i + 1) % 4]!);
    expect(sketchCounts(sk)).toEqual({ shapes: 1, loose: 0 });
  });

  it("lines joined by coincident relations close too, and an open run is a loose line", () => {
    const sk = sketch();
    const a = [addPoint(sk, [0, 0]), addPoint(sk, [10, 0])];
    const b = [addPoint(sk, [10, 0]), addPoint(sk, [5, 8])];
    const c = [addPoint(sk, [5, 8]), addPoint(sk, [0, 0])];
    line(sk, a[0]!, a[1]!);
    line(sk, b[0]!, b[1]!);
    line(sk, c[0]!, c[1]!);
    addConstraint(sk, "coincident", [a[1]!, b[0]!]);
    addConstraint(sk, "coincident", [b[1]!, c[0]!]);
    addConstraint(sk, "coincident", [c[1]!, a[0]!]);
    line(sk, addPoint(sk, [30, 0]), addPoint(sk, [40, 0]));
    expect(sketchCountText(sk)).toBe("1 closed shape, 1 loose line");
  });

  it("an empty sketch says so", () => {
    expect(sketchCountText(sketch())).toBe("Empty");
  });
});
