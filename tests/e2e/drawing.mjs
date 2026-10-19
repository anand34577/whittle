/**
 * End-to-end test of the 2D drawing export options: sheet size, scale, first-angle,
 * section view and parts list, chosen in the Export dialog.
 *   node tests/e2e/drawing.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/drawing";
mkdirSync(out, { recursive: true });

const channel = process.env.BROWSER_CHANNEL ?? "msedge";
const browser = await chromium.launch({ channel, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1500 }, acceptDownloads: true });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

const waitBuilt = async () => {
  await page.waitForFunction(() => /Built in|Ready/.test(document.querySelector(".statusbar__meta")?.textContent ?? "") && window.whittle.useApp.getState().builtDoc === window.whittle.useApp.getState().doc, null, { timeout: 60000 });
  await page.waitForTimeout(300);
};
const api = (name, input) => page.evaluate(([n, i]) => window.whittle.api.run(n, i), [name, input]);
const expect = (cond, msg, detail) => {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(detail)}`);
};

await page.addInitScript(() => localStorage.setItem("whittle.debug", "1"));
await page.goto(url);
await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
await page.getByRole("button", { name: /Engineer & professional/ }).click();
await page.getByRole("dialog", { name: "Welcome to Whittle" }).getByRole("button", { name: /New design/ }).first().click();
await waitBuilt();
await api("add_feature", { type: "primitive", name: "Block", settings: { shape: "box", width: 60, depth: 40, height: 20, position: [0, 0, 0] } });
await waitBuilt();

await page.evaluate(() => window.whittle.commands.find((c) => c.id === "export").run());
const dialog = page.getByRole("dialog", { name: "Export" });
await dialog.waitFor();
await dialog.locator("summary").click();
await dialog.getByRole("radio", { name: "A4", exact: true }).click();
await dialog.getByRole("radio", { name: "1:2", exact: true }).click();
await dialog.getByRole("radio", { name: "First angle", exact: true }).click();
await dialog.getByText(/Section view A-A/).click();
await dialog.getByText(/Parts list/).first().click();
await page.screenshot({ path: `${out}/options.png` });

const dl = page.waitForEvent("download", { timeout: 20000 });
await dialog.getByRole("button", { name: /2D drawing \(SVG\)/ }).click();
const d = await dl.catch(async (e) => {
  console.log("toasts:", await page.locator("[role=status], .toast").allInnerTexts());
  throw e;
});
const path = await d.path();
const svg = readFileSync(path, "utf8");
expect(d.suggestedFilename().endsWith(".svg"), "an SVG came down", d.suggestedFilename());
expect(svg.includes('viewBox="0 0 297 210"'), "A4 sheet", svg.slice(0, 200));
expect(svg.includes(">1:2<"), "chosen scale", {});
expect(svg.includes("first-angle"), "first-angle projection", {});
expect(svg.includes("SECTION A-A") && svg.includes("url(#hatch)"), "section view with hatching", {});
expect(svg.includes(">Block<") || svg.includes("Body"), "parts list rows", {});
console.log("ok  drawing options");

if (errors.length) {
  console.error("console errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
await browser.close();
