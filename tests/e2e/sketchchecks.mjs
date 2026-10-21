/**
 * End-to-end test of sketch checks and layout: every enclosed area shaded (an island too), the right-click
 * menu (no overlaps, full labels, the center cancels the tool), gap dimensions (circle center to line,
 * two loose parallel lines kept parallel), and values that don't fit refused with the reason (a fillet
 * radius too big for its corner, a rectangle's rounded corners).
 *   node tests/e2e/sketchchecks.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/sketchchecks";
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
    const sol = s.regen?.sketches.find((x) => x.id === sk.id)?.solution;
    return { id: sk.id, entities: sk.entities, geometry: sk.geometry ?? [], constraints: sk.constraints ?? [], sol };
  });
const count = (sk, type) => sk.geometry.filter((g) => g.type === type).length;
const setTool = (tool) => state((t) => window.whittle.useApp.setState((s) => ({ mode: { ...s.mode, tool: t } })), tool);
const select = (ids) => state((i) => window.whittle.useApp.setState({ sketchSel: i, selectedEntity: null }), ids);
const geomIds = (sk) => sk.geometry.filter((g) => g.type !== "point").map((g) => g.id);

let box;
const at = (x, y) => [box.x + box.width / 2 + x, box.y + box.height / 2 + y];
const click = async (x, y) => {
  const [px, py] = at(x, y);
  await page.mouse.move(px, py, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);
};
const fillDialog = async (title, value) => {
  const dlg = page.getByRole("dialog", { name: title });
  await dlg.waitFor();
  await dlg.locator("input").first().fill(value);
  await dlg.locator("input").first().press("Enter");
};

await step("01-start", async () => {
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1")); // the test hook is off unless asked for
  await page.goto(url);
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  await page.getByRole("button", { name: /Engineer & professional/ }).click();
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).getByRole("button", { name: /New design/ }).first().click();
  await waitBuilt();
  const b = await api("add_feature", { type: "primitive", name: "Block", settings: { shape: "box", width: 40, depth: 40, height: 10, position: [0, 0, 0] } });
  await page.keyboard.press("s");
  await page.locator(".tree__row", { hasText: "XY plane" }).click();
  await page.waitForTimeout(900);
  box = await page.locator(".viewport").boundingBox();
});
await step("02-draw", async () => {
  await setTool("rect"); await click(-350, -180); await click(50, 180); await waitBuilt();
  await setTool("rect"); await click(-300, -120); await click(-200, 0); await waitBuilt();
  await setTool("circle"); await click(-150, 60); await click(-100, 60); await waitBuilt();
  await setTool("select"); await page.mouse.move(...at(300, 250)); await page.waitForTimeout(300);
});
await step("03-radial", async () => {
  await setTool("polyline");
  await page.mouse.click(...at(250, 0), { button: "right" });
  await page.waitForTimeout(400);
  const boxes = await page.locator(".radial__item").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom, e.scrollWidth > e.clientWidth, e.textContent]; }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const [a, b] = [boxes[i], boxes[j]];
    expect(!(a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]), "items overlap", [a, b]);
  }
  const clipped = await page.locator(".radial__item span").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.textContent));
  expect(!clipped.length, "labels clipped", clipped);
  await page.screenshot({ path: `${out}/03-radial-open.png` });
  await page.locator(".radial__hub").click();
  const tool = await state(() => window.whittle.useApp.getState().mode.tool);
  expect(tool === "select", "hub cancels tool", tool);
});
await step("04-fill-and-loose-lines", async () => {
  const fills = await state(() => { const s = window.whittle.useApp.getState(); const sk = s.regen.sketches.at(-1); return [sk.fill?.length, (sk.regions ?? []).reduce((n, r) => n + r.fill.length, 0), sk.regions?.length]; });
  expect(fills[2] >= 3 && fills[0] === fills[1], "every area shaded", fills);
  await setTool("polyline"); await click(-300, 230); await click(0, 200); await page.keyboard.press("Escape");
  await setTool("polyline"); await click(-300, 270); await click(0, 240); await page.keyboard.press("Escape");
  await waitBuilt();
  const two = (await sketchInfo()).geometry.filter((g) => g.type === "line").slice(-2).map((g) => g.id);
  await select([two[0]]);
  void state((id) => window.whittle.dimensionPick(id, false), two[1]);
  await fillDialog("Distance", "10");
  await waitBuilt();
  const sk = await sketchInfo();
  const types = sk.constraints.slice(-2).map((c) => c.type);
  expect(types[0] === "distance", "loose lines kept parallel at the gap", sk.constraints.slice(-3));
});
await step("05-dim-circle-to-line", async () => {
  await setTool("dimension");
  await click(-100, 60);       // the circle
  await click(50, 60);        // the rectangle's right side
  await page.mouse.move(...at(-50, 130), { steps: 4 });
  await click(-50, 130);
  await page.locator(".inline-prompt input").fill("60");
  await page.locator(".inline-prompt input").press("Enter");
  await waitBuilt();
  const sk = await sketchInfo();
  const d = sk.constraints.at(-1);
  const circle = sk.geometry.find((g) => g.type === "circle");
  expect(d.type === "distance" && d.refs[0] === circle.c, "center to line", d);
});
await step("06-fillet-too-big-is-refused", async () => {
  await setTool("sfillet");
  await click(-353, -176);
  await page.locator(".inline-prompt input").fill("5");
  await page.locator(".inline-prompt input").press("Enter");
  await waitBuilt();
  await setTool("select");
  const field = page.locator(".field", { hasText: "Radius" }).locator("input");
  await field.fill("99999");
  await field.press("Tab");
  await page.locator(".toast", { hasText: "doesn't fit" }).waitFor({ timeout: 8000 });
  await waitBuilt();
  const sk = await sketchInfo();
  const r = sk.constraints.find((c) => c.type === "radius");
  expect(r.value === "5" && sk.sol.state !== "error", "kept at 5", [r, sk.sol.state]);
});
await step("07-corner-radius-checked", async () => {
  await page.getByRole("button", { name: "Finish sketch" }).first().click();
  await waitBuilt();
  const bad = await api("add_sketch", { plane: "XY", shapes: [{ type: "rect", x: 0, y: 0, width: 30, height: 30, corner_radius: 99999 }] });
  expect(/too big/.test(JSON.stringify(bad)), "api refuses", bad);
  const ok = await api("add_sketch", { plane: "XY", name: "Plate", shapes: [{ type: "rect", x: 0, y: 0, width: 30, height: 30, corner_radius: 2 }] });
  expect(!ok.error, "api adds", ok);
  await waitBuilt();
  await page.locator(".tree__row", { hasText: "Plate" }).dblclick();
  await page.waitForTimeout(800);
  await state(() => { const s = window.whittle.useApp.getState(); const sk = s.doc.features.find((f) => f.name === "Plate"); window.whittle.useApp.setState({ selectedEntity: sk.entities[0].id }); });
  const field = page.locator(".field", { hasText: "Rounded corners" }).locator("input");
  await field.fill("99999");
  await page.waitForTimeout(200);
  const msg = await page.locator(".field__error").first().textContent();
  expect(/too big/.test(msg), "field says why", msg);
  await page.screenshot({ path: `${out}/07-field-error.png` });
  const boxes = await page.locator(".field-row .field__box").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  expect(boxes.every((w) => w > 60), "paired fields have room", boxes);
  await field.press("Tab");
  await waitBuilt();
  const corner = await state(() => window.whittle.useApp.getState().doc.features.find((f) => f.name === "Plate").entities[0].corner);
  expect(corner === "2", "kept at 2", corner);
});
if (errors.length) {
  console.error("console errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
await browser.close();
