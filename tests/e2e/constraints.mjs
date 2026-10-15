/**
 * End-to-end test of the constraint-driven sketcher: drawing solver lines,
 * auto horizontal/vertical, a driving dimension typed as a formula,
 * constraint labels on the canvas (editing a dimension from its label),
 * degree-of-freedom colouring, a conflict message, the design API, and a
 * parameter change re-solving the extruded profile.
 *   node tests/e2e/constraints.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/constraints";
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
const state = (fn, arg) => page.evaluate(fn, arg);
const expect = (cond, msg, detail) => {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(detail)}`);
};
const sketchInfo = () =>
  state(() => {
    const s = window.whittle.useApp.getState();
    const sk = s.doc.features.find((f) => f.type === "sketch");
    const sol = s.regen?.sketches.find((x) => x.id === sk.id)?.solution;
    return { id: sk.id, geometry: sk.geometry ?? [], constraints: sk.constraints ?? [], sol };
  });

let box;
const click = async (x, y, opts = {}) => {
  await page.mouse.move(box.x + box.width / 2 + x, box.y + box.height / 2 + y, { steps: 3 });
  if (opts.shift) await page.keyboard.down("Shift");
  await page.mouse.down();
  await page.mouse.up();
  if (opts.shift) await page.keyboard.up("Shift");
  await page.waitForTimeout(80);
};

await step("01-start", async () => {
  await page.goto(url);
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  await page.getByRole("button", { name: /Engineer & professional/ }).click();
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).getByRole("button", { name: /New design/ }).first().click();
  await waitBuilt();
  const p = await api("set_parameter", { name: "w", value: 50 });
  expect(p.ok, "parameter w", p);
});

await step("02-draw-solver-lines", async () => {
  await page.keyboard.press("s");
  await page.locator(".tree__row", { hasText: "XY plane" }).click();
  await page.waitForTimeout(900);
  await page.locator('[data-tour="tool-segment"]').click();
  box = await page.locator(".viewport").boundingBox();
  await click(-120, 80);
  await click(120, 80);
  await click(120, -80);
  await click(-120, -80);
  await click(-120, 80); // close on the first point
  await waitBuilt();
  const sk = await sketchInfo();
  const lines = sk.geometry.filter((g) => g.type === "line");
  const hv = sk.constraints.filter((c) => c.type === "horizontal" || c.type === "vertical");
  expect(lines.length === 4, "four lines", sk.geometry);
  expect(sk.geometry.filter((g) => g.type === "point").length === 4, "corners are shared points", sk.geometry);
  expect(hv.length === 4, "level lines got Horizontal / Vertical", sk.constraints);
  expect(sk.sol?.state === "under" && sk.sol.dof === 4, "under-defined with 4 freedoms", sk.sol);
  await page.getByText(/4 degrees of freedom left/).waitFor();
  // The closed loop is a solid profile.
  expect(await state(() => (window.whittle.useApp.getState().regen.sketches[0].fill?.length ?? 0) > 0), "profile is filled", {});
});

await step("03-dimension-with-formula", async () => {
  await page.locator('[data-tour="tool-select"]').click();
  await click(0, 80); // the bottom line
  const sel = await state(() => window.whittle.useApp.getState().sketchSel);
  expect(sel.length === 1, "bottom line selected", sel);
  await page.getByRole("button", { name: "Distance…" }).click();
  const dlg = page.getByRole("dialog", { name: "Distance" });
  await dlg.waitFor();
  await dlg.locator("input").fill("w");
  await page.screenshot({ path: `${out}/03a-dimension-dialog.png` });
  await dlg.locator("input").press("Enter");
  await waitBuilt();
  const sk = await sketchInfo();
  const d = sk.constraints.find((c) => c.type === "distance");
  expect(d?.value === "w", "distance uses the parameter", sk.constraints);
  expect(sk.sol.dof === 3, "one freedom fewer", sk.sol);
});

await step("04-api-fully-defined", async () => {
  const sk = await sketchInfo();
  const lines = sk.geometry.filter((g) => g.type === "line");
  // Drawn in order: bottom, right, top, left.
  const r = await api("constrain_sketch", {
    sketch: sk.id,
    constraints: [
      { type: "distance", refs: [lines[1].id], value: "w * 0.6" },
      { type: "coincident", refs: [`${lines[0].id}.start`, "origin"] },
    ],
  });
  expect(r.solver?.state === "full" && r.solver.dof === 0, "fully defined", r);
  await page.getByText("Fully defined").waitFor();
  await page.screenshot({ path: `${out}/04a-fully-defined.png` });
});

await step("04b-edit-dimension-on-canvas", async () => {
  const sk = await sketchInfo();
  const d = sk.constraints.find((c) => c.value === "w * 0.6");
  const label = page.locator(`.cmark--dim[data-constraint="${d.id}"]`);
  expect((await label.textContent())?.includes("w * 0.6"), "canvas shows the dimension", await label.textContent());
  expect((await page.locator(".cmark--glyph", { hasText: "H" }).count()) === 2, "horizontal glyphs on the canvas", {});
  await page.locator(".cmark--glyph", { hasText: "V" }).first().click();
  const sel = await state(() => window.whittle.useApp.getState().sketchSel);
  expect(sel.length === 1 && sk.constraints.find((c) => c.id === sel[0])?.type === "vertical", "clicking a glyph selects its constraint", sel);
  await label.dblclick();
  const dlg = page.getByRole("dialog", { name: "Edit distance" });
  await dlg.waitFor();
  await dlg.locator("input").fill("w * 0.5");
  await dlg.locator("input").press("Enter");
  await waitBuilt();
  const after = await sketchInfo();
  expect(after.constraints.find((c) => c.id === d.id)?.value === "w * 0.5" && after.sol.state === "full", "dimension edited from its label", after.constraints);
  await page.screenshot({ path: `${out}/04b-labels.png` });
  await api("undo", {});
  await waitBuilt();
});

await step("05-conflict-message", async () => {
  const sk = await sketchInfo();
  const vertical = sk.constraints.find((c) => c.type === "vertical");
  const r = await api("constrain_sketch", { sketch: sk.id, constraints: [{ type: "horizontal", refs: [vertical.refs[0]] }] });
  expect(r.solver?.state === "over" && /Horizontal/.test(r.solver.message), "conflict is named", r);
  await page.getByText(/Over-constrained: .*Horizontal/).first().waitFor();
  await page.locator(".constraints__list li.is-bad").first().waitFor();
  await page.screenshot({ path: `${out}/05a-conflict.png` });
  await api("undo", {});
  await waitBuilt();
  expect((await sketchInfo()).sol.state === "full", "undo clears the conflict", {});
});

await step("06-extrude-and-resolve", async () => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await waitBuilt();
  const sk = await sketchInfo();
  const ex = await api("add_feature", { type: "extrude", settings: { sketch: sk.id, distance: 10 } });
  expect(ex.status?.state === "ok", "extruded", ex);
  const vol = () => state(() => window.whittle.useApp.getState().regen.bodies.reduce((a, b) => a + b.volume, 0));
  const v1 = await vol();
  expect(Math.abs(v1 - 50 * 30 * 10) < 1e-3, "50 x 30 x 10", v1);
  await api("set_parameter", { name: "w", value: 80 });
  await waitBuilt();
  const v2 = await vol();
  expect(Math.abs(v2 - 80 * 48 * 10) < 1e-3, "changing w re-solves to 80 x 48 x 10", v2);
});

await step("07-api-arcs-trim", async () => {
  const s = await api("add_sketch", { plane: "XY", offset: 30, shapes: [] });
  const r = await api("constrain_sketch", {
    sketch: s.id,
    geometry: [
      { name: "c", type: "circle", center: [200, 0], radius: 20 },
      { name: "l", type: "line", from: [170, 0], to: [230, 0] },
    ],
    trim: [{ curve: "c", at: [200, 20] }],
  });
  expect(r.ids?.c && r.status.state === "ok", "trimmed circle builds", r);
  const kind = await state((id) => window.whittle.useApp.getState().doc.features.find((f) => f.id === id).geometry.find((g) => g.type === "arc")?.type, s.id);
  expect(kind === "arc", "circle became an arc", kind);
});

if (errors.length) {
  console.error("console errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
await browser.close();
