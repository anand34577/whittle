/**
 * End-to-end regression test for the October 2026 audit fixes and additions:
 * Rib tool, cut direction on a face, shortcuts, tangent chains, feature patterns,
 * extrude-to-face, exploded view, variants and the 2D drawing export.
 *   node tests/e2e/audit.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/audit";
mkdirSync(out, { recursive: true });

const channel = process.env.BROWSER_CHANNEL ?? "msedge";
const browser = await chromium.launch({ channel, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
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
const expect = (cond, msg, detail) => {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(detail)}`);
};
const waitBuilt = async () => {
  await page.waitForFunction(() => window.whittle.useApp.getState().builtDoc === window.whittle.useApp.getState().doc && !window.whittle.useApp.getState().regenBusy, null, { timeout: 60000 });
  await page.waitForTimeout(250);
};
const api = (name, input) => page.evaluate(([n, i]) => window.whittle.api.run(n, i), [name, input]);
const state = () =>
  page.evaluate(() => {
    const s = window.whittle.useApp.getState();
    return {
      features: s.doc.features.map((f) => f.type),
      status: Object.fromEntries((s.regen?.status ?? []).map((x) => [x.id, x.state])),
      volume: (s.regen?.bodies ?? []).reduce((a, b) => a + b.volume, 0),
      bodies: s.regen?.bodies.length ?? 0,
    };
  });
const runCommand = (id) =>
  page.evaluate(async (id) => {
    window.whittle.commands.find((c) => c.id === id).run(window.whittle.useApp.getState());
  }, id);

await step("01-start", async () => {
  await page.goto(url);
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  await page.getByRole("button", { name: /Engineer & professional/ }).click();
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).getByRole("button", { name: /New design/ }).first().click();
  await waitBuilt();
  // Engineers get labelled tools too: icon-only toolbars are the steepest part of the learning curve.
  await page.locator(".toolbar").getByRole("button", { name: "Fillet" }).waitFor();
});

await step("02-rib-tool-opens", async () => {
  await api("add_feature", { type: "primitive", settings: { shape: "box", width: 60, depth: 40, height: 20 } });
  await api("add_sketch", { name: "Line", plane: "XZ", shapes: [{ type: "path", points: [[-20, 0], [20, 15]] }] });
  await waitBuilt();
  const before = errors.length;
  await runCommand("rib");
  await page.waitForTimeout(500);
  await page.getByText("Rib line").waitFor();
  expect(errors.length === before, "Rib editor rendered without errors", errors.slice(before));
  await page.keyboard.press("Escape");
});

await step("03-cut-on-face-goes-into-the-body", async () => {
  await page.evaluate(() => window.whittle.useApp.setState({ session: null, selection: [] }));
  await api("add_sketch", { name: "Pocket", on_body: "Body 1", face: "top", shapes: [{ type: "circle", x: 0, y: 0, radius: 6 }] });
  await waitBuilt();
  const v0 = (await state()).volume;
  await runCommand("extrude");
  await page.getByRole("radio", { name: "Cut" }).click();
  await waitBuilt();
  await page.getByRole("button", { name: /^OK$/ }).click();
  await waitBuilt();
  const v1 = (await state()).volume;
  expect(v0 - v1 > 1000, "the cut removed material", { v0, v1 });
});

await step("04-shortcuts", async () => {
  await page.evaluate(() => window.whittle.useApp.setState({ selection: [] }));
  await page.keyboard.press("q");
  await page.waitForTimeout(300);
  const f = await page.evaluate(() => window.whittle.useApp.getState().session?.featureId ?? null);
  expect(f, "Q starts Press/Pull", f);
  await page.keyboard.press("Escape");
});

await step("05-tangent-chain-and-face-preselect", async () => {
  await api("add_sketch", { name: "Rounded", plane: "XY", offset: 60, shapes: [{ type: "rect", x: 0, y: 0, width: 60, height: 40, corner_radius: 6 }] });
  await api("add_feature", { type: "extrude", settings: { sketch: "Rounded", distance: 20, op: "new" } });
  await waitBuilt();
  const res = await page.evaluate(async () => {
    const A = { handlePick: window.whittle.handlePick };
    const S = () => window.whittle.useApp.getState();
    const body = S().regen.bodies.find((b) => b.volume > 0 && b.bbox[0][2] > 55);
    const top = body.faces.findIndex((f) => f.normal[2] > 0.9);
    window.whittle.useApp.setState({ selection: [{ kind: "face", bodyId: body.id, index: top, at: body.faces[top].center }] });
    const cmd = window.whittle.commands.find((c) => c.id === "fillet");
    cmd.run(S());
    await new Promise((r) => setTimeout(r, 300));
    const fromFace = S().doc.features.filter((f) => f.type === "fillet").at(-1).edges.length;
    const id = S().session.featureId;
    window.whittle.useApp.setState({ doc: { ...S().doc, features: S().doc.features.map((f) => (f.id === id ? { ...f, edges: [] } : f)) } });
    await new Promise((r) => setTimeout(r, 200));
    const i = body.edges.findIndex((e) => e.curve === "LINE" && e.mid[2] > 79 && Math.abs(e.tangent[2]) < 0.1);
    A.handlePick({ kind: "edge", bodyId: body.id, index: i, at: body.edges[i].mid }, false);
    await new Promise((r) => setTimeout(r, 200));
    const chain = S().doc.features.find((f) => f.id === id).edges.length;
    return { fromFace, chain };
  });
  expect(res.fromFace === 8, "a selected face brings its edges into Fillet", res);
  expect(res.chain === 8, "one click takes the tangent chain", res);
  await page.keyboard.press("Escape");
});

await step("06-feature-pattern", async () => {
  await page.evaluate(() => window.whittle.useApp.setState({ session: null, selection: [] }));
  await api("add_feature", { type: "primitive", settings: { shape: "box", width: 100, depth: 100, height: 10, position: [300, 0, 0] } });
  await api("add_sketch", { name: "Post", plane: "XY", offset: 10, shapes: [{ type: "circle", x: 330, y: 0, radius: 5 }] });
  const post = await api("add_feature", { type: "extrude", settings: { sketch: "Post", distance: 10, op: "join" } });
  await waitBuilt();
  const v0 = (await state()).volume;
  const r = await api("add_feature", { type: "pattern", settings: { pattern: "circular", axis: "z", count: 3, angle: 360, features: [post.name] } });
  await waitBuilt();
  expect(r.status.state === "ok", "feature pattern built", r);
  const v1 = (await state()).volume;
  expect(Math.abs(v1 - v0 - 2 * Math.PI * 25 * 10) < 5, "two more posts, not two more plates", { v0, v1 });
});

await step("07-explode", async () => {
  await runCommand("explode");
  await page.getByRole("group", { name: "Exploded view" }).waitFor();
  await runCommand("explode");
});

await step("08-variants", async () => {
  await api("set_parameter", { name: "wall", value: 2 });
  await page.evaluate(() => window.whittle.useApp.setState({ panel: "params" }));
  await page.getByRole("group", { name: "Variants" }).waitFor();
  await page.getByRole("button", { name: /Save current as variant/ }).click();
  await page.getByPlaceholder("e.g. Large").fill("Thin");
  await page.keyboard.press("Enter");
  await api("set_parameter", { name: "wall", value: 5 });
  await page.getByRole("button", { name: "Thin", exact: true }).click();
  const wall = await page.evaluate(() => window.whittle.useApp.getState().doc.parameters.find((p) => p.name === "wall").expr);
  expect(wall === "2", "variant restores the value", wall);
  await page.keyboard.press("Escape");
});

await step("09-drawing-export", async () => {
  await page.evaluate(() => window.whittle.useApp.setState({ panel: "export" }));
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /2D drawing/ }).click()]);
  const path = `${out}/drawing.svg`;
  await dl.saveAs(path);
  const svg = readFileSync(path, "utf8");
  for (const w of ["FRONT", "TOP", "RIGHT", "ISOMETRIC", "SCALE"]) expect(svg.includes(w), `drawing has ${w}`, w);
  expect(!/NaN|Infinity/.test(svg), "drawing has no NaN", "");
});

expect(errors.length === 0, "no console errors or native dialogs", errors);

// Last, because it breaks the window on purpose: a crash while drawing must show the recovery screen, not a blank page.
await step("10-ui-crash-is-caught", async () => {
  await page.evaluate(() => {
    const s = window.whittle.useApp;
    s.setState({ doc: { ...s.getState().doc, features: [null] } });
  });
  await page.locator(".error-boundary").waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Save a copy" }).waitFor();
});
errors.length = 0; // the crash is expected to log errors
console.log("no console errors");
await browser.close();
