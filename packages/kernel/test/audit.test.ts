/** Regression tests from the October 2026 audit (no geometry needed). */
import { expect, it } from "vitest";
import { hex6, weld } from "../src/exporters";

it("normalises body colours for glTF and 3MF", () => {
  expect(hex6("#ccc")).toBe("cccccc");
  expect(hex6("#1A2b3C")).toBe("1A2b3C");
  expect(hex6("ff8800")).toBe("ff8800");
  expect(hex6(undefined)).toBe("cccccc");
  expect(hex6("rebeccapurple")).toBe("cccccc");
});

it("welds shared vertices and drops collapsed triangles", () => {
  const m = weld({ vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0], triangles: [0, 1, 2, 3, 4, 5, 6, 7, 8] });
  expect(m.vertices.length / 3).toBe(4);
  expect(m.triangles.length / 3).toBe(2);
});
