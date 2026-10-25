/**
 * End-to-end test of the sketch palette (grid snap, slice), the overall slot, the
 * concentric constraint, the circular pattern and the extrude start offset.
 *   node tests/e2e/palette.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/palette";
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
const api = (name, input) => page.evaluate(([n, i]) => window.whittle.api.run(n, i), [name, input]);
const state = (fn, arg) => page.evaluate(fn, arg);
const expect = (cond, msg, detail) => {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(detail)}`);
};
const sketchInfo = () =>
  state(() => {
    const s = window.whittle.useApp.getState();
    const sk = s.doc.features.filter((f) => f.type === "sketch").at(-1);
    return { id: sk.id, entities: sk.entities, geometry: sk.geometry ?? [], constraints: sk.constraints ?? [] };
  });
const setTool = (tool) => state((t) => window.whittle.useApp.setState((s) => ({ mode: { ...s.mode, tool: t } })), tool);
const run = (id) => state((i) => window.whittle.commands.find((c) => c.id === i).run(), id);
const fillDialog = async (title, value) => {
  const dlg = page.getByRole("dialog", { name: title });
  await dlg.waitFor();
  await dlg.locator("input").first().fill(value);
  await dlg.locator("input").first().press("Enter");
};
let box;
const click = async (x, y) => {
  const px = box.x + box.width / 2 + x;
  const py = box.y + box.height / 2 + y;
  await page.mouse.move(px, py, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);
};

await step("01-start", async () => {
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1"));
  await page.goto(url);
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  await page.getByRole("button", { name: /Engineer & professional/ }).click();
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).getByRole("button", { name: /New design/ }).first().click();
  await waitBuilt();
  const b = await api("add_feature", { type: "primitive", name: "Block", settings: { shape: "box", width: 40, depth: 40, height: 10, position: [0, 0, 0] } });
  expect(b.ok !== false, "box added", b);
  await waitBuilt();
  await page.keyboard.press("s");
  await page.locator(".tree__row", { hasText: "XY plane" }).click();
  await page.waitForTimeout(900);
  box = await page.locator(".viewport").boundingBox();
});

await step("02-palette", async () => {
  const palette = page.getByRole("toolbar", { name: "Sketch palette" });
  await palette.waitFor();
  for (const name of ["Look at", "Grid", "Snap", "Slice", "Dimensions", "Constraints"]) {
    expect((await palette.getByRole("button", { name: new RegExp(name) }).count()) === 1, `palette has ${name}`, name);
  }
  await palette.getByRole("button", { name: /Snap/ }).click();
  expect((await state(() => window.whittle.useApp.getState().sketchView.snap)) === false, "snap off", {});
  await palette.getByRole("button", { name: /Snap/ }).click();
  await palette.getByRole("button", { name: /Slice/ }).click();
  const section = await state(() => window.whittle.useApp.getState().view.section);
  expect(section && section.axis === "z", "slice cuts at the sketch plane", section);
  await palette.getByRole("button", { name: /Slice/ }).click();
  expect((await state(() => window.whittle.useApp.getState().view.section)) === null, "slice restores the view", {});
});

await step("03-overall-slot", async () => {
  await setTool("slotO");
  await click(-120, 0);
  await click(120, 0);
  await click(120, 40);
  await waitBuilt();
  const sk = await sketchInfo();
  // Constraint-ready sketching turns the slot into two lines and two tangent arcs.
  const arcs = sk.geometry.filter((g) => g.type === "arc").length;
  const lines = sk.geometry.filter((g) => g.type === "line").length;
  expect(arcs === 2 && lines === 2, "a slot: two arcs and two lines", { arcs, lines });
});

await step("03b-center-and-arc-slots", async () => {
  const count = async (t) => (await sketchInfo()).geometry.filter((g) => g.type === t).length;
  let arcs = await count("arc");
  await setTool("slotC");
  await click(-200, -150);
  await click(-140, -150);
  await click(-140, -120);
  await waitBuilt();
  expect((await count("arc")) === arcs + 2, "center-point slot adds two arcs", await count("arc"));
  arcs = await count("arc");
  await setTool("slotA");
  await click(200, -150);
  await click(300, -150);
  await click(200, -50);
  await click(284, -66);
  await waitBuilt();
  expect((await count("arc")) === arcs + 4, "arc slot adds four arcs", await count("arc"));
  arcs = await count("arc");
  await setTool("slotP");
  await click(100, 140);
  await click(260, 140);
  await click(180, 100);
  await click(180, 80);
  await waitBuilt();
  expect((await count("arc")) === arcs + 4, "3-point arc slot adds four arcs", await count("arc"));
});

await step("03c-midpoint-line-and-toggles", async () => {
  await setTool("lineM");
  await click(-200, 60);
  await click(-120, 100);
  await waitBuilt();
  const sk = await sketchInfo();
  expect(sk.constraints.some((c) => c.type === "midpoint"), "midpoint line holds its middle", sk.constraints);
  const palette = page.getByRole("toolbar", { name: "Sketch palette" });
  await palette.getByRole("button", { name: /Points/ }).click();
  await palette.getByRole("button", { name: /Profile/ }).click();
  const v = await state(() => window.whittle.useApp.getState().sketchView);
  expect(v.points === false && v.shading === false, "points and profile shading switch off", v);
  await palette.getByRole("button", { name: /Points/ }).click();
  await palette.getByRole("button", { name: /Profile/ }).click();
});

await step("04-concentric-and-pattern", async () => {
  await setTool("pcircle");
  await click(-200, 150);
  await click(-160, 150);
  await setTool("pcircle");
  await click(-100, 150);
  await click(-80, 150);
  await waitBuilt();
  let sk = await sketchInfo();
  const circles = sk.geometry.filter((g) => g.type === "circle");
  expect(circles.length === 2, "two circles", circles.length);
  await setTool("select");
  await state((ids) => window.whittle.useApp.setState({ sketchSel: ids, selectedEntity: null }), circles.map((c) => c.id));
  await run("constrain-concentric");
  await waitBuilt();
  sk = await sketchInfo();
  expect(sk.constraints.some((c) => c.type === "concentric"), "concentric added", sk.constraints);
  const solved = await state(() => {
    const s = window.whittle.useApp.getState();
    const sk = s.doc.features.filter((f) => f.type === "sketch").at(-1);
    const pts = s.regen.sketches.find((x) => x.id === sk.id).solution.points;
    return sk.geometry.filter((g) => g.type === "circle").map((c) => pts[c.c]);
  });
  expect(Math.hypot(solved[0][0] - solved[1][0], solved[0][1] - solved[1][1]) < 1e-6, "same center", solved);

  await state((ids) => window.whittle.useApp.setState({ sketchSel: ids, selectedEntity: null }), [circles[0].id]);
  const before = sk.geometry.filter((g) => g.type === "circle").length;
  await run("geo-circular");
  await fillDialog("Circular pattern", "4, 360, 0, 0");
  await waitBuilt();
  sk = await sketchInfo();
  expect(sk.geometry.filter((g) => g.type === "circle").length === before + 3, "three more copies", sk.geometry.length);
});

await step("05-extrude-start-offset", async () => {
  await run("finish-sketch");
  await waitBuilt();
  await run("extrude");
  await page.waitForTimeout(500);
  const ex = await state(() => window.whittle.useApp.getState().doc.features.filter((f) => f.type === "extrude").at(-1));
  expect(ex, "an extrude feature exists", {});
  await page.getByRole("button", { name: "Start", exact: true }).click(); // the start options sit in their own section
  await page.getByLabel("Start offset").first().fill("12");
  await page.keyboard.press("Enter");
  await waitBuilt();
  const after = await state(() => window.whittle.useApp.getState().doc.features.filter((f) => f.type === "extrude").at(-1)?.startOffset);
  expect(after === "12", "start offset stored", after);
});

if (errors.length) {
  console.error("console errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
await browser.close();
