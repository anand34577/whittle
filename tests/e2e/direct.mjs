/**
 * Direct manipulation: drag handles, the on-canvas value box, reference dimensions,
 * first-dimension scaling, rubber-band selection, the quick box and timeline cross-highlight.
 *   node tests/e2e/direct.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/direct";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? "msedge", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
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
    return { id: sk.id, geometry: sk.geometry ?? [], constraints: sk.constraints ?? [], sol };
  });
const feature = (type) => state((t) => window.whittle.useApp.getState().doc.features.filter((f) => f.type === t).at(-1), type);
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
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1"));
  await page.goto(url);
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  await page.getByRole("button", { name: /Engineer & professional/ }).click();
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).getByRole("button", { name: /New design/ }).first().click();
  await waitBuilt();
  await page.keyboard.press("s");
  await page.locator(".tree__row", { hasText: "XY plane" }).click();
  await page.waitForTimeout(900);
  await page.locator('[data-tour="tool-segment"]').click();
  box = await page.locator(".viewport").boundingBox();
  await click(-120, 80);
  await click(120, 80);
  await click(120, -80);
  await click(-120, -80);
  await click(-120, 80);
  await waitBuilt();
});

await step("02-dimension-asks-on-canvas-and-scales", async () => {
  const sk = await sketchInfo();
  const bottom = sk.geometry.filter((g) => g.type === "line")[0];
  await state(([id]) => void window.whittle.dimensionPick(id, false, [420, 300]), [bottom.id]);
  const dlg = page.getByRole("dialog", { name: "Distance" });
  await dlg.waitFor();
  expect(await dlg.evaluate((el) => !!el.closest(".viewport")), "value box opens on the canvas, not as a modal", {});
  await dlg.locator("input").fill("2400");
  await dlg.locator("input").press("Enter");
  await waitBuilt();
  const after = await sketchInfo();
  const len = await state((s) => {
    const sol = s.sol;
    const l = s.geometry.filter((g) => g.type === "line")[0];
    const a = sol.points[l.a];
    const b = sol.points[l.b];
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }, after);
  expect(Math.abs(len - 2400) < 1, "line is 2400 mm", len);
  const width = await state((s) => {
    const xs = Object.values(s.sol.points).map((p) => p[0]);
    return Math.max(...xs) - Math.min(...xs);
  }, after);
  expect(Math.abs(width - 2400) < 1, "the rest of the sketch scaled with it", width);
});

await step("03-over-constraint-becomes-reference", async () => {
  const sk = await sketchInfo();
  const bottom = sk.geometry.filter((g) => g.type === "line")[0];
  await state((id) => window.whittle.useApp.setState({ sketchSel: [id], selectedEntity: null }), bottom.id);
  await state(([id]) => void window.whittle.dimensionPick(id, false, [420, 300]), [bottom.id]);
  const dlg = page.getByRole("dialog", { name: "Distance" });
  await dlg.waitFor();
  await dlg.locator("input").fill("777");
  await dlg.locator("input").press("Enter");
  await page.waitForFunction(() => window.whittle.useApp.getState().doc.features.filter((f) => f.type === "sketch").at(-1).constraints.some((c) => c.driven), null, { timeout: 15000 });
  await waitBuilt();
  const after = await sketchInfo();
  expect(after.sol.state !== "over", "no conflict", after.sol);
});

await step("04-extrude-and-handle-drag", async () => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await waitBuilt();
  await page.keyboard.press("e");
  await waitBuilt();
  const handle = page.locator(".drag-handle").first();
  await handle.waitFor();
  const before = Number((await feature("extrude")).distance);
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - 60, { steps: 6 });
  await page.screenshot({ path: `${out}/04a-handle-drag.png` });
  await page.mouse.up();
  await waitBuilt();
  const dragged = Number((await feature("extrude")).distance);
  expect(dragged !== before && Number.isFinite(dragged), "dragging the handle changed the distance", { before, dragged });
  await page.keyboard.press("Escape");
});

await step("05-quick-box-and-timeline-hover", async () => {
  await waitBuilt();
  await page.keyboard.press(" ");
  await page.getByRole("dialog", { name: "Quick tools" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Quick tools" }).waitFor({ state: "detached" });
  await page.locator(".step").first().hover();
  await page.waitForTimeout(150);
  const hover = await state(() => window.whittle.useApp.getState().hover);
  expect(hover !== null, "hovering a timeline step highlights its geometry", hover);
  await page.mouse.move(700, 400);
});

if (errors.length) {
  console.error("console errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
await browser.close();
