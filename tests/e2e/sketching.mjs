/**
 * End-to-end test of the sketch editing tools: offset, mirror, patterns, the
 * Dimension tool and Project (copying model edges into a sketch).
 *   node tests/e2e/sketching.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/sketching";
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
const api = (name, input) => page.evaluate(([n, i]) => window.whittle.api.run(n, i), [name, input]);
const state = (fn, arg) => page.evaluate(fn, arg);
const expect = (cond, msg, detail) => {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(detail)}`);
};
const sketchInfo = () =>
  state(() => {
    const s = window.whittle.useApp.getState();
    const sk = s.doc.features.filter((f) => f.type === "sketch").at(-1);
    const sol = s.regen?.sketches.find((x) => x.id === sk.id)?.solution;
    return { id: sk.id, entities: sk.entities, geometry: sk.geometry ?? [], constraints: sk.constraints ?? [], sol };
  });
const count = (sk, type) => sk.geometry.filter((g) => g.type === type).length;
const setTool = (tool) => state((t) => window.whittle.useApp.setState((s) => ({ mode: { ...s.mode, tool: t } })), tool);
const select = (ids) => state((i) => window.whittle.useApp.setState({ sketchSel: i, selectedEntity: null }), ids);
const geomIds = (sk) => sk.geometry.filter((g) => g.type !== "point").map((g) => g.id);

let box;
const at = (x, y) => [box.x + box.width / 2 + x, box.y + box.height / 2 + y];
const click = async (x, y) => {
  const [px, py] = at(x, y);
  await page.mouse.move(px, py, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);
};
const fillDialog = async (title, value) => {
  const dlg = page.getByRole("dialog", { name: title });
  await dlg.waitFor();
  await dlg.locator("input").first().fill(value);
  await dlg.locator("input").first().press("Enter");
};

await step("01-start", async () => {
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1")); // the test hook is off unless asked for
  await page.goto(url);
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  await page.getByRole("button", { name: /Engineer & professional/ }).click();
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).getByRole("button", { name: /New design/ }).first().click();
  await waitBuilt();
  const b = await api("add_feature", { type: "primitive", name: "Block", settings: { shape: "box", width: 40, depth: 40, height: 10, position: [0, 0, 0] } });
  expect(b.ok !== false, "box added", b);
  await waitBuilt();
  await page.keyboard.press("s");
  await page.locator(".tree__row", { hasText: "XY plane" }).click();
  await page.waitForTimeout(900);
  box = await page.locator(".viewport").boundingBox();
});

await step("02-project-a-face", async () => {
  await setTool("project");
  await click(0, 0);
  await waitBuilt();
  const sk = await sketchInfo();
  expect(count(sk, "line") >= 4, "the face's edges were projected", sk.geometry.length);
  expect(sk.constraints.filter((c) => c.type === "fixed").length >= 4, "projected geometry is locked", sk.constraints);
  expect(sk.sol && sk.sol.state !== "over" && sk.sol.state !== "error", "solves", sk.sol);
});

await step("03-draw-and-offset", async () => {
  await setTool("rect");
  await click(-300, 150);
  await click(-220, 200);
  await waitBuilt();
  let sk = await sketchInfo();
  const before = count(sk, "line");
  const fresh = geomIds(sk).slice(-4);
  await setTool("select");
  await select(fresh);
  await page.getByRole("button", { name: /^Offset/ }).first().click();
  await fillDialog("Offset", "4");
  await waitBuilt();
  sk = await sketchInfo();
  expect(count(sk, "line") === before + 4, "offset made four lines", count(sk, "line"));
  expect(sk.constraints.filter((c) => c.type === "parallel").length === 4, "parallel to their originals", sk.constraints);
});

await step("04-mirror-and-pattern", async () => {
  let sk = await sketchInfo();
  const mine = geomIds(sk).slice(-8, -4);
  await select(mine);
  const before = count(sk, "line");
  await page.getByRole("button", { name: /Mirror ↕/ }).first().click();
  await waitBuilt();
  sk = await sketchInfo();
  expect(count(sk, "line") === before + 4, "mirrored copy", count(sk, "line"));
  expect(sk.constraints.some((c) => c.type === "symmetric"), "held symmetric", sk.constraints);
  await select(mine);
  await page.getByRole("button", { name: /Row →/ }).first().click();
  await waitBuilt();
  sk = await sketchInfo();
  expect(count(sk, "line") > before + 4, "row pattern added copies", count(sk, "line"));
});

await step("05-dimension-tool", async () => {
  const sk0 = await sketchInfo();
  const target = sk0.geometry.filter((g) => g.type === "line").at(-1);
  await select([]);
  await state(() => window.whittle.useApp.getState().sketchSel);
  await setTool("dimension");
  // The tool is wired to the same code path as the buttons: a click on a line asks for its length.
  const pos = await state(([id]) => {
    const s = window.whittle.useApp.getState();
    const sk = s.doc.features.filter((f) => f.type === "sketch").at(-1);
    const sol = s.regen.sketches.find((x) => x.id === sk.id).solution;
    const l = sk.geometry.find((g) => g.id === id);
    const p = (pid) => sol?.points[pid] ?? [sk.geometry.find((g) => g.id === pid).x, sk.geometry.find((g) => g.id === pid).y];
    return [p(l.a), p(l.b)];
  }, [target.id]);
  expect(pos.length === 2, "line found", pos);
  // Drive the picker through the store (screen mapping is covered by the other scripts).
  await state(([id]) => void window.whittle.dimensionPick(id, false), [target.id]);
  const dialog = page.getByRole("dialog", { name: "Distance" });
  await fillDialog("Distance", "12");
  await waitBuilt();
  const sk = await sketchInfo();
  expect(sk.constraints.some((c) => c.type === "distance" && c.value === "12"), "length dimension added", sk.constraints);
  expect(await dialog.count() === 0, "dialog closed", {});
});

if (errors.length) {
  console.error("console errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
await browser.close();
