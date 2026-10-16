/**
 * End-to-end test of the self-hosted server mode: first-run admin setup,
 * saving to the server, the design gallery, version history and restore,
 * sign-out and sign-in. Needs a fresh whittle-server serving the built app:
 *   WHITTLE_DATA=$(mktemp -d) WHITTLE_WEB=apps/web/dist WHITTLE_PUBLIC_URL=<the address you pass below> whittle-server
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
// Native browser dialogs must never appear: Whittle uses its own.
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
const waitBuilt = () =>
  page.waitForFunction(() => /Built in|Ready/.test(document.querySelector(".statusbar__meta")?.textContent ?? "") && window.whittle.useApp.getState().builtDoc === window.whittle.useApp.getState().doc, null, { timeout: 60000 });
const state = (fn) => page.evaluate(fn);

await step("01-first-run-setup", async () => {
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1")); // the test hook is off unless asked for
  await page.goto(url);
  await page.getByRole("dialog", { name: "Sign in to Whittle" }).waitFor();
  await page.getByText("Create the administrator account").waitFor();
  await page.getByLabel("Username").fill("ada");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Your name").fill("Ada Lovelace");
  await page.getByLabel("Password", { exact: true }).fill("analytical engine");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  // First run asks how Whittle will be used; any answer leads to the start screen.
  await page.getByRole("button", { name: /Maker & hobbyist/ }).click();
  await page.locator(".library .eyebrow", { hasText: "Your designs" }).waitFor();
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
  // The status bar still shows the previous build, so wait for the new result itself.
  await page.waitForFunction(() => window.whittle.useApp.getState().regen?.bodies.length === 1, null, { timeout: 60000 });
});

await step("06-sign-out-in", async () => {
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("dialog", { name: "Sign in to Whittle" }).waitFor();
  await page.getByLabel("Username or email").fill("ada@example.com");
  await page.getByLabel("Password", { exact: true }).fill("wrong password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("Wrong username or password").waitFor();
  await page.getByLabel("Password", { exact: true }).fill("analytical engine");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator(".library .eyebrow", { hasText: "Your designs" }).waitFor();
});

await step("07-administration", async () => {
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("button", { name: "Administration" }).click();
  const admin = page.getByRole("dialog", { name: "Administration" });
  await admin.waitFor();
  // Add a person.
  await admin.getByRole("button", { name: "Add person" }).click();
  await admin.getByLabel("Username", { exact: true }).fill("bob");
  await admin.getByLabel("Email").fill("bob@example.com");
  await admin.getByLabel("Password", { exact: true }).fill("difference engine");
  await admin.getByRole("button", { name: "Add person" }).click();
  await admin.getByText("bob@example.com").waitFor();
  // Edit him.
  await admin.getByRole("button", { name: /^bob/ }).click();
  await admin.getByLabel("Name", { exact: true }).fill("Bob Babbage");
  await admin.getByRole("button", { name: "Save" }).click();
  await admin.getByText("Bob Babbage").waitFor();
  // Email over plain (unencrypted) SMTP.
  await admin.getByRole("tab", { name: "Sign-in & email" }).click();
  await admin.getByLabel("Server").fill("127.0.0.1");
  await admin.getByRole("button", { name: "Security" }).click();
  await page.getByRole("option", { name: /None \(unencrypted\)/ }).click();
  await admin.getByText("travel unencrypted").waitFor();
  await admin.getByLabel("From address").fill("cad@example.com");
  await admin.getByRole("button", { name: "Save email settings" }).click();
  await page.getByText("Email settings saved").waitFor();
  const cfg = await state(() => fetch("./api/config").then((r) => r.json()));
  if (!cfg.passwordReset) throw new Error("password reset should be available once email is set up");
  // Everything shows in the activity log.
  await admin.getByRole("tab", { name: "Activity" }).click();
  await admin.getByText("changed server settings").waitFor();
  await admin.getByText("added").first().waitFor();
});

console.log(errors.length ? "console errors:\n" + errors.join("\n") : "no console errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
