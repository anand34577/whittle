/** The OBJ reader: comments, quads, slashed and negative indices. */
import { expect, it } from "vitest";
import { parseOBJ } from "../src/stl";

const bytes = (s: string) => new TextEncoder().encode(s);

it("splits polygons into triangles and reads every index form", () => {
  const obj = "# a square\r\nv 0 0 0\nv 1 0 0\nv 1 1 0 # corner\nv 0 1 0\nvn 0 0 1\nf 1/1/1 2//1 3 -1\n";
  const tris = parseOBJ(bytes(obj));
  expect(tris.length).toBe(2 * 9);
  expect(Array.from(tris.slice(9))).toEqual([0, 0, 0, 1, 1, 0, 0, 1, 0]);
});

it("rejects faces that point at missing vertices", () => {
  expect(() => parseOBJ(bytes("v 0 0 0\nf 1 2 3\n"))).toThrow(/damaged/);
});
