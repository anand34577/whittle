/**
 * Records the template, palette, surface-analysis and extrude GIFs in docs/media from the running app.
 *   GIF_TOOLS=<dir with node_modules containing gifenc and pngjs> node tests/e2e/demos-gallery.mjs [url] [outDir]
 * Companion to demos.mjs; the encoder packages are not project dependencies.
 */
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "docs/media";
mkdirSync(out, { recursive: true });
if (!process.env.GIF_TOOLS) throw new Error("Set GIF_TOOLS to a folder whose node_modules has gifenc and pngjs");
const req = createRequire(`${process.env.GIF_TOOLS}/`);
const { GIFEncoder, quantize, applyPalette } = req("gifenc");
const { PNG } = req("pngjs");

const channel = process.env.BROWSER_CHANNEL ?? "msedge";
const browser = await chromium.launch({ channel, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 750 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const waitBuilt = async () => {
  await page.waitForFunction(() => /Built in|Ready/.test(document.querySelector(".statusbar__meta")?.textContent ?? "") && window.whittle.useApp.getState().builtDoc === window.whittle.useApp.getState().doc, null, { timeout: 90000 });
  await page.waitForTimeout(500);
};
const theme = (t) => page.evaluate((x) => window.whittle.commands.find((c) => c.id === `theme-${x}`).run(), t);
const cmd = (id) => page.evaluate((x) => window.whittle.commands.find((c) => c.id === x).run(), id);
const closePanel = async () => {
  await page.evaluate(() => window.whittle.useApp.setState({ panel: null }));
  await page.waitForTimeout(300);
};
const openTemplate = async (title) => {
  await page.evaluate(() => window.whittle.useApp.setState({ panel: "welcome" }));
  await page.waitForTimeout(400);
  await page.locator(".tpl", { hasText: title }).first().click();
  const discard = page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" });
  if (await discard.isVisible().catch(() => false)) await discard.click();
  await waitBuilt();
  await closePanel();
};

let frames = [];
const snap = async (ms = 120, keepMouse = false) => {
  if (!keepMouse) await page.mouse.move(2, 2, { steps: 1 });
  frames.push({ png: await page.screenshot(), ms });
};
const save = (name) => {
  const gif = GIFEncoder();
  for (const f of frames) {
    const { data, width, height } = PNG.sync.read(f.png);
    const palette = quantize(data, 256, { format: "rgb565" });
    gif.writeFrame(applyPalette(data, palette, "rgb565"), width, height, { palette, delay: f.ms });
  }
  gif.finish();
  writeFileSync(`${out}/${name}.gif`, gif.bytes());
  console.log("ok", name, frames.length, "frames", Math.round(gif.bytes().length / 1024), "KB");
  frames = [];
};
/** Drag across the viewport so the part turns, one frame per step. */
const turn = async (steps = 16, dx = 22, ms = 100) => {
  const b = await page.locator(".viewport").boundingBox();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  await page.mouse.move(cx - (steps * dx) / 2, cy + 40);
  await page.mouse.down();
  await snap(300, true);
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx - (steps * dx) / 2 + i * dx, cy + 40 + Math.sin(i / 3) * 20, { steps: 2 });
    await snap(ms, true);
  }
  await page.mouse.up();
  await snap(500);
};

await page.addInitScript(() => localStorage.setItem("whittle.debug", "1"));
await page.goto(url);
await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
await page.getByRole("button", { name: /Engineer & professional/ }).click();
await page.waitForTimeout(1000);

// Every template, turning slowly in its own look.
const templates = [
  ["Mounting plate", "plate", "graphite"],
  ["Project box", "box", "daylight"],
  ["Hex bolt", "bolt", "midnight"],
  ["Twisted vase", "vase", "studio"],
  ["Bottle", "bottle", "paper"],
  ["Shelf bracket", "bracket", "daylightdark"],
  ["Drawer handle", "handle", "blueprint"],
  ["Control knob", "knob", "graphite"],
];
for (const [title, id, look] of templates) {
  await theme(look);
  await openTemplate(title);
  await snap(700);
  await turn();
  save(`demo-${id}`);
}

// Surface analysis: stripes on, then turn.
await theme("graphite");
await openTemplate("Twisted vase");
await snap(600);
await cmd("zebra");
await page.waitForTimeout(900);
await snap(900);
await turn(14, 20, 110);
save("demo-zebra");
await cmd("zebra");

// The command palette finding a command as you type.
await theme("daylightdark");
await openTemplate("Mounting plate");
await page.keyboard.press("Control+k");
await page.waitForTimeout(500);
await snap(700);
for (const ch of "fillet") {
  await page.keyboard.type(ch);
  await page.waitForTimeout(250);
  await snap(260);
}
await snap(1500);
save("demo-palette");
await page.keyboard.press("Escape");

// Live extrude preview: sketch, then drive the distance.
await theme("daylight");
await page.keyboard.press("Control+k");
await page.keyboard.type("new design");
await page.keyboard.press("Enter");
const discard = page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" });
if (await discard.isVisible().catch(() => false)) await discard.click();
await page.waitForTimeout(500);
await closePanel();
await page.keyboard.press("s");
await page.locator(".tree__row", { hasText: "XY plane" }).click();
await page.waitForTimeout(2200);
const vb = await page.locator(".viewport").boundingBox();
const vx = vb.x + vb.width / 2;
const vy = vb.y + vb.height / 2;
await page.mouse.move(vx - 160, vy - 90);
await page.mouse.down();
await page.mouse.up();
await page.mouse.move(vx + 140, vy + 100, { steps: 6 });
await page.waitForTimeout(300);
await snap(900, true);
await page.mouse.down();
await page.mouse.up();
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await waitBuilt();
await snap(600);
await page.keyboard.press("e");
await waitBuilt();
await page.waitForTimeout(500);
await snap(1000);
for (const v of ["8", "20", "35", "12"]) {
  await page.keyboard.press("Control+a");
  await page.keyboard.type(v);
  await waitBuilt();
  await snap(1000);
}
await page.keyboard.press("Enter");
await waitBuilt();
await snap(1500);
save("demo-extrude");

await browser.close();
if (errors.length) console.log("page errors:", errors.slice(0, 5));
