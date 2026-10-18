/**
 * End-to-end test of drawing previews: lines that line up (perpendicular, parallel) keep that relation,
 * shows the result with that edge added, without changing the design until it is clicked.
 *   node tests/e2e/previews.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/previews";
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
const api = (name, input) => page.evaluate(([n, i]) => window.whittle.api.run(n, i), [name, input]);
const runCommand = (id) => page.evaluate((id) => window.whittle.commands.find((c) => c.id === id).run(window.whittle.useApp.getState()), id);
const volume = () => state(() => window.whittle.useApp.getState().regen.bodies.reduce((a, b) => a + b.volume, 0));
const filletEdges = () => state(() => {
  const s = window.whittle.useApp.getState();
  return s.doc.features.find((f) => f.id === s.session?.featureId)?.edges.length ?? -1;
});
const settle = async () => {
  await page.waitForTimeout(500);
  await page.waitForFunction(() => !window.whittle.useApp.getState().regenBusy, null, { timeout: 60000 });
};

await step("01-start", async () => {
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1"));
  await page.goto(url);
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  await page.getByRole("button", { name: /Engineer & professional/ }).click();
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).getByRole("button", { name: /New design/ }).first().click();
  await waitBuilt();
  await api("add_feature", { type: "primitive", settings: { shape: "box", width: 40, depth: 30, height: 20 } });
  await waitBuilt();
});

let plain = 0;
await step("02-fillet-hover-previews", async () => {
  plain = await volume();
  await runCommand("fillet");
  await settle();
  expect((await filletEdges()) === 0, "the fillet starts with no edges", await filletEdges());
  const body = await state(() => window.whittle.useApp.getState().regen.pickBodies?.[0]?.id ?? window.whittle.useApp.getState().regen.bodies[0].id);
  // Rest the pointer on an edge (what moving the mouse over it does).
  await page.evaluate((bodyId) => window.whittle.useApp.setState({ hover: { kind: "edge", bodyId, index: 0 } }), body);
  await settle();
  await page.waitForFunction(() => window.whittle.useApp.getState().hoverEdges?.length > 0, null, { timeout: 5000 });
  await settle();
  const previewed = await volume();
  expect(previewed < plain - 1e-3, "the model shows the edge rounded", { plain, previewed });
  expect((await filletEdges()) === 0, "but nothing is picked yet", await filletEdges());
});

await step("03-moving-off-restores", async () => {
  await page.evaluate(() => window.whittle.useApp.setState({ hover: null }));
  await settle();
  const back = await volume();
  expect(Math.abs(back - plain) < 1e-6, "back to the plain block", { back, plain });
  await page.keyboard.press("Escape");
  await settle();
  expect((await state(() => window.whittle.useApp.getState().hoverEdges)) === null, "no preview left after the tool closes", "");
});

await step("04-real-pointer", async () => {
  // Sweep the mouse across the box's left upright edge with the fillet open: resting on it previews it.
  await runCommand("fillet");
  await settle();
  let seen = false;
  for (let x = 375; x <= 440 && !seen; x += 3) {
    await page.mouse.move(x, 450);
    await page.waitForTimeout(350);
    seen = (await state(() => window.whittle.useApp.getState().hoverEdges?.length ?? 0)) > 0;
  }
  expect(seen, "an edge under the pointer is previewed", "");
  await settle();
  expect((await volume()) < plain - 1e-3, "and the view shows it rounded", await volume());
  await page.mouse.move(700, 700);
  await page.keyboard.press("Escape");
  await settle();
});

console.log(errors.length ? `console errors:\n${errors.join("\n")}` : "no console errors");
await browser.close();
if (errors.length) process.exit(1);
