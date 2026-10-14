/**
 * End-to-end test of the self-hosted server mode: first-run admin setup,
 * saving to the server, the design gallery, version history and restore,
 * sign-out and sign-in. Needs a fresh whittle-server serving the built app:
 *   WHITTLE_DATA=$(mktemp -d) WHITTLE_WEB=apps/web/dist whittle-server
 *   node tests/e2e/server.mjs http://localhost:8080/ [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:8080/";
const out = process.argv[3] ?? "test-results/server";
mkdirSync(out, { recursive: true });

const channel = process.env.BROWSER_CHANNEL ?? "msedge";
const browser = await chromium.launch({ channel, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && !/401|Unauthorized/.test(m.text()) && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => d.accept());

const step = async (name, fn) => {
  const t = Date.now();
  await fn();
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`ok  ${name} (${Date.now() - t} ms)`);
};
const waitBuilt = () =>
  page.waitForFunction(() => /Built in|Ready/.test(document.querySelector(".statusbar__meta")?.textContent ?? ""), null, { timeout: 60000 });
const state = (fn) => page.evaluate(fn);

await step("01-first-run-setup", async () => {
  await page.goto(url);
  await page.getByRole("dialog", { name: "Sign in to Whittle" }).waitFor();
  await page.getByText("Create the administrator account").waitFor();
  await page.getByLabel("Username").fill("ada");
  await page.getByLabel("Your name").fill("Ada Lovelace");
  await page.getByLabel("Password").fill("analytical engine");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  await page.getByText("Your designs").waitFor();
});

await step("02-save-to-server", async () => {
  await page.getByRole("button", { name: /Mounting plate/ }).click();
  await waitBuilt();
  await page.waitForTimeout(800);
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => window.whittle.useApp.getState().fileName === "Mounting plate");
  const list = await state(() => fetch("./api/designs").then((r) => r.json()));
  if (list.length !== 1 || list[0].name !== "Mounting plate" || !list[0].hasThumbnail) throw new Error("server list: " + JSON.stringify(list));
});

await step("03-second-version", async () => {
  await state(() => {
    const s = window.whittle.useApp;
    const doc = s.getState().doc;
    s.setState({ doc: { ...doc, name: "Plate v2" }, dirty: true });
  });
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => !window.whittle.useApp.getState().dirty);
  const list = await state(() => fetch("./api/designs").then((r) => r.json()));
  if (list[0].version !== 2 || list[0].name !== "Plate v2") throw new Error("expected version 2: " + JSON.stringify(list));
});

await step("04-history-restore", async () => {
  await page.keyboard.press("Control+k");
  await page.keyboard.type("version history");
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Version history" }).waitFor();
  await page.getByText("Current", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Restore" }).first().click();
  await page.waitForFunction(() => window.whittle.useApp.getState().doc.name === "Mounting plate");
  await waitBuilt();
  const list = await state(() => fetch("./api/designs").then((r) => r.json()));
  if (list[0].version !== 3) throw new Error("restore should add version 3: " + JSON.stringify(list));
});

await step("05-gallery-reopen", async () => {
  await page.getByTitle(/Start screen/).click();
  await page.locator(".lib-card__open", { hasText: "Mounting plate" }).click();
  await waitBuilt();
  const bodies = await state(() => window.whittle.useApp.getState().regen?.bodies.length);
  if (bodies !== 1) throw new Error("reopened design should have 1 body, got " + bodies);
});

await step("06-sign-out-in", async () => {
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("dialog", { name: "Sign in to Whittle" }).waitFor();
  await page.getByLabel("Username").fill("ada");
  await page.getByLabel("Password").fill("wrong password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("Wrong username or password").waitFor();
  await page.getByLabel("Password").fill("analytical engine");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("Your designs").waitFor();
});

console.log(errors.length ? "console errors:\n" + errors.join("\n") : "no console errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
