/**
 * End-to-end test of the advanced tools, settings and design API.
 *   node tests/e2e/advanced.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/advanced";
mkdirSync(out, { recursive: true });

const channel = process.env.BROWSER_CHANNEL ?? "msedge";
const browser = await chromium.launch({ channel, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
// Whittle never uses the browser's alert / confirm / prompt.
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
const expect = (cond, msg, detail) => {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(detail)}`);
};

await step("01-first-run-profile", async () => {
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1")); // the test hook is off unless asked for
  await page.goto(url);
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  await page.getByText("What brings you to Whittle?").waitFor();
  await page.getByRole("button", { name: /Engineer & professional/ }).click();
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).getByRole("button", { name: /New design/ }).first().click();
  await waitBuilt();
  // The professional profile puts Sweep and Draft on the toolbar.
  await page.locator(".toolbar").getByRole("button", { name: "Sweep" }).waitFor();
  await page.locator(".toolbar").getByRole("button", { name: "Draft" }).waitFor();
});

await step("02-settings-themes", async () => {
  await page.keyboard.press("Control+,");
  await page.getByRole("dialog", { name: "Settings" }).waitFor();
  for (const t of ["Midnight", "Blueprint", "Studio", "High contrast", "Paper"]) {
    await page.getByRole("radio", { name: t }).click();
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(theme === { Midnight: "midnight", Blueprint: "blueprint", Studio: "studio", "High contrast": "contrast", Paper: "paper" }[t], "theme applied", { t, theme });
  }
  await page.getByRole("radio", { name: "Teal" }).click();
  expect((await page.evaluate(() => document.documentElement.dataset.accent)) === "teal", "accent applied", {});
  await page.getByRole("radio", { name: "Graphite" }).click();
});

await step("03-settings-select-and-nav", async () => {
  await page.getByRole("tab", { name: "Workspace" }).click();
  // The app-drawn select: open, arrow down, Enter.
  const units = page.getByRole("button", { name: "Units for new designs" });
  await units.click();
  await page.getByRole("listbox").waitFor();
  await page.getByRole("option", { name: /Inches/ }).click();
  expect((await page.evaluate(() => window.whittle.useApp.getState().prefs.units)) === "in", "units preference", {});
  await units.click();
  await page.getByRole("option", { name: /Millimetres/ }).click();
  await page.getByRole("tab", { name: "Navigation" }).click();
  await page.getByRole("radio", { name: /SolidWorks/ }).click();
  expect((await page.evaluate(() => window.whittle.useApp.getState().prefs.nav)) === "solidworks", "nav preset", {});
  await page.getByRole("radio", { name: /^Whittle/ }).click();
  await page.keyboard.press("Escape");
});

await step("04-api-sweep", async () => {
  const prof = await api("add_sketch", { plane: "XY", shapes: [{ type: "circle", diameter: 6 }, { type: "circle", diameter: 4 }] });
  const path = await api("add_sketch", { plane: "XZ", shapes: [{ type: "path", smooth: true, points: [[0, 0], [0, 30], [20, 50], [50, 55]] }] });
  const sw = await api("add_feature", { type: "sweep", settings: { profile: prof.id, path: path.id } });
  expect(sw.status?.state === "ok", "sweep built", sw);
  await page.keyboard.press("Shift+H");
  await waitBuilt();
});

await step("05-api-thread-split-draft", async () => {
  await api("set_parameter", { name: "rod_r", value: 4 });
  const rod = await api("add_feature", { type: "primitive", settings: { shape: "cylinder", radius: "rod_r", height: 20, position: [80, 0, 0] } });
  expect(rod.status?.state === "ok", "rod built", rod);
  const th = await api("add_feature", { type: "coil", settings: { section: "triangle", radius: "rod_r", pitch: 1.25, height: 20, size: 0.75, position: [80, 0, 0], op: "join", target: rod.body } });
  expect(th.status?.state === "ok", "thread built", th);
  const box = await api("add_feature", { type: "primitive", name: "Block", settings: { shape: "box", width: 30, depth: 30, height: 20, position: [0, 80, 0] } });
  const dr = await api("add_feature", { type: "draft", settings: { body: box.body, angle: 3, pull: "z" } });
  expect(dr.status?.state === "ok", "draft built", dr);
  const sp = await api("add_feature", { type: "split", settings: { body: box.body, plane: "XY", offset: 10, keep: "both" } });
  expect(sp.status?.state === "ok", "split built", sp);
  const bad = await api("add_feature", { type: "fillet", settings: { body: "No such body" } });
  expect(typeof bad.error === "string", "bad input is reported, not thrown", bad);
  const d = await api("get_design", {});
  expect(d.bodies.length >= 4, "bodies listed", d.bodies.length);
  await page.keyboard.press("Shift+H");
  await waitBuilt();
});

await step("06-analysis-modes", async () => {
  for (const label of ["Draft", "Zebra", "Overhangs"]) {
    await page.locator(".dock__btn", { hasText: label }).click();
    await page.waitForTimeout(250);
  }
  await page.locator(".dock__btn", { hasText: "Overhangs" }).click();
});

await step("07-confirm-dialog", async () => {
  // Deleting a step that others depend on asks in Whittle's own dialog.
  await page.evaluate(() => {
    const s = window.whittle.useApp.getState();
    const sk = s.doc.features.find((f) => f.type === "sketch");
    window.whittle.useApp.setState({ selection: [{ kind: "sketch", sketchId: sk.id }] });
  });
  await page.keyboard.press("Delete");
  const dlg = page.getByRole("alertdialog");
  await dlg.waitFor();
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await dlg.waitFor({ state: "detached" });
});

await step("08-assistant-panel", async () => {
  await page.keyboard.press("Control+i");
  await page.getByRole("complementary", { name: "AI assistant" }).waitFor();
  await page.getByRole("button", { name: "Set up a provider" }).click();
  await page.getByRole("dialog", { name: "Settings" }).waitFor();
  await page.getByRole("button", { name: "Add a provider" }).click();
  await page.getByRole("option", { name: /Ollama/ }).click();
  await page.getByText("OpenAI-compatible").waitFor();
  await page.keyboard.press("Escape");
});

await step("09-tooltip", async () => {
  await page.getByTitle("Settings (Ctrl+,)").hover();
  await page.getByRole("tooltip").waitFor();
  await page.mouse.move(700, 450);
});

if (errors.length) {
  console.error("console errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
await browser.close();
