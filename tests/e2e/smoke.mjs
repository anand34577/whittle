/**
 * End-to-end smoke test: drives the real app in a headless browser.
 *   node tests/e2e/smoke.mjs [url] [screenshotDir]
 * Uses an installed Edge/Chrome (no browser download needed).
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results";
mkdirSync(out, { recursive: true });

const channel = process.env.BROWSER_CHANNEL ?? "msedge";
const browser = await chromium.launch({ channel, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

const step = async (name, fn) => {
  const t = Date.now();
  await fn();
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`ok  ${name} (${Date.now() - t} ms)`);
};
const status = () => page.locator(".statusbar__meta").innerText();
const waitBuilt = async () => {
  await page.waitForFunction(() => /Built in|Ready/.test(document.querySelector(".statusbar__meta")?.textContent ?? "") && window.whittle.useApp.getState().builtDoc === window.whittle.useApp.getState().doc, null, { timeout: 60000 });
  await page.waitForTimeout(400);
};

await step("01-welcome", async () => {
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1")); // the test hook is off unless asked for
  await page.goto(url);
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  // First run asks how Whittle will be used; any answer leads to the start screen.
  await page.getByRole("button", { name: /Maker & hobbyist/ }).click();
  await waitBuilt();
});

await step("02-template-plate", async () => {
  await page.getByRole("button", { name: /Mounting plate/ }).click();
  await waitBuilt();
  await page.waitForTimeout(800);
  const bodies = await page.locator(".tree__section").filter({ hasText: "Bodies" }).locator(".tree__count").innerText();
  if (bodies.trim() !== "1") throw new Error("expected 1 body, got " + bodies);
});

await step("03-param-change", async () => {
  await page.getByTitle("Parameters").click();
  const row = page.locator(".ptable__row").filter({ has: page.locator('input[value="width"]') });
  await row.getByLabel("Formula").fill("120 mm");
  await page.keyboard.press("Escape");
  await waitBuilt();
  await page.waitForTimeout(600);
});

await step("04-new-sketch", async () => {
  await page.keyboard.press("Control+k");
  await page.keyboard.type("new design");
  await page.keyboard.press("Enter");
  // Unsaved work: Whittle asks in its own dialog (never the browser's).
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" }).click();
  await page.waitForTimeout(300);
  await page.keyboard.press("s");
  await page.locator(".tree__row", { hasText: "XY plane" }).click();
  await page.waitForTimeout(900);
  const box = await page.locator(".viewport").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 120, cy - 70);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.move(cx + 100, cy + 80, { steps: 5 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/04a-drawing.png` });
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press("c");
  await page.mouse.move(cx - 10, cy + 5);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.type("20");
  await page.keyboard.press("Enter");
  await waitBuilt();
});

await step("05-extrude", async () => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await waitBuilt();
  await page.keyboard.press("e");
  await waitBuilt();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/05a-extrude-panel.png` });
  await page.keyboard.press("Enter");
  await page.locator(".panel .field__input").first().waitFor({ state: "detached" }).catch(() => {});
  await waitBuilt();
  await page.keyboard.press("h");
  await page.waitForTimeout(700);
});

await step("06-fillet", async () => {
  // Select the four vertical edges through the store (mouse edge-hunting is flaky headless).
  await page.evaluate(() => {
    const { useApp } = window.whittle;
    const b = useApp.getState().regen.bodies[0];
    const sel = b.edges.map((e, i) => ({ e, i })).filter(({ e }) => Math.abs(e.tangent[2]) > 0.99).map(({ i }) => ({ kind: "edge", bodyId: b.id, index: i }));
    useApp.setState({ selection: sel });
  });
  await page.waitForTimeout(200);
  await page.keyboard.press("f");
  await waitBuilt();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("6");
  await waitBuilt();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/06a-fillet-preview.png` });
  await page.keyboard.press("Enter");
  await waitBuilt();
  const st = await page.evaluate(() => {
    const s = window.whittle.useApp.getState();
    return { session: !!s.session, states: s.regen.status.map((x) => x.state), faces: s.regen.bodies[0].faces.length };
  });
  if (st.session || st.states.some((x) => x !== "ok") || st.faces < 10) throw new Error("fillet failed: " + JSON.stringify(st));
});

await step("06b-export-3mf", async () => {
  const dl = page.waitForEvent("download");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("export 3mf");
  await page.keyboard.press("Enter");
  const d = await dl;
  const path = `${out}/${d.suggestedFilename()}`;
  await d.saveAs(path);
  console.log("    downloaded", d.suggestedFilename());
});
await step("07-theme-toggle", async () => {
  // The default is the light default theme, so the button offers the dark one; either way it flips.
  await page.getByTitle(/(Light|Dark) theme/).click();
  await page.waitForTimeout(400);
});

console.log("status:", await status());
console.log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "no console errors");
await browser.close();
process.exit(errors.length ? 1 : 0);