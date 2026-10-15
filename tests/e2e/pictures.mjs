/**
 * End-to-end test of reference pictures: add one to a sketch, trace it into
 * outlines and circles, calibrate it with two clicks, flatten it with four,
 * then extrude the traced shapes.
 *   node tests/e2e/pictures.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/pictures";
mkdirSync(out, { recursive: true });

const channel = process.env.BROWSER_CHANNEL ?? "msedge";
const browser = await chromium.launch({ channel, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
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
const sketch = () => page.evaluate(() => structuredClone(window.whittle.useApp.getState().doc.features.find((f) => f.type === "sketch")));
const expect = (cond, msg, detail) => {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(detail)}`);
};
const box = async () => {
  const b = await page.locator(".viewport").boundingBox();
  return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
};
const click = async (x, y) => {
  await page.mouse.move(x, y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);
};

await step("01-start", async () => {
  await page.goto(url);
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  await page.getByRole("button", { name: /Engineer & professional/ }).click();
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).getByRole("button", { name: /New design/ }).first().click();
  await waitBuilt();
});

await step("02-add-picture", async () => {
  // A 1000×750 drawing: a black disc with a hole, and a black square.
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1000;
    c.height = 750;
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 1000, 750);
    g.fillStyle = "#111";
    g.beginPath();
    g.arc(650, 375, 120, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(650, 375, 50, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#111";
    g.fillRect(150, 300, 150, 150);
    return c.toDataURL("image/png").split(",")[1];
  });
  await page.keyboard.press("s");
  await page.locator(".tree__row", { hasText: "XY plane" }).click();
  await page.waitForTimeout(900);
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".toolbar").getByRole("button", { name: /Insert/ }).click();
  await page.getByRole("menuitem", { name: /Picture to trace/ }).click();
  await (await chooser).setFiles({ name: "part.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await page.waitForFunction(() => window.whittle.useApp.getState().doc.features.find((f) => f.type === "sketch")?.image);
  await waitBuilt();
  const im = (await sketch()).image;
  expect(im.width === 200 && Math.abs(im.aspect - 0.75) < 1e-6 && im.src.startsWith("data:image/jpeg"), "picture placed", { ...im, src: im.src.slice(0, 30) });
});

await step("03-trace", async () => {
  await page.getByRole("button", { name: "Trace all", exact: true }).click();
  await page.waitForFunction(() => window.whittle.useApp.getState().doc.features.find((f) => f.type === "sketch").entities.length > 0);
  await waitBuilt();
  const ents = (await sketch()).entities;
  const circles = ents.filter((e) => e.type === "circle").map((e) => +e.r).sort((a, b) => a - b);
  // 0.2 mm per pixel: radii 50 px and 120 px are 10 mm and 24 mm.
  expect(ents.length === 3 && circles.length === 2, "two circles and an outline", ents.map((e) => e.type));
  expect(Math.abs(circles[0] - 10) < 0.4 && Math.abs(circles[1] - 24) < 0.4, "circle sizes", circles);
  const sq = ents.find((e) => e.type === "polyline");
  expect(sq.points.length <= 8, "square simplified to a few points", sq.points.length);
});

await step("03b-trace-one-area", async () => {
  await page.getByRole("button", { name: "Trace one area", exact: true }).click();
  const { cx, cy } = await box();
  // The ring's band: picture (650, 375) is sketch (30, 0) mm; its band spans radii 10–24 mm. About 5 px/mm here.
  await click(cx + 30 * 5.2, cy - 17 * 5.2);
  await page.waitForFunction(() => window.whittle.useApp.getState().doc.features.find((f) => f.type === "sketch").entities.length === 5);
  const ents = (await sketch()).entities.slice(3);
  expect(ents.every((e) => e.type === "circle"), "just the ring: two circles", ents);
  await page.keyboard.press("Control+z"); // keep the earlier trace only
  await page.waitForFunction(() => window.whittle.useApp.getState().doc.features.find((f) => f.type === "sketch").entities.length === 3);
});

await step("04-calibrate", async () => {
  const before = (await sketch()).image.width;
  await page.getByRole("button", { name: "Calibrate", exact: true }).click();
  const { cx, cy } = await box();
  await click(cx - 150, cy + 20);
  await click(cx + 150, cy + 20);
  const dlg = page.getByRole("dialog", { name: "Calibrate picture" });
  await dlg.waitFor();
  const d = parseFloat((await dlg.textContent()).match(/Currently ([\d.]+)/)[1]);
  await dlg.getByRole("button", { name: "Ruler 100 mm" }).click();
  await page.screenshot({ path: `${out}/04a-dialog.png` });
  await dlg.getByRole("button", { name: "Scale picture" }).click();
  await page.waitForTimeout(200);
  const after = (await sketch()).image.width;
  expect(Math.abs(after - (before * 100) / d) < 0.05 * after, "scaled to the typed distance", { before, after, d });
});

await step("05-flatten", async () => {
  const src = (await sketch()).image.src;
  await page.getByRole("button", { name: "Flatten photo", exact: true }).click();
  const { cx, cy } = await box();
  for (const [x, y] of [[-120, -150], [140, -130], [170, 90], [-150, 80]]) await click(cx + x, cy + y);
  await page.screenshot({ path: `${out}/05a-corners.png` });
  const dlg = page.getByRole("dialog", { name: "Flatten photo" });
  await dlg.waitFor();
  await dlg.getByRole("button", { name: "A4 paper" }).click();
  await dlg.getByRole("button", { name: "Flatten", exact: true }).click();
  await page.waitForFunction((old) => window.whittle.useApp.getState().doc.features.find((f) => f.type === "sketch").image.src !== old, src, { timeout: 30000 });
  const im = (await sketch()).image;
  // The sheet plus a quarter of its long side on every side.
  expect(Math.abs(im.width - 358.5) < 0.01 || Math.abs(im.width - 445.5) < 0.01, "flattened to A4 plus margin", im.width);
});

await step("06-extrude-traced", async () => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await waitBuilt();
  await page.keyboard.press("e");
  await waitBuilt();
  await page.keyboard.press("Enter");
  await waitBuilt();
  const st = await page.evaluate(() => {
    const s = window.whittle.useApp.getState();
    const ex = s.doc.features.find((f) => f.type === "extrude");
    return s.regen.status.find((x) => x.id === ex.id);
  });
  expect(st.state === "ok", "traced shapes extrude", st);
});

if (errors.length) {
  console.error("console errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
await browser.close();
