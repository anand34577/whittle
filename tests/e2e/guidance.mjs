/**
 * End-to-end test of drawing guidance: lines that line up (perpendicular, parallel) keep that relation,
 * and shapes started on a point, a curve or a crossing stay joined to it.
 *   node tests/e2e/guidance.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/guidance";
mkdirSync(out, { recursive: true });

const channel = process.env.BROWSER_CHANNEL ?? "msedge";
const browser = await chromium.launch({ channel, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
  } catch (e) {
    await page.screenshot({ path: `${out}/${name}-FAILED.png` });
    throw e;
  }
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`ok  ${name} (${Date.now() - t} ms)`);
};
const waitBuilt = async () => {
  await page.waitForFunction(() => /Built in|Ready/.test(document.querySelector(".statusbar__meta")?.textContent ?? "") && window.whittle.useApp.getState().builtDoc === window.whittle.useApp.getState().doc, null, { timeout: 60000 });
  await page.waitForTimeout(300);
};
const state = (fn, arg) => page.evaluate(fn, arg);
const expect = (cond, msg, detail) => {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(detail)}`);
};
const sketchInfo = () =>
  state(() => {
    const s = window.whittle.useApp.getState();
    const sk = s.doc.features.filter((f) => f.type === "sketch").at(-1);
    const sol = s.regen?.sketches.find((x) => x.id === sk.id)?.solution;
    return { geometry: sk.geometry ?? [], constraints: sk.constraints ?? [], sol };
  });
const setTool = (tool) => state((t) => window.whittle.useApp.setState((s) => ({ mode: { ...s.mode, tool: t } })), tool);
const of = (sk, type) => sk.constraints.filter((c) => c.type === type);
const kind = (sk, id) => (id === "origin" ? "origin" : sk.geometry.find((g) => g.id === id)?.type);
const solves = (sk) => expect(sk.sol && !["over", "error"].includes(sk.sol.state), "the sketch solves", sk.sol);

let box;
const at = (x, y) => [box.x + box.width / 2 + x, box.y + box.height / 2 + y];
const click = async (x, y) => {
  const [px, py] = at(x, y);
  await page.mouse.move(px, py, { steps: 4 });
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);
};
/** Alt places a point exactly where clicked (no snapping), so the test knows where it is. */
const freeClick = async (x, y) => {
  await page.keyboard.down("Alt");
  await click(x, y);
  await page.keyboard.up("Alt");
};
const hover = async (x, y) => {
  const [px, py] = at(x, y);
  await page.mouse.move(px, py, { steps: 4 });
  await page.waitForTimeout(80);
};
const badge = () => page.locator(".snap-badge").first().textContent({ timeout: 2000 }).catch(() => "");

await step("01-start", async () => {
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1"));
  await page.goto(url);
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  await page.getByRole("button", { name: /Engineer & professional/ }).click();
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).getByRole("button", { name: /New design/ }).first().click();
  await waitBuilt();
  await page.keyboard.press("s");
  await page.locator(".tree__row", { hasText: "XY plane" }).click();
  await page.waitForTimeout(900);
  box = await page.locator(".viewport").boundingBox();
});

await step("02-perpendicular-line", async () => {
  await setTool("polyline");
  await freeClick(-260, 60);
  await freeClick(-160, -40);
  // Roughly at right angles to the first line, a few pixels off: the guide straightens it.
  await hover(-82, 41);
  const hint = await badge();
  expect(/Perpendicular/.test(hint), "the badge says perpendicular", hint);
  await click(-82, 41);
  await page.keyboard.press("Escape");
  await waitBuilt();
  const sk = await sketchInfo();
  expect(sk.geometry.filter((g) => g.type === "line").length === 2, "two lines", sk.geometry);
  expect(of(sk, "perpendicular").length === 1, "kept perpendicular", sk.constraints);
  solves(sk);
});

await step("03-rectangle-on-an-end-point", async () => {
  await setTool("rect");
  await click(-82, 41);
  await click(-20, 100);
  await waitBuilt();
  const sk = await sketchInfo();
  const joined = of(sk, "coincident").filter((c) => c.refs.every((r) => kind(sk, r) === "point"));
  expect(joined.length >= 1, "the corner is joined to the line's end", sk.constraints);
  solves(sk);
});

await step("04-line-from-a-curve", async () => {
  await setTool("polyline");
  // A point along the first line (not its middle): the new line starts on it.
  await click(-235, 35);
  await click(-235, 160);
  await page.keyboard.press("Escape");
  await waitBuilt();
  const sk = await sketchInfo();
  const onLine = of(sk, "coincident").filter((c) => c.refs.some((r) => kind(sk, r) === "line"));
  expect(onLine.length >= 1, "the start stays on the line", sk.constraints);
  solves(sk);
});

await step("05-circle-at-a-crossing", async () => {
  // Two lines crossing away from their middles, at (166.7, -103.3) on screen.
  await setTool("segment");
  await freeClick(100, -150);
  await freeClick(300, -10);
  await page.keyboard.press("Escape");
  await freeClick(100, -10);
  await freeClick(200, -150);
  await page.keyboard.press("Escape");
  await waitBuilt();
  await setTool("circle");
  await hover(168, -102);
  const hint = await badge();
  expect(/Intersection/.test(hint), "the badge says intersection", hint);
  await click(168, -102);
  await freeClick(192, -102);
  await waitBuilt();
  const sk = await sketchInfo();
  const circle = sk.geometry.find((g) => g.type === "circle");
  expect(circle, "a circle", sk.geometry);
  const onCenter = of(sk, "coincident").filter((c) => c.refs[0] === circle.c && kind(sk, c.refs[1]) === "line");
  expect(onCenter.length === 2, "its center is held on both lines", sk.constraints);
  solves(sk);
});

await step("06-line-from-a-midpoint", async () => {
  // The middle of the first crossing line (100,-150)-(300,-10) is at (200,-80).
  await setTool("segment");
  await hover(201, -79);
  const hint = await badge();
  expect(/Midpoint/.test(hint), "the badge says midpoint", hint);
  await click(201, -79);
  await freeClick(260, -200);
  await page.keyboard.press("Escape");
  await waitBuilt();
  const sk = await sketchInfo();
  expect(of(sk, "midpoint").length === 1, "the line starts at the middle and stays there", sk.constraints);
  solves(sk);
});

await step("07-no-redundant-relations", async () => {
  // A level line, then a second line between its two ends: Horizontal on the second is implied, so it's not kept.
  await setTool("segment");
  await freeClick(-320, 220);
  await freeClick(-180, 220);
  await page.keyboard.press("Escape");
  await waitBuilt();
  await click(-320, 220);
  await click(-180, 220);
  await page.keyboard.press("Escape");
  await waitBuilt();
  await page.waitForTimeout(600);
  await waitBuilt();
  const sk = await sketchInfo();
  expect(sk.sol.state !== "over", "no red constraints after drawing", sk.sol);
  solves(sk);
  // One undo takes the whole second line away (the tidy-up is part of the same step).
  const lines = sk.geometry.filter((g) => g.type === "line").length;
  await page.keyboard.press("Control+z");
  await waitBuilt();
  const back = await sketchInfo();
  expect(back.geometry.filter((g) => g.type === "line").length === lines - 1, "one undo removes the line", back.geometry.length);
});

console.log(errors.length ? `console errors:\n${errors.join("\n")}` : "no console errors");
await browser.close();
if (errors.length) process.exit(1);
