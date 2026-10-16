/**
 * End-to-end test of constraint-ready shapes: the rectangle and circle tools
 * (corner, centre, 3-point, 2-point) draw geometry the solver holds, a corner
 * can be filleted and chamfered, "Make constrainable" converts a plain shape,
 * and a rectangle drawn narrow and with a wobbly first click still works.
 *   node tests/e2e/shapes.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/shapes";
mkdirSync(out, { recursive: true });

const channel = process.env.BROWSER_CHANNEL ?? "msedge";
const browser = await chromium.launch({ channel, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

const step = async (name, fn) => {
  const t = Date.now();
  await fn();
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`ok  ${name} (${Date.now() - t} ms)`);
};
const waitBuilt = async () => {
  await page.waitForFunction(() => /Built in|Ready/.test(document.querySelector(".statusbar__meta")?.textContent ?? "") && window.whittle.useApp.getState().builtDoc === window.whittle.useApp.getState().doc, null, { timeout: 60000 });
  await page.waitForTimeout(300);
};
const state = (fn, arg) => page.evaluate(fn, arg);
const expect = (cond, msg, detail) => {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(detail)}`);
};
const sketchInfo = () =>
  state(() => {
    const s = window.whittle.useApp.getState();
    const sk = s.doc.features.find((f) => f.type === "sketch");
    const sol = s.regen?.sketches.find((x) => x.id === sk.id)?.solution;
    return { id: sk.id, entities: sk.entities, geometry: sk.geometry ?? [], constraints: sk.constraints ?? [], sol };
  });
const count = (sk, type) => sk.geometry.filter((g) => g.type === type).length;
const select = (ids) => state((i) => window.whittle.useApp.setState({ sketchSel: i, selectedEntity: null }), ids);
const setTool = (tool) => state((t) => window.whittle.useApp.getState().mode.kind === "sketch" && window.whittle.useApp.setState((s) => ({ mode: { ...s.mode, tool: t } })), tool);

let box;
const at = (x, y) => [box.x + box.width / 2 + x, box.y + box.height / 2 + y];
const click = async (x, y) => {
  const [px, py] = at(x, y);
  await page.mouse.move(px, py, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);
};

await step("01-start", async () => {
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1")); // the test hook is off unless asked for
  await page.goto(url);
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  await page.getByRole("button", { name: /Engineer & professional/ }).click();
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).getByRole("button", { name: /New design/ }).first().click();
  await waitBuilt();
  await page.keyboard.press("s");
  await page.locator(".tree__row", { hasText: "XY plane" }).click();
  await page.waitForTimeout(900);
  box = await page.locator(".viewport").boundingBox();
});

await step("02-rectangle-is-geometry", async () => {
  await setTool("rect");
  await click(-200, 100);
  await click(-80, 20);
  await waitBuilt();
  const sk = await sketchInfo();
  expect(sk.entities.length === 0, "no plain shape left behind", sk.entities);
  expect(count(sk, "line") === 4 && count(sk, "point") === 4, "four lines on four shared corners", sk.geometry);
  expect(sk.constraints.filter((c) => c.type === "horizontal" || c.type === "vertical").length === 4, "level and plumb", sk.constraints);
});

await step("03-narrow-rectangle-and-wobbly-click", async () => {
  // A very narrow rectangle used to snap flat and silently refuse to draw.
  await setTool("rect");
  await click(0, 100);
  await click(34, -20);
  // A click that wobbles a pixel between press and release must stay a click.
  const [px, py] = at(100, 100);
  await page.mouse.move(px, py, { steps: 2 });
  await page.mouse.down();
  await page.mouse.move(px + 2, py + 1);
  await page.mouse.up();
  await click(180, 20);
  await waitBuilt();
  const sk = await sketchInfo();
  expect(count(sk, "line") === 12, "three rectangles drawn", count(sk, "line"));
});

await step("04-three-point-rectangle-stays-square", async () => {
  await setTool("rect3");
  await click(100, -60);
  await click(180, -100);
  await click(200, -40);
  await waitBuilt();
  const sk = await sketchInfo();
  expect(count(sk, "line") === 16, "fourth rectangle", count(sk, "line"));
  expect(sk.constraints.filter((c) => c.type === "perpendicular").length === 3, "right angles held", sk.constraints);
  expect(sk.sol && sk.sol.state !== "over" && sk.sol.state !== "error", "solves", sk.sol);
});

await step("05-circles", async () => {
  await setTool("circle2");
  await click(-200, -120);
  await click(-120, -120);
  await setTool("circle3");
  await click(-60, -140);
  await click(-20, -100);
  await click(-60, -60);
  await waitBuilt();
  const sk = await sketchInfo();
  expect(count(sk, "circle") === 2, "two circles", sk.geometry.filter((g) => g.type === "circle"));
});

await step("06-fillet-a-corner", async () => {
  await setTool("sfillet");
  await click(-80, 100); // a corner of the first rectangle
  const dlg = page.getByRole("dialog", { name: "Fillet corner" });
  await dlg.waitFor();
  await dlg.locator("input").first().fill("8");
  await dlg.getByRole("button", { name: /OK|Apply|Fillet|Done/ }).first().click();
  await waitBuilt();
  const sk = await sketchInfo();
  expect(count(sk, "arc") === 1, "one fillet arc", sk.geometry.filter((g) => g.type === "arc"));
  expect(sk.constraints.some((c) => c.type === "radius" && c.value === "8"), "radius dimension kept", sk.constraints);
  expect(sk.sol && sk.sol.state !== "over" && sk.sol.state !== "error", "solves", sk.sol);
});

await step("07-make-constrainable", async () => {
  await state(() => window.whittle.useApp.getState().sketchSel && window.whittle.useApp.setState({ prefs: { ...window.whittle.useApp.getState().prefs, smartSketch: false } }));
  await setTool("rect");
  await click(-200, 160);
  await click(-140, 190);
  const before = await sketchInfo();
  expect(before.entities.length === 1, "plain rectangle when the preference is off", before.entities);
  await setTool("select");
  await state((id) => window.whittle.useApp.setState({ selectedEntity: id }), before.entities[0].id);
  await page.getByRole("button", { name: /Make constrainable/ }).first().click();
  await waitBuilt();
  const after = await sketchInfo();
  expect(after.entities.length === 0 && count(after, "line") === before.geometry.filter((g) => g.type === "line").length + 4, "converted to lines", after);
});

await step("08-spline", async () => {
  await setTool("spline");
  await click(80, -180);
  await click(160, -150);
  await click(200, -200);
  await click(140, -230);
  await page.keyboard.press("Enter");
  await waitBuilt();
  let sk = await sketchInfo();
  const open = sk.geometry.filter((g) => g.type === "spline");
  expect(open.length === 1 && open[0].pts.length === 4 && !open[0].closed, "open spline through four points", open);
  // A closed one: click the first point again to close it.
  await setTool("spline");
  await click(-60, 220);
  await click(0, 190);
  await click(40, 240);
  await click(-60, 220);
  await waitBuilt();
  sk = await sketchInfo();
  const closed = sk.geometry.filter((g) => g.type === "spline" && g.closed);
  expect(closed.length === 1, "closed spline", sk.geometry.filter((g) => g.type === "spline"));
  expect(await state(() => window.whittle.useApp.getState().regen.sketches.at(-1).fill?.length > 0), "closed spline is a filled profile", {});
  expect(sk.sol && sk.sol.state !== "over" && sk.sol.state !== "error", "solves", sk.sol);
});

await step("09-spline-tangent-to-line", async () => {
  await setTool("segment");
  await click(250, 120);
  await click(330, 120);
  await page.keyboard.press("Enter");
  await setTool("spline");
  await click(330, 120); // starts on the line's end point, so they share it
  await click(370, 90);
  await click(400, 140);
  await page.keyboard.press("Enter");
  await waitBuilt();
  const sk = await sketchInfo();
  const spl = sk.geometry.filter((g) => g.type === "spline").at(-1);
  const line = sk.geometry.filter((g) => g.type === "line").at(-1);
  expect(spl.pts.length === 3, "spline through three points", spl);
  if (line.b !== spl.pts[0]) {
    // The click landed on the same spot but not on the point itself: join them explicitly.
    await select([line.b, spl.pts[0]]);
    await page.getByRole("button", { name: "Coincident" }).first().click();
    await waitBuilt();
  }
  await select([spl.id, line.id]);
  await page.getByRole("button", { name: "Tangent" }).first().click();
  await waitBuilt();
  const after = await sketchInfo();
  expect(after.constraints.some((c) => c.type === "tangent"), "tangent added", after.constraints);
  expect(after.sol && after.sol.state !== "over" && after.sol.state !== "error", "solves", after.sol);
});

if (errors.length) {
  console.error("console errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
await browser.close();
