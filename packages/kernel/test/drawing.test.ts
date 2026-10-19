/** The 2D drawing sheet: views, scale, dimensions. */
import { createRequire } from "node:module";
import { beforeAll, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { makeBaseBox, setOC } from "replicad";
import { buildDrawingSVG } from "../src/drawing";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
});

it("draws four labelled views with dimensions at a standard scale", () => {
  const part = makeBaseBox(60, 40, 20).cut(makeBaseBox(10, 10, 30));
  const svg = buildDrawingSVG([part], { title: "Test <part>" });
  for (const l of ["FRONT", "TOP", "RIGHT", "ISOMETRIC"]) expect(svg).toContain(l);
  expect(svg).toContain("Test &lt;part&gt;");
  expect(svg).toMatch(/>2:1</);
  expect(svg).toContain(">60<");
  expect(svg).toContain(">20<");
  expect(svg).toContain(">40<");
  // The 10 mm hole shows as hidden (dashed) lines in the front view.
  expect(svg).toContain('class="hid"');
  expect(svg.match(/NaN|Infinity/)).toBeNull();
});

it("scales a big part down and a tiny part up", () => {
  expect(buildDrawingSVG([makeBaseBox(600, 400, 200)], { title: "big" })).toMatch(/>1:5</);
  expect(buildDrawingSVG([makeBaseBox(6, 4, 2)], { title: "small" })).toMatch(/>(5:1|10:1)</);
});

it("can leave hidden lines out", () => {
  const part = makeBaseBox(60, 40, 20).cut(makeBaseBox(10, 10, 30));
  expect(buildDrawingSVG([part], { title: "x", hidden: false })).not.toContain('class="hid"');
});

it("lays out an A4 sheet at a chosen scale, first-angle, with a section and a parts list", () => {
  const part = makeBaseBox(60, 40, 20).cut(makeBaseBox(10, 10, 30));
  const svg = buildDrawingSVG([part], { title: "Opts", sheet: "A4", scale: 2, angle: "first", section: true, parts: [{ name: "Block", volume: 45000, material: "al" }] });
  expect(svg).toContain('viewBox="0 0 297 210"');
  expect(svg).toContain(">1:2<");
  expect(svg).toContain("first-angle");
  expect(svg).toContain("SECTION A-A");
  expect(svg).toContain('fill="url(#hatch)"');
  expect(svg).toContain(">Block<");
  expect(svg).toContain(">45<");
  expect(svg.match(/NaN|Infinity/)).toBeNull();
});

it("a section of a solid hatches the cut and leaves the hole open", () => {
  const part = makeBaseBox(60, 40, 20).cut(makeBaseBox(10, 10, 30));
  const svg = buildDrawingSVG([part], { title: "Sec", section: true });
  const cut = svg.match(/<g class="cut"[^>]*>(.*?)<\/g>/)?.[1] ?? "";
  // The cut face has the hole as a second loop in one even-odd path.
  expect((cut.match(/M/g) ?? []).length).toBeGreaterThanOrEqual(2);
});
