/**
 * End-to-end test of curves you can constrain: an ellipse drawn to typed sizes is fully defined,
 * extrudes to the right solid, and the Dimension tool sets its major and then its minor radius.
 *   node tests/e2e/curves.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/curves";
mkdirSync(out, { recursive: true });

const channel = process.env.BROWSER_CHANNEL ?? "msedge";
const browser = await chromium.launch({ channel, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
  } catch (e) {
    await page.screenshot({ path: `${out}/${name}-FAILED.png` });
    throw e;
  }
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
    const sk = s.doc.features.filter((f) => f.type === "sketch").at(-1);
    const sol = s.regen?.sketches.find((x) => x.id === sk.id)?.solution;
    return { geometry: sk.geometry ?? [], constraints: sk.constraints ?? [], sol };
  });
const setTool = (tool) => state((t) => window.whittle.useApp.setState((s) => ({ mode: { ...s.mode, tool: t } })), tool);
const of = (sk, type) => sk.constraints.filter((c) => c.type === type);
const kind = (sk, id) => (id === "origin" ? "origin" : sk.geometry.find((g) => g.id === id)?.type);
const solves = (sk) => expect(sk.sol && !["over", "error"].includes(sk.sol.state), "the sketch solves", sk.sol);

let box;
const at = (x, y) => [box.x + box.width / 2 + x, box.y + box.height / 2 + y];
const click = async (x, y) => {
  const [px, py] = at(x, y);
  await page.mouse.move(px, py, { steps: 4 });
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);
};
/** Alt places a point exactly where clicked (no snapping), so the test knows where it is. */
const freeClick = async (x, y) => {
  await page.keyboard.down("Alt");
  await click(x, y);
  await page.keyboard.up("Alt");
};
const hover = async (x, y) => {
  const [px, py] = at(x, y);
  await page.mouse.move(px, py, { steps: 4 });
  await page.waitForTimeout(80);
};
const badge = () => page.locator(".snap-badge").first().textContent({ timeout: 2000 }).catch(() => "");
const api = (name, input) => page.evaluate(([n, i]) => window.whittle.api.run(n, i), [name, input]);

