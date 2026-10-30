/**
 * Records the animated demos in docs/media from the running app.
 *   GIF_TOOLS=<dir with node_modules containing gifenc and pngjs> node tests/e2e/demos.mjs [url] [outDir]
 * The encoder packages are not project dependencies; install them anywhere and point GIF_TOOLS at that folder.
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
/** Take a frame that stays on screen for `ms`; the pointer is parked off the canvas unless `keepMouse`. */
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
  if (process.env.DUMP_FRAMES) frames.forEach((f, i) => writeFileSync(`${process.env.DUMP_FRAMES}/${name}-${i}.png`, f.png));
  gif.finish();
  writeFileSync(`${out}/${name}.gif`, gif.bytes());
  console.log("ok", name, frames.length, "frames", Math.round(gif.bytes().length / 1024), "KB");
  frames = [];
};

await page.addInitScript(() => localStorage.setItem("whittle.debug", "1"));
await page.goto(url);
await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
await page.getByRole("button", { name: /Engineer & professional/ }).click();
await page.waitForTimeout(1000);

// 1. Change one number and the whole part follows.
await theme("daylight");
await openTemplate("Mounting plate");
await page.getByTitle("Parameters").click();
await page.waitForTimeout(500);
const row = (n) => page.locator(".ptable__row").filter({ has: page.locator(`input[value="${n}"]`) });
await snap(1200);
for (const [name, value] of [["width", "120 mm"], ["depth", "80 mm"], ["thickness", "8 mm"], ["width", "70 mm"], ["depth", "50 mm"], ["thickness", "4 mm"], ["width", "80 mm"]]) {
  await row(name).getByLabel("Formula").fill(value);
  await waitBuilt();
  await snap(900);
  await closePanel();
  await snap(1100);
  await page.getByTitle("Parameters").click();
  await page.waitForTimeout(400);
}
save("demo-parameters");

// 2. Orbit a finished part.
await theme("graphite");
await openTemplate("Twisted vase");
await closePanel();
const box = await page.locator(".viewport").boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx - 220, cy);
await page.mouse.down();
await snap(200);
for (let i = 1; i <= 24; i++) {
  await page.mouse.move(cx - 220 + i * 18, cy + Math.sin(i / 4) * 30, { steps: 2 });
  await snap(90);
}
await page.mouse.up();
await snap(500);
save("demo-orbit");

// 3. Sketch, extrude, fillet.
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
await snap(900);
await page.mouse.move(vx - 160, vy - 90);
await page.mouse.down();
await page.mouse.up();
for (let i = 1; i <= 6; i++) {
  await page.mouse.move(vx - 160 + i * 50, vy - 90 + i * 31, { steps: 2 });
  await snap(110, true);
}
await snap(600, true);
await page.mouse.down();
await page.mouse.up();
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await waitBuilt();
await snap(700);
await page.keyboard.press("e");
await waitBuilt();
await page.waitForTimeout(500);
await snap(1100);
await page.keyboard.press("Enter");
await waitBuilt();
await page.keyboard.press("h");
await page.waitForTimeout(800);
await snap(1000);
await page.evaluate(() => {
  const { useApp } = window.whittle;
  const b = useApp.getState().regen.bodies[0];
  const sel = b.edges.map((e, i) => ({ e, i })).filter(({ e }) => Math.abs(e.tangent[2]) > 0.99).map(({ i }) => ({ kind: "edge", bodyId: b.id, index: i }));
  useApp.setState({ selection: sel });
});
await page.waitForTimeout(300);
await page.keyboard.press("f");
await waitBuilt();
for (const v of ["2", "5", "9"]) {
  await page.keyboard.press("Control+a");
  await page.keyboard.type(v);
  await waitBuilt();
  await snap(900);
}
await page.keyboard.press("Enter");
await waitBuilt();
await page.evaluate(() => window.whittle.useApp.setState({ selection: [] }));
await page.waitForTimeout(500);
await snap(1600);
save("demo-sketch-extrude-fillet");

// 4. Eight themes.
await openTemplate("Bottle");
for (const t of ["daylight", "daylightdark", "graphite", "paper", "midnight", "blueprint", "studio", "contrast"]) {
  await theme(t);
  await page.waitForTimeout(500);
  await snap(1000);
}
save("demo-themes");

// 5. Slice through a part.
await theme("midnight");
await openTemplate("Project box");
await cmd("section");
await page.waitForTimeout(600);
await snap(900);
for (const off of [-24, -16, -8, 0, 8, 16, 24, 8, -8, -24]) {
  await page.evaluate((o) => window.whittle.useApp.getState().view.section && window.whittle.useApp.setState({ view: { ...window.whittle.useApp.getState().view, section: { ...window.whittle.useApp.getState().view.section, offset: o } } }), off);
  await page.waitForTimeout(450);
  await snap(260);
}
save("demo-section");

await browser.close();
if (errors.length) console.log("page errors:", errors.slice(0, 5));
