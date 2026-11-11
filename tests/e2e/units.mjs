/**
 * End-to-end checks for the October 2026 audit fixes (docs/AUDIT.md) that need the real app:
 * shapes drawn in an inch design are stored at the size drawn (U-1) on an inch grid (U-2), a control-point
 * spline stays a spline (C-1), the first Esc in a field undoes the typing (W-7), box selection inside a fillet
 * picks edges of the body before it (W-13), a drag handle's box takes "2.5" (W-15), and the crash-recovery
 * draft keeps work done inside an open sketch (W-1, W-3).
 *   node tests/e2e/units.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/units";
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
const built = () =>
  page.waitForFunction(() => {
    const s = window.whittle.useApp.getState();
    return s.kernelReady && s.builtDoc === s.doc && !s.regenBusy;
  }, null, { timeout: 90000 });
const state = (fn, arg) => page.evaluate(fn, arg);
const expect = (cond, msg, detail) => {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(detail)}`);
};
const setTool = (tool) => state((t) => window.whittle.useApp.setState((s) => ({ mode: { ...s.mode, tool: t } })), tool);
let box;
const at = (x, y) => [box.x + box.width / 2 + x, box.y + box.height / 2 + y];
const click = async (x, y) => {
  await page.mouse.move(...at(x, y), { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(120);
};
const lastSketch = () =>
  state(() => {
    const s = window.whittle.useApp.getState();
    const sk = s.doc.features.filter((f) => f.type === "sketch").at(-1);
    const pt = (id) => sk.geometry.find((g) => g.id === id);
    const lines = (sk.geometry ?? []).filter((g) => g.type === "line").map((l) => Math.hypot(pt(l.b).x - pt(l.a).x, pt(l.b).y - pt(l.a).y));
    return { entities: sk.entities, geometry: (sk.geometry ?? []).map((g) => g.type), lines };
  });

await step("01-inch-design", async () => {
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1"));
  await page.goto(url);
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  await page.getByRole("button", { name: /Engineer & professional/ }).click();
  const welcome = page.getByRole("dialog", { name: "Welcome to Whittle" });
  // One New design button, with the unit beside it.
  await welcome.getByRole("group", { name: "Units for the new design" }).getByRole("button", { name: "in", exact: true }).click();
  await welcome.getByRole("button", { name: /New design/ }).first().click();
  await built();
  expect((await state(() => window.whittle.useApp.getState().doc.units)) === "in", "an inch design", null);
});

await step("02-rectangle-at-drawn-size", async () => {
  await page.keyboard.press("s");
  await page.locator(".tree__row", { hasText: "XY plane" }).click();
  await page.waitForTimeout(1200);
  box = await page.locator("canvas").first().boundingBox();
  // U-2: the grid steps in inches (a power of two of an inch below one inch).
  const grid = await state(() => window.whittle.viewportRef.current.gridSpacing / 25.4);
  expect(Math.abs(Math.log2(grid) - Math.round(Math.log2(grid))) < 1e-9 || Number.isInteger(grid), "grid in inches", grid);
  const px = await state(() => window.whittle.viewportRef.current.pixelSize);
  await setTool("rect");
  await click(-50, -30);
  await click(50, 30);
  await page.waitForTimeout(600);
  const sk = await lastSketch();
  const long = Math.max(...sk.lines);
  // U-1: about 100 px wide on screen, give or take the grid snap. It was stored 25.4 times too big.
  const snap = await state(() => window.whittle.viewportRef.current.gridSpacing);
  expect(sk.lines.length === 4 && Math.abs(long - 100 * px) <= snap, "rectangle stored at the size drawn (mm)", { lines: sk.lines, expected: 100 * px, snap });
  // Snapped to the inch grid: whole multiples of half a grid step.
  expect(sk.lines.every((l) => Math.abs(l / (snap / 2) - Math.round(l / (snap / 2))) < 1e-6), "on the inch grid", { lines: sk.lines, snap });
});

await step("03-draft-keeps-open-sketch", async () => {
  // W-1/W-3: the draft is in IndexedDB and holds the rectangle although the sketch is still open.
  await page.waitForTimeout(1500);
  const draft = await state(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open("whittle-data", 1);
        req.onsuccess = () => {
          const get = req.result.transaction("drafts").objectStore("drafts").getAll();
          get.onsuccess = () => resolve(get.result.map((r) => ({ unfinished: r.value.unfinished, sketches: r.value.doc.features.filter((f) => f.type === "sketch").map((f) => (f.geometry ?? []).length), at: r.updatedAt })));
          get.onerror = () => resolve("read failed");
        };
        req.onerror = () => resolve("open failed");
      }),
  );
  expect(Array.isArray(draft) && draft.some((d) => d.unfinished && d.sketches.some((n) => n > 0) && d.at > 0), "draft with the unfinished sketch", draft);
});

await step("04-control-spline-stays-a-spline", async () => {
  await setTool("cspline");
  for (const [x, y] of [[-150, 100], [-50, -20], [50, 220], [150, 100]]) await click(x, y);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  const sk = await lastSketch();
  const spline = sk.entities.find((e) => e.ctrl);
  expect(spline && spline.points.length === 4, "control-point spline kept", sk.entities);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Finish sketch/ }).first().click().catch(() => {});
  await page.waitForTimeout(500);
});

await step("05-esc-undoes-typing", async () => {
  await state(() => window.whittle.api.run("add_feature", { type: "primitive", name: "Block", settings: { shape: "box", width: 2, depth: 2, height: 1 } }));
  await built();
  await state(() => {
    const s = window.whittle.useApp;
    const b = s.getState().regen.bodies.at(-1);
    const i = b.edges.findIndex((e) => Math.abs(e.tangent[2]) > 0.99);
    s.setState({ selection: [{ kind: "edge", bodyId: b.id, index: i }], mode: { kind: "model" } });
  });
  await page.keyboard.press("f");
  await built();
  const radius = () => state(() => { const s = window.whittle.useApp.getState(); return { open: !!s.session, r: s.session && s.doc.features.find((x) => x.id === s.session.featureId)?.radius }; });
  const r0 = await radius();
  const field = page.locator(".panel .field__input").first();
  await field.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("0.3");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const r1 = await radius();
  expect(r1.open && r1.r === r0.r, "first Esc restores the value and keeps the dialog", { r0, r1 });
});

await step("06-drag-handle-decimal", async () => {
  const input = page.locator(".drag-handle__input").first();
  await input.waitFor({ timeout: 10000 });
  await input.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("0.25");
  await page.waitForTimeout(300);
  const r = await state(() => { const s = window.whittle.useApp.getState(); return s.doc.features.find((x) => x.id === s.session.featureId)?.radius; });
  expect(Math.abs(Number.parseFloat(r) - 0.25) < 1e-9, "the box took 0.25", { r, shown: await input.inputValue() });
});

await step("07-box-select-in-a-fillet", async () => {
  await built();
  const picks = await state(() => {
    const vp = window.whittle.viewportRef.current;
    const s = window.whittle.useApp.getState();
    vp.setPickFilter({ faces: false, edges: true, planes: false, sketches: false });
    const ps = vp.boxSelect([5, 5], [vp.size.x - 5, vp.size.y - 5], true);
    const pre = s.regen.pickBodies ?? [];
    return { n: ps.length, pre: pre.map((b) => b.edges.length), bad: ps.filter((p) => !pre.find((b) => b.id === p.bodyId)?.edges[p.index]).length };
  });
  expect(picks.n > 0 && picks.pre.length > 0 && picks.bad === 0, "every box pick names an edge of the body before the fillet", picks);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
});

await step("08-dimension-across-an-axis-then-fit", async () => {
  await page.keyboard.press("s");
  await page.locator(".tree__row", { hasText: "XY plane" }).click();
  await page.waitForTimeout(1200);
  box = await page.locator("canvas").first().boundingBox();
  const screen = (p) => state((q) => window.whittle.viewportRef.current.sketchToScreen(q), p);
  const clickSketch = async (p) => {
    const [x, y] = await screen(p);
    await page.mouse.move(box.x + x, box.y + y, { steps: 3 });
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(150);
  };
  const inch = 25.4;
  await setTool("rect");
  await clickSketch([-1.5 * inch, -inch]);
  await clickSketch([1.5 * inch, inch]);
  await page.waitForTimeout(400);
  // The width's natural spot is straight below the bottom edge's middle: on the Y axis, for a shape centred there.
  await setTool("dimension");
  await clickSketch([0.75 * inch, -inch]);
  await clickSketch([0, -2 * inch]);
  const dlg = page.getByRole("dialog", { name: "Distance" });
  await dlg.waitFor({ timeout: 5000 });
  await dlg.locator("input").fill("24");
  await dlg.locator("input").press("Enter");
  await built();
  const width = await state(() => {
    const s = window.whittle.useApp.getState();
    const sk = s.doc.features.filter((f) => f.type === "sketch").at(-1);
    const xs = Object.values(s.regen.sketches.find((x) => x.id === sk.id).solution.points).map((p) => p[0]);
    return Math.max(...xs) - Math.min(...xs);
  });
  expect(Math.abs(width - 24 * inch) < 1e-6, "the click below the edge placed its length, not an angle to the axis", width / inch);
  // Now far wider than the screen: Fit brings the whole sketch back, though there is no body yet.
  await page.keyboard.press("Shift+H");
  await page.waitForTimeout(900);
  const ends = await Promise.all([screen([-12 * inch, 0]), screen([12 * inch, 0])]);
  expect(ends.every(([x, y]) => x > 0 && x < box.width && y > 0 && y < box.height), "Fit shows the whole sketch", { ends, box });
});

if (errors.length) {
  console.error("console errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
await browser.close();