await step("01-start", async () => {
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1"));
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

await step("02-ellipse-with-typed-sizes", async () => {
  await setTool("ellipse");
  // Centered on the origin, 30 by 12: fully defined by what was typed.
  await click(0, 0);
  await hover(120, -50);
  await page.keyboard.type("30");
  await page.keyboard.press("Tab");
  await page.keyboard.type("12");
  await page.keyboard.press("Enter");
  await waitBuilt();
  const sk = await sketchInfo();
  const e = sk.geometry.find((g) => g.type === "ellipse");
  expect(e, "an ellipse you can constrain", sk.geometry);
  expect(of(sk, "distance").some((c) => c.refs.includes(e.c) && c.refs.includes(e.a) && c.value === "30"), "major radius 30", sk.constraints);
  expect(of(sk, "radius").some((c) => c.refs[0] === e.id && c.value === "12"), "minor radius 12", sk.constraints);
  expect(of(sk, "coincident").some((c) => c.refs.includes("origin")), "centered on the origin", sk.constraints);
  expect(sk.sol.state === "full", "fully defined", sk.sol);
});

await step("03-extrude-the-ellipse", async () => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await waitBuilt();
  const sketch = await state(() => window.whittle.useApp.getState().doc.features.find((f) => f.type === "sketch").id);
  const r = await api("add_feature", { type: "extrude", settings: { sketch, distance: 10 } });
  await waitBuilt();
  const vol = await state(() => window.whittle.useApp.getState().regen.bodies.reduce((a, b) => a + b.volume, 0));
  expect(Math.abs(vol - Math.PI * 30 * 12 * 10) < 1, "an elliptical solid of the right size", { r, vol });
});

await step("04-dimension-tool-on-an-ellipse", async () => {
  // A second, freely drawn ellipse: the Dimension tool sets the major radius, then the minor one.
  await page.locator(".tree__row", { hasText: /Sketch 1/ }).first().dblclick();
  await page.waitForTimeout(900);
  await setTool("ellipse");
  await freeClick(200, 120);
  await freeClick(260, 90);
  await waitBuilt();
  await setTool("dimension");
  // On the curve, away from its points.
  await click(200 + 60 * Math.cos(0.5), 120 - 30 * Math.sin(0.5));
  let dlg = page.getByRole("dialog", { name: "Major radius" });
  await dlg.waitFor();
  await dlg.locator("input").fill("20");
  await dlg.locator("input").press("Enter");
  await waitBuilt();
  await page.waitForTimeout(400);
  const before = await sketchInfo();
  const e = before.geometry.filter((g) => g.type === "ellipse").at(-1);
  // The curve has grown to its new size; pick it again (as a click on it does).
  await page.evaluate((id) => void window.whittle.dimensionPick(id, false), e.id);
  dlg = page.getByRole("dialog", { name: "Minor radius" });
  await dlg.waitFor();
  await dlg.locator("input").fill("8");
  await dlg.locator("input").press("Enter");
  await waitBuilt();
  const sk = await sketchInfo();
  const r = sk.sol.radii[e.id];
  expect(Math.abs(r - 8) < 1e-6, "minor radius set", sk.sol.radii);
  const g = sk.geometry.find((x) => x.id === e.id);
  const [c, a] = [sk.sol.points[g.c], sk.sol.points[g.a]];
  expect(Math.abs(Math.hypot(a[0] - c[0], a[1] - c[1]) - 20) < 1e-6, "major radius set", { c, a });
  solves(sk);
});

await step("05-assistant-draws-an-ellipse", async () => {
  // What the assistant does: an ellipse on the origin, sized by dimensions.
  const sketch = await state(() => window.whittle.useApp.getState().doc.features.find((f) => f.type === "sketch").id);
  await api("constrain_sketch", {
    sketch,
    geometry: [{ name: "oval", type: "ellipse", center: "origin", major: [0, 60], minor: 5 }],
    constraints: [
      { type: "vertical", refs: ["oval.center", "oval.major"] },
      { type: "distance", refs: ["oval.center", "oval.major"], value: 50 },
      { type: "radius", refs: ["oval"], value: 6 },
    ],
  });
  await waitBuilt();
  const sk = await sketchInfo();
  const e = sk.geometry.filter((g) => g.type === "ellipse").at(-1);
  const [c, a] = [sk.sol.points[e.c] ?? [0, 0], sk.sol.points[e.a]];
  expect(Math.abs(a[1] - c[1] - 50) < 1e-6 && Math.abs(a[0] - c[0]) < 1e-6, "upright, 50 long", { c, a, sol: sk.sol });
  expect(Math.abs(sk.sol.radii[e.id] - 6) < 1e-6, "minor radius 6", sk.sol.radii);
  solves(sk);
});

await step("06-text-exports-as-outlines", async () => {
  // Lettering for a laser cutter: the text in a sketch comes out as closed outlines (an "o" is two loops).
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await waitBuilt();
  await api("add_sketch", { name: "Label", plane: "XY", shapes: [{ type: "text", x: 0, y: 0, text: "Hello", size: 10 }] });
  await waitBuilt();
  await page.locator(".tree__row", { hasText: "Label" }).first().dblclick();
  await page.waitForTimeout(900);
  const dl = page.waitForEvent("download");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("export sketch as dxf");
  await page.keyboard.press("Enter");
  const d = await dl.catch(async (e) => {
    throw new Error(`no download; notices: ${JSON.stringify(await state(() => window.whittle.useApp.getState().toasts.map((t) => t.text)))}`);
  });
  const path = `${out}/${d.suggestedFilename()}`;
  await d.saveAs(path);
  const text = (await import("node:fs")).readFileSync(path, "utf8");
  const outlines = text.split("\n").filter((l) => l === "POLYLINE").length;
  // H, e (2), l, l, o (2): seven loops.
  expect(outlines === 7, "every letter is outlined", outlines);
});

console.log(errors.length ? `console errors:\n${errors.join("\n")}` : "no console errors");
await browser.close();
if (errors.length) process.exit(1);
