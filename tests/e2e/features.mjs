/**
 * End-to-end tour of the second-wave features in a headless browser:
 *   node tests/e2e/features.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/features";
mkdirSync(out, { recursive: true });

const channel = process.env.BROWSER_CHANNEL ?? "msedge";
const browser = await chromium.launch({ channel, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

const state = (fn, arg) => page.evaluate(fn, arg);
const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
  } catch (e) {
    await page.screenshot({ path: `${out}/${name}-FAIL.png` });
    console.log("FAIL", name, JSON.stringify(await state(() => { const s = window.whittle.useApp.getState(); return { mode: s.mode.kind, session: s.session?.label, bodies: s.regen?.bodies.length, toasts: s.toasts.map((t) => t.text), features: s.doc.features.map((f) => f.type) }; })));
    throw e;
  }
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`ok  ${name} (${Date.now() - t} ms)`);
};
const waitBuilt = async () => {
  await page.waitForTimeout(120);
  await page.waitForFunction(
    () => {
      const s = window.whittle.useApp.getState();
      const ids = new Set(s.regen?.status.map((x) => x.id));
      // The rebuild must be of the current document, not an earlier one still on screen.
      return s.kernelReady && !s.regenBusy && s.builtDoc === s.doc && s.doc.features.every((f) => ids.has(f.id));
    },
    null,
    { timeout: 60000 },
  );
  await page.waitForTimeout(300);
};
const statuses = () => state(() => window.whittle.useApp.getState().regen.status.map((s) => `${s.state}${s.message ? ": " + s.message : ""}`));
const expectOk = async (what) => {
  const st = await statuses();
  const bad = st.filter((s) => !s.startsWith("ok"));
  if (bad.length) throw new Error(`${what}: ${bad.join(" | ")}`);
};
const vp = async () => {
  const b = await page.locator(".viewport").boundingBox();
  return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
};

await step("01-parts-library", async () => {
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1")); // the test hook is off unless asked for
  await page.goto(url);
  await page.getByRole("dialog", { name: "Welcome to Whittle" }).waitFor();
  // First run asks how Whittle will be used; any answer leads to the start screen.
  await page.getByRole("button", { name: /Maker & hobbyist/ }).click();
  await waitBuilt();
  await page.locator(".start-card--primary").click();
  await page.keyboard.press("p");
  await page.getByRole("dialog", { name: "Parts library" }).waitFor();
  await page.waitForTimeout(300);
});

await step("02-gear-inserted", async () => {
  await page.locator(".part", { hasText: "Spur gear" }).click();
  await waitBuilt();
  await expectOk("gear");
  const n = await state(() => window.whittle.useApp.getState().regen.bodies.length);
  if (n !== 1) throw new Error("expected a gear body");
});

await step("03-vase-print-check", async () => {
  await page.keyboard.press("p");
  await page.locator(".part", { hasText: "Vase" }).click();
  await waitBuilt();
  await expectOk("vase");
  await page.locator(".dock__btn", { hasText: "Overhangs" }).click();
  await page.waitForTimeout(400);
});

await step("04-section", async () => {
  await page.locator(".dock__btn", { hasText: "Overhangs" }).click();
  await page.locator(".dock__btn", { hasText: "Section" }).click();
  await page.locator(".section-card").waitFor();
  await page.waitForTimeout(400);
});

await step("05-xray", async () => {
  await page.locator(".section-card").getByLabel("Close section view").click();
  await page.getByTitle(/^X-ray/).click();
  await page.waitForTimeout(400);
});

await step("06-sketch-new-tools", async () => {
  await page.getByTitle(/^Shaded with edges/).click();
  await page.keyboard.press("Control+k");
  await page.keyboard.type("new design");
  await page.keyboard.press("Enter");
  // Unsaved work: Whittle asks in its own dialog (never the browser's).
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" }).click();
  await page.waitForTimeout(300);
  await page.keyboard.press("s");
  await page.locator(".tree__row", { hasText: "XY plane" }).click();
  await page.waitForTimeout(900);
  const { cx, cy } = await vp();
  await page.keyboard.press("r");
  await page.mouse.click(cx - 220, cy - 140);
  await page.mouse.click(cx + 220, cy + 140);
  await page.keyboard.press("e");
  await page.mouse.click(cx - 120, cy);
  await page.mouse.click(cx - 60, cy + 40);
  await page.keyboard.press("g");
  await page.mouse.click(cx + 110, cy);
  await page.mouse.click(cx + 170, cy);
  await waitBuilt();
  const ents = await state(() => window.whittle.useApp.getState().doc.features.find((f) => f.type === "sketch").entities.map((e) => e.type));
  if (ents.join() !== "rect,ellipse,gear") throw new Error("entities: " + ents.join());
  await expectOk("sketch");
});

await step("07-text-tool", async () => {
  const { cx, cy } = await vp();
  await page.keyboard.press("t");
  await page.mouse.click(cx - 40, cy - 100);
  const input = page.locator(".panel .textfield");
  await input.waitFor();
  await input.fill("HELLO");
  await waitBuilt();
  await expectOk("text");
});

await step("08-arrange-copies", async () => {
  await state(() => {
    const s = window.whittle.useApp.getState();
    const sk = s.doc.features.find((f) => f.type === "sketch");
    window.whittle.useApp.setState({ selectedEntity: sk.entities[1].id });
  });
  await page.waitForTimeout(200);
  await page.locator(".shape-actions").getByRole("button", { name: "Duplicate", exact: true }).click();
  await page.locator(".shape-actions").getByRole("button", { name: /Mirror ↔/ }).click();
  await waitBuilt();
  const n = await state(() => window.whittle.useApp.getState().doc.features.find((f) => f.type === "sketch").entities.length);
  if (n !== 6) throw new Error("expected 6 shapes, got " + n);
});

await step("09-extrude", async () => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await waitBuilt();
  await page.keyboard.press("e");
  await waitBuilt();
  await page.keyboard.press("Enter");
  await waitBuilt();
  await expectOk("extrude");
  await page.keyboard.press("h");
  await page.waitForTimeout(600);
});

await step("10-holes", async () => {
  const top = await state(() => {
    const b = window.whittle.useApp.getState().regen.bodies[0];
    const i = b.faces.findIndex((f) => f.normal[2] > 0.99 && f.surface === "PLANE" && f.center[2] > 5);
    return { bodyId: b.id, index: i, c: b.faces[i].center };
  });
  await state((t) => window.whittle.useApp.setState({ selection: [{ kind: "face", bodyId: t.bodyId, index: t.index, at: [t.c[0] - 20, t.c[1] + 15, t.c[2]] }] }), top);
  await page.keyboard.press("d");
  await waitBuilt();
  await page.getByRole("radio", { name: "Counterbore" }).click();
  await waitBuilt();
  await expectOk("hole");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/10a-hole-panel.png` });
  await page.keyboard.press("Enter");
  await waitBuilt();
});

await step("11-measure", async () => {
  await page.keyboard.press("i");
  const t = await state(() => {
    const b = window.whittle.useApp.getState().regen.bodies[0];
    const top = b.faces.findIndex((f) => f.normal[2] > 0.99 && f.center[2] > 5);
    const bottom = b.faces.findIndex((f) => f.normal[2] < -0.99);
    return { id: b.id, top, bottom, tc: b.faces[top].center, bc: b.faces[bottom].center };
  });
  await state(
    (t) =>
      window.whittle.useApp.setState({
        measure: [
          { kind: "face", bodyId: t.id, index: t.top, at: t.tc },
          { kind: "face", bodyId: t.id, index: t.bottom, at: t.bc },
        ],
      }),
    t,
  );
  await page.locator(".measure-card").waitFor();
  const txt = await page.locator(".measure-card").innerText();
  if (!/10(\.0+)?\s*mm/.test(txt)) throw new Error("measure: " + txt);
});

await step("12-radial-menu", async () => {
  await page.keyboard.press("Escape");
  const { cx, cy } = await vp();
  await page.mouse.click(cx + 300, cy - 230, { button: "right" });
  await page.locator(".radial__item").first().waitFor();
  await page.waitForTimeout(300);
});

await step("13-box-and-combine", async () => {
  await page.locator(".radial__item", { hasText: "Box" }).click();
  await waitBuilt();
  await page.keyboard.press("Enter");
  await waitBuilt();
  await page.keyboard.press("j");
  await waitBuilt();
  await page.getByRole("radio", { name: "Cut" }).click();
  await page.locator(".checklist").getByRole("checkbox").first().click();
  await waitBuilt();
  await expectOk("combine");
  await page.keyboard.press("Enter");
  await waitBuilt();
});

await step("14-move-copy", async () => {
  await page.keyboard.press("m");
  await waitBuilt();
  await page.locator(".panel .field__input").first().fill("120");
  await page.getByText("Keep the original (make a copy)").click();
  await waitBuilt();
  await expectOk("move");
  await page.keyboard.press("Enter");
  await waitBuilt();
  await page.keyboard.press("Shift+H");
  await page.waitForTimeout(700);
  const n = await state(() => window.whittle.useApp.getState().regen.bodies.length);
  if (n !== 2) throw new Error("expected 2 bodies after copy, got " + n);
});

await step("15-paper-and-screenshot", async () => {
  await page.getByTitle("Light theme").click();
  const dl = page.waitForEvent("download");
  await page.getByTitle(/^Save image/).click();
  const d = await dl;
  await d.saveAs(`${out}/${d.suggestedFilename()}`);
  console.log("    downloaded", d.suggestedFilename());
});

await step("16-timeline-reorder", async () => {
  // A sketch can't move after the extrude that uses it...
  const order = () => state(() => window.whittle.useApp.getState().doc.features.map((f) => f.id));
  const before = await order();
  const iSketch = await state(() => window.whittle.useApp.getState().doc.features.findIndex((f) => f.type === "sketch"));
  await page.locator(".timeline .step").nth(iSketch).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move later" }).click();
  await page.getByText(/has to come after/).first().waitFor();
  if ((await order()).join() !== before.join()) throw new Error("a breaking move was applied");
  // ...but an independent step can move freely.
  const iFree = await state(() => {
    const d = window.whittle.useApp.getState().doc;
    return d.features.findIndex((f, i) => i > 0 && f.type === "primitive" && d.features[i - 1].type !== "sketch");
  });
  if (iFree > 0) {
    await page.locator(".timeline .step").nth(iFree).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move earlier" }).click();
    await waitBuilt();
    const after = await order();
    if (after[iFree - 1] !== before[iFree]) throw new Error("move earlier didn't apply");
  }
});

await step("17-svg-import", async () => {
  if (!(await page.getByTitle("Start a sketch on the XY plane").isVisible())) await page.getByRole("button", { name: "Origin" }).click();
  await page.getByTitle("Start a sketch on the XY plane").click();
  await waitBuilt();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60">
    <path d="M0 0 H100 V60 H0 Z M20 15 H40 V45 H20 Z" />
    <circle cx="70" cy="30" r="12" transform="translate(0 0)" />
  </svg>`;
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".toolbar").getByRole("button", { name: /Insert/ }).click();
  await page.getByRole("menuitem", { name: /Import SVG/ }).click();
  await (await chooser).setFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) });
  // The width is asked in Whittle's own dialog.
  const ask = page.getByRole("dialog", { name: "Import logo.svg" });
  await ask.getByRole("textbox").fill("50");
  await ask.getByRole("button", { name: "Import" }).click();
  await page.waitForFunction(() => {
    const s = window.whittle.useApp.getState();
    return s.mode.kind === "sketch" && s.doc.features.find((f) => f.id === s.mode.sketchId).entities.length === 3;
  });
  await waitBuilt();
  const r = await state(() => {
    const s = window.whittle.useApp.getState();
    const sk = s.regen.sketches.find((x) => x.id === s.mode.sketchId);
    return { status: s.regen.status.find((x) => x.id === s.mode.sketchId)?.state, fill: sk?.fill?.length ?? 0 };
  });
  if (r.status !== "ok" || r.fill === 0) throw new Error("imported SVG sketch didn't build: " + JSON.stringify(r));
});

await step("18-sketch-export-dxf", async () => {
  const dl = page.waitForEvent("download");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("export sketch as dxf");
  await page.keyboard.press("Enter");
  const d = await dl;
  const path = `${out}/${d.suggestedFilename()}`;
  await d.saveAs(path);
  const text = (await import("node:fs")).readFileSync(path, "utf8");
  // The SVG had an outline, a square hole and a circle: three closed outlines.
  const outlines = text.split("\n").filter((l) => l === "POLYLINE").length;
  if (outlines !== 3 || !text.trim().endsWith("EOF")) throw new Error(`bad DXF (${outlines} outlines)`);
  console.log("    downloaded", d.suggestedFilename());
  await page.getByRole("button", { name: /Finish sketch/ }).first().click();
  await waitBuilt();
});

console.log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "no console errors");
await browser.close();
if (errors.length) process.exit(1);
