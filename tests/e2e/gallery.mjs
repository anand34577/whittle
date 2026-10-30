/**
 * Regenerates the product images in docs/media from the running app.
 *   node tests/e2e/gallery.mjs [url] [outDir]
 * Each shot loads a real template or part, so the pictures always match the current interface.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "docs/media";
mkdirSync(out, { recursive: true });

const channel = process.env.BROWSER_CHANNEL ?? "msedge";
const browser = await chromium.launch({ channel, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

const waitBuilt = async () => {
  await page.waitForFunction(() => /Built in|Ready/.test(document.querySelector(".statusbar__meta")?.textContent ?? "") && window.whittle.useApp.getState().builtDoc === window.whittle.useApp.getState().doc, null, { timeout: 90000 });
  await page.waitForTimeout(900);
};
const shot = async (name) => {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log("ok", name);
};
const theme = (t) => page.evaluate((x) => window.whittle.commands.find((c) => c.id === `theme-${x}`).run(), t);
const cmd = (id) => page.evaluate((x) => window.whittle.commands.find((c) => c.id === x).run(), id);
const view = (patch) => page.evaluate((p) => window.whittle.useApp.getState().setView?.(p), patch);
const closePanel = async () => {
  await page.evaluate(() => window.whittle.useApp.setState({ panel: null }));
  await page.waitForTimeout(400);
};
const openTemplate = async (title) => {
  await page.evaluate(() => window.whittle.useApp.setState({ panel: "welcome" }));
  await page.waitForTimeout(500);
  await page.locator(".tpl", { hasText: title }).first().click();
  const confirm = page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await waitBuilt();
  await closePanel();
};

await page.addInitScript(() => localStorage.setItem("whittle.debug", "1"));
await page.goto(url);
await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
await page.getByRole("button", { name: /Engineer & professional/ }).click();
await page.waitForTimeout(1200);

// Start screen with the template gallery.
await theme("daylight");
await page.waitForTimeout(600);
await shot("screenshot-start");

const templates = [
  ["Mounting plate", "plate"],
  ["Project box", "box"],
  ["Hex bolt", "bolt"],
  ["Twisted vase", "vase"],
  ["Bottle", "bottle"],
  ["Shelf bracket", "bracket"],
  ["Drawer handle", "handle"],
  ["Control knob", "knob"],
];
const looks = { plate: "graphite", box: "daylight", bolt: "midnight", vase: "studio", bottle: "paper", bracket: "daylightdark", handle: "blueprint", knob: "graphite" };
for (const [title, id] of templates) {
  await theme(looks[id]);
  await openTemplate(title);
  await shot(`screenshot-${id}`);
}

// Feature spotlights on the mounting plate.
await theme("daylightdark");
await openTemplate("Mounting plate");
await page.getByTitle("Parameters").click();
await page.waitForTimeout(700);
await shot("screenshot-parameters");
await closePanel();

await page.keyboard.press("Control+k");
await page.waitForTimeout(500);
await page.keyboard.type("fillet");
await page.waitForTimeout(500);
await shot("screenshot-palette");
await page.keyboard.press("Escape");

await theme("midnight");
await openTemplate("Project box");
await cmd("section");
await page.waitForTimeout(900);
await shot("screenshot-section");
await cmd("section");

await theme("graphite");
await openTemplate("Twisted vase");
await cmd("zebra");
await page.waitForTimeout(900);
await shot("screenshot-zebra");
await cmd("zebra");

await theme("daylight");
await page.evaluate(() => window.whittle.useApp.setState({ panel: "parts" }));
await page.waitForTimeout(800);
await shot("screenshot-parts");
await closePanel();

await openTemplate("Hex bolt");
await page.evaluate(() => window.whittle.useApp.setState({ panel: "export" }));
await page.waitForTimeout(800);
await shot("screenshot-export");
await closePanel();

await page.evaluate(() => window.whittle.useApp.setState({ panel: "settings" }));
await page.waitForTimeout(800);
await shot("screenshot-themes");
await closePanel();


// Sketching and the live extrude preview, driven like a person would.
await theme("daylight");
await page.evaluate(() => window.whittle.commands.find((c) => c.id === "new").run?.());
await page.keyboard.press("Control+k");
await page.keyboard.type("new design");
await page.keyboard.press("Enter");
const discard = page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" });
if (await discard.isVisible().catch(() => false)) await discard.click();
await page.waitForTimeout(500);
await closePanel();
await page.keyboard.press("s");
await page.locator(".tree__row", { hasText: "XY plane" }).click();
await page.waitForTimeout(1000);
const box = await page.locator(".viewport").boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx - 160, cy - 90);
await page.mouse.down();
await page.mouse.up();
await page.mouse.move(cx + 140, cy + 100, { steps: 6 });
await page.waitForTimeout(300);
await shot("screenshot-sketch");
await page.mouse.down();
await page.mouse.up();
await page.keyboard.press("c");
await page.mouse.move(cx - 10, cy + 5);
await page.mouse.down();
await page.mouse.up();
await page.keyboard.type("24");
await page.keyboard.press("Enter");
await waitBuilt();
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await waitBuilt();
await page.keyboard.press("e");
await waitBuilt();
await page.waitForTimeout(600);
await shot("screenshot-extrude");

// Phone layout.
await page.setViewportSize({ width: 430, height: 900 });
await theme("graphite");
await openTemplate("Bottle");
await shot("screenshot-phone");

await browser.close();
if (errors.length) console.log("console errors:", errors.slice(0, 5));
