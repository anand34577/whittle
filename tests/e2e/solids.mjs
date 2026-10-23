/**
 * End-to-end test of the features added in the third audit: symmetric and two-sided revolve, shell direction,
 * moments of inertia, the new library parts and the wider formula language.
 *   node tests/e2e/solids.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/solids";
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
const bodies = () => state(() => window.whittle.useApp.getState().regen.bodies.map((b) => ({ id: b.id, name: window.whittle.useApp.getState().doc.bodies[b.id]?.name, volume: b.volume, bbox: b.bbox, inertia: b.inertia })));

await step("01-start", async () => {
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1")); // the test hook is off unless asked for
  await page.goto(url);
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  await page.getByRole("button", { name: /Engineer & professional/ }).click();
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).getByRole("button", { name: /New design/ }).first().click();
  await waitBuilt();
});

await step("02-revolve-directions", async () => {
  const sk = await api("add_sketch", { plane: "XY", shapes: [{ type: "rect", x: 10, y: 0, width: 10, height: 10 }] });
  const rv = await api("add_feature", { type: "revolve", settings: { sketch: sk.id, axis: "y", angle: 180, extent: "symmetric" } });
  expect(rv.status?.state === "ok", "symmetric revolve builds", rv);
  await waitBuilt();
  const [b] = await bodies();
  // Half a turn straddling the profile on +X: nothing reaches the -X side.
  expect(b.bbox[0][0] > -0.01 && b.bbox[1][0] > 14, "symmetric revolve stays on the profile's side", b.bbox);
  // Open it in the editor: the Direction control is there and "Two sides" asks for a second angle.
  await state((id) => window.whittle.editFeature(id), rv.id);
  await page.getByRole("radio", { name: "Two sides" }).click();
  await page.waitForTimeout(300);
  expect(await page.getByText("Angle 2", { exact: true }).count() > 0, "two-sided revolve shows its second angle");
  await page.keyboard.press("Escape");
});

await step("03-shell-direction", async () => {
  const box = await api("add_feature", { type: "primitive", settings: { shape: "box", width: 40, depth: 30, height: 20, position: [100, 0, 0] } });
  const sh = await api("add_feature", { type: "shell", settings: { body: box.body, face: "none", thickness: 2, direction: "outside" } });
  expect(sh.status?.state === "ok", "outside shell builds", sh);
  await waitBuilt();
  const b = (await bodies()).find((x) => x.name === box.body);
  expect(Math.abs(b.bbox[1][0] - b.bbox[0][0] - 44) < 0.01, "an outside wall grows the part, so it is 44 wide", b.bbox);
  expect(Math.abs(b.volume - (44 * 34 * 24 - 40 * 30 * 20)) < 1, "outside shell volume", b.volume);
});

await step("04-inertia-row", async () => {
  await state(() => window.whittle.useApp.setState({ selection: [] }));
  const row = page.locator(".stats dt", { hasText: "Inertia" });
  await row.waitFor();
  const text = await row.locator("xpath=following-sibling::dd[1]").innerText();
  expect(/g·cm²/.test(text), "inertia is shown in g·cm²", text);
  const box = (await bodies()).find((b) => b.inertia);
  expect(box.inertia.every(Number.isFinite), "inertia numbers", box.inertia);
});

await step("05-new-parts", async () => {
  await page.keyboard.press("p");
  const dlg = page.getByRole("dialog").first();
  await dlg.waitFor();
  for (const name of ["Hex bolt", "Screw boss", "Vent grille", "Compression spring"]) {
    expect(await dlg.getByText(name, { exact: false }).count() > 0, `the parts library lists ${name}`);
  }
  await dlg.getByText("Hex bolt", { exact: false }).first().click();
  await waitBuilt();
  const names = await state(() => window.whittle.useApp.getState().doc.parameters.map((p) => p.name));
  expect(names.some((n) => /^bolt1_/.test(n)), "the bolt inserted its parameters", names);
  const st = await state(() => window.whittle.useApp.getState().regen.status.filter((s) => s.state !== "ok"));
  expect(st.length === 0, "the bolt builds cleanly", st);
});

await step("06-formulas", async () => {
  // 8 mm + 5 mm + 1 mm: the wider function set and unit checking work in a real field.
  const r = await api("set_parameter", { name: "pitch", value: "pow(2, 3) * 1 mm + hypot(3 mm, 4 mm) + mod(7 mm, 3 mm)", kind: "length" });
  expect(r.ok && /^14 ?mm$/.test(r.value), "formula with new functions", r);
  const bad = await api("set_parameter", { name: "pitch2", value: "ln(0)", kind: "number" });
  expect(bad.error && /above zero/.test(bad.error), "a function that has no answer explains why", bad);
  const inches = await api("set_parameter", { name: "pitch3", value: "1 inch + 10 mil", kind: "length" });
  expect(inches.ok, "inch and mil units", inches);
});

if (errors.length) {
  console.error("console errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
await browser.close();
