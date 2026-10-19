/**
 * End-to-end test of per-body materials: choosing a material on one body sets its mass density
 * and look, and leaves other bodies on the design default.
 *   node tests/e2e/appearance.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/appearance";
mkdirSync(out, { recursive: true });

const channel = process.env.BROWSER_CHANNEL ?? "msedge";
const browser = await chromium.launch({ channel, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

const waitBuilt = async () => {
  await page.waitForFunction(() => /Built in|Ready/.test(document.querySelector(".statusbar__meta")?.textContent ?? "") && window.whittle.useApp.getState().builtDoc === window.whittle.useApp.getState().doc, null, { timeout: 60000 });
  await page.waitForTimeout(300);
};
const api = (name, input) => page.evaluate(([n, i]) => window.whittle.api.run(n, i), [name, input]);
const state = (fn, arg) => page.evaluate(fn, arg);
const expect = (cond, msg, detail) => {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(detail)}`);
};

await page.addInitScript(() => localStorage.setItem("whittle.debug", "1"));
await page.goto(url);
await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
await page.getByRole("button", { name: /Engineer & professional/ }).click();
await page.getByRole("dialog", { name: "Welcome to Whittle" }).getByRole("button", { name: /New design/ }).first().click();
await waitBuilt();
await api("add_feature", { type: "primitive", name: "A", settings: { shape: "box", width: 10, depth: 10, height: 10, position: [0, 0, 0] } });
await api("add_feature", { type: "primitive", name: "B", settings: { shape: "box", width: 10, depth: 10, height: 10, position: [30, 0, 0], op: "new" } });
await waitBuilt();
const ids = await state(() => Object.keys(window.whittle.useApp.getState().doc.bodies));
expect(ids.length === 2, "two bodies", ids);

await state((id) => window.whittle.useApp.setState({ selection: [{ kind: "body", bodyId: id }] }), ids[0]);
await page.waitForTimeout(300);
await page.getByRole("button", { name: "Material" }).click();
await page.getByRole("option", { name: /Brass/ }).click();
await page.waitForTimeout(300);
const meta = await state(([a, b]) => {
  const d = window.whittle.useApp.getState().doc.bodies;
  return { a: d[a], b: d[b] };
}, ids);
expect(meta.a.material === "brass" && meta.a.look === "polished", "brass body gets its look", meta.a);
expect(!meta.b.material, "the other body keeps the design default", meta.b);

await state(() => window.whittle.useApp.setState({ selection: [] }));
await page.waitForTimeout(300);
const text = await page.locator(".panel").first().innerText();
// 1 cm³ of brass is 8.5 g and 1 cm³ of the default (aluminium here) 2.7 g: 11.2 g in all.
expect(/11\.2 g/.test(text), "design mass sums per-body materials", text.slice(0, 400));
await page.screenshot({ path: `${out}/materials.png` });

if (errors.length) {
  console.error("console errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("ok  materials");
console.log("no console errors");
await browser.close();
