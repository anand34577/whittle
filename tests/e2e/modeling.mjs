/**
 * End-to-end test of arcs, sketch offset, thin and through-all extrudes,
 * revolve about a line, offset mirror planes and grid patterns.
 *   node tests/e2e/modeling.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/modeling";
mkdirSync(out, { recursive: true });

const channel = process.env.BROWSER_CHANNEL ?? "msedge";
const browser = await chromium.launch({ channel, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => {
  errors.push(`native ${d.type()} dialog: ${d.message()}`);
  void d.dismiss();
});

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
const api = (name, input) => page.evaluate(([n, i]) => window.whittle.api.run(n, i), [name, input]);
const state = (fn) => page.evaluate(fn);
const expect = (cond, msg, detail) => {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(detail)}`);
};

await step("01-start", async () => {
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1")); // the test hook is off unless asked for
  await page.goto(url);
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  await page.getByRole("button", { name: /Engineer & professional/ }).click();
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).getByRole("button", { name: /New design/ }).first().click();
  await waitBuilt();
  // This script exercises whole-shape outlines; constraint-ready shapes have their own script.
  await page.evaluate(() => window.whittle.useApp.setState((s) => ({ prefs: { ...s.prefs, smartSketch: false } })));
});

await step("02-outline-with-arc", async () => {
  await page.keyboard.press("s");
  await page.locator(".tree__row", { hasText: "XY plane" }).click();
  await page.waitForTimeout(900);
  await page.keyboard.press("l");
  const box = await page.locator(".viewport").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const click = async (x, y) => {
    await page.mouse.move(cx + x, cy + y, { steps: 3 });
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(80);
  };
  await click(-120, 80);
  await click(120, 80);
  await page.keyboard.press("a"); // arcs on: end point, then a point on the arc
  await click(120, -80);
  await click(190, 0);
  await page.screenshot({ path: `${out}/02a-arc-preview.png` });
  await page.keyboard.press("a"); // back to straight lines
  await click(-120, -80);
  await click(-120, 80); // close on the first point
  await waitBuilt();
  const pts = await state(() => {
    const s = window.whittle.useApp.getState();
    const sk = s.doc.features.find((f) => f.type === "sketch");
    return sk.entities[0]?.points;
  });
  expect(pts?.length === 5 && pts[2][2] === "arc", "outline has an arc point", pts);
  expect((await page.evaluate(() => window.whittle.useApp.getState().mode.tool)) === "polyline", "A didn't switch tools mid-outline", {});
});

await step("03-offset-shape", async () => {
  await page.keyboard.press("v");
  const sel = await state(() => {
    const s = window.whittle.useApp.getState();
    const sk = s.doc.features.find((f) => f.type === "sketch");
    window.whittle.useApp.setState({ selectedEntity: sk.entities[0].id });
    return sk.entities.length;
  });
  expect(sel === 1, "one shape", sel);
  await page.keyboard.press("Shift+O");
  const dlg = page.getByRole("dialog", { name: "Offset shape" });
  await dlg.waitFor();
  await page.screenshot({ path: `${out}/03a-offset-dialog.png` });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  // Arcs can't be offset yet: a friendly note, no new shape.
  const n = await state(() => window.whittle.useApp.getState().doc.features.find((f) => f.type === "sketch").entities.length);
  expect(n === 1, "outline with arcs is not offset", n);
  await page.locator(".toast").first().waitFor();
});

await step("04-thin-extrude-panel", async () => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await waitBuilt();
  await page.keyboard.press("e");
  await waitBuilt();
  await page.getByRole("radio", { name: "Through all" }).waitFor();
  await page.getByText("Thin wall").click();
  const wall = page.getByLabel("Wall", { exact: true });
  await wall.fill("2");
  await wall.press("Tab");
  await waitBuilt();
  await page.getByRole("radio", { name: "Inside" }).waitFor();
  await page.screenshot({ path: `${out}/04a-thin.png` });
  await page.keyboard.press("Enter");
  await waitBuilt();
  const st = await state(() => {
    const s = window.whittle.useApp.getState();
    const ex = s.doc.features.find((f) => f.type === "extrude");
    return { thin: ex.thin, status: s.regen.status.find((x) => x.id === ex.id) };
  });
  expect(st.thin === "2" && st.status.state === "ok", "thin extrude built", st);
});

await step("05-api-advanced", async () => {
  const plate = await api("add_feature", { type: "primitive", name: "Plate", settings: { shape: "box", width: 60, depth: 40, height: 8, position: [0, 120, 0] } });
  const holes = await api("add_sketch", { plane: "XY", shapes: [{ type: "circle", x: 0, y: 120, diameter: 6 }] });
  const cut = await api("add_feature", { type: "extrude", settings: { sketch: holes.id, extent: "through", op: "cut", target: plate.body } });
  expect(cut.status?.state === "ok", "through-all cut", cut);
  const grid = await api("add_feature", { type: "pattern", settings: { body: plate.body, axis: "x", count: 2, spacing: 70, axis2: "y", count2: 2, spacing2: 50, merge: false } });
  expect(grid.status?.state === "ok", "grid pattern", grid);
  const mir = await api("add_feature", { type: "mirror", settings: { body: plate.body, plane: "YZ", offset: -50, merge: false } });
  expect(mir.status?.state === "ok", "offset mirror", mir);
  const ring = await api("add_sketch", { plane: "XZ", shapes: [{ type: "circle", x: -150, y: 10, diameter: 4 }, { type: "path", points: [[-140, 0], [-140, 20]] }] });
  const rv = await api("add_feature", { type: "revolve", settings: { sketch: ring.id, axis: "line" } });
  expect(rv.status?.state === "ok", "revolve about a line", rv);
  const rib = await api("add_sketch", { plane: "XY", shapes: [{ type: "path", points: [[-200, 0], [-170, 0, "arc"], [-170, 30]] }] });
  const ribX = await api("add_feature", { type: "extrude", settings: { sketch: rib.id, distance: 10, thin: 2 } });
  expect(ribX.status?.state === "ok", "arc rib", ribX);
  await page.keyboard.press("Shift+H");
  await waitBuilt();
});

if (errors.length) {
  console.error("console errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
await browser.close();
