import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/state/commands";
import { score } from "../src/state/search";

const top = (q: string) =>
  COMMANDS.map((c) => ({ id: c.id, s: score(c, q, []) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => x.id);
const first = (q: string) => top(q)[0];

describe("command search understands everyday phrases (audit U-17)", () => {
  it.each([
    ["round corners", "fillet"],
    ["round edges", "fillet"],
    ["make it hollow", "shell"],
    ["hollow", "shell"],
    ["cut a hole", "hole"],
    ["save as stl", "export-stl"],
    ["move the camera", "view-home"],
    ["rename", "rename"],
    ["colour", "body-appearance"],
  ])("%s finds %s", (q, id) => {
    expect(top(q)).toContain(id);
  });

  it("the best match comes first", () => {
    expect(first("make it hollow")).toBe("shell");
    expect(first("round corners")).toBe("fillet");
    expect(first("cut a hole")).toBe("hole");
    expect(first("export 3mf")).toBe("export-3mf");
    expect(first("new design")).toBe("new");
  });

  it("a phrase with one unknown word still finds the rest", () => {
    expect(top("please make it thicker")).toContain("extrude");
  });

  it("nonsense finds nothing", () => {
    expect(top("zzqxv")).toEqual([]);
  });
});
