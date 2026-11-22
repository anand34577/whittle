/** Browser and viewport regression for construction datum gestures and visibility. */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1"));
  await page.goto(process.argv[2] ?? "http://localhost:5173/");
  const welcome = page.getByRole("dialog", { name: "Welcome to Whittle" });
  await welcome.getByRole("button", { name: /Engineer & professional/ }).click();
  await welcome.getByRole("button", { name: /New design/ }).first().click();

  const waitBuilt = () => page.waitForFunction(() => {
    const { doc, builtDoc, regen, regenBusy } = window.whittle.useApp.getState();
    return doc === builtDoc && regen && !regenBusy;
  });
  await waitBuilt();
  const datums = [
    { id: "test-plane", name: "Fixture plane", type: "cplane", plane: { kind: "origin", plane: "XY", offset: "0" } },
    { id: "test-axis", name: "Fixture axis", type: "construct", mode: "axis2p", faces: [], edges: [], points: [[0, 25, 10], [10, 25, 10]], value: "0" },
    { id: "test-point", name: "Fixture point", type: "construct", mode: "pointVertex", faces: [], edges: [], points: [[25, 0, 10]], value: "0" },
    { id: "test-point-2", name: "Second point", type: "construct", mode: "pointVertex", faces: [], edges: [], points: [[-25, 0, 10]], value: "0" },
  ];
  await page.evaluate((features) => {
    const { useApp } = window.whittle;
    useApp.setState(({ doc }) => ({ doc: { ...doc, features } }));
  }, datums);
  await waitBuilt();

  const tree = page.getByRole("navigation", { name: "Design browser" });
  const row = (name) => tree.getByRole("button", { name, exact: true });
  const screen = (world) => page.evaluate((world) => {
    const vp = window.whittle.viewportRef.current;
    const [x, y] = vp.worldToScreen(world);
    const bounds = document.querySelector(".viewport canvas").getBoundingClientRect();
    return [bounds.left + x, bounds.top + y];
  }, world);
  const worlds = [[0, 0, 0], [5, 25, 10], [25, 0, 10]];
  for (const [i, datum] of datums.slice(0, 3).entries()) {
    const opacity = () => page.evaluate((id) =>
      window.whittle.viewportRef.current.datums.get(id).materials[0].opacity, datum.id);
    const unselected = await opacity();
    await row(datum.name).click();
    assert.deepEqual(await page.evaluate(() => {
      const s = window.whittle.useApp.getState();
      return [s.doc.features.length, s.session, s.selection[0]?.id];
    }), [datums.length, null, datum.id], "Single click selects without starting an edit or a sketch");
    assert.notEqual(await opacity(), unselected, "Browser selection highlights the viewport datum");
    await page.evaluate(() => window.whittle.useApp.setState({ selection: [] }));
    await page.mouse.click(...await screen(worlds[i]));
    assert.equal(await row(datum.name).getAttribute("aria-pressed"), "true", "Viewport pick selects the Browser row");
  }

  await row("Fixture plane").dblclick();
  assert.equal(await page.evaluate(() => window.whittle.useApp.getState().session?.featureId), "test-plane");
  await page.keyboard.press("Escape");
  await waitBuilt();
  await row("Edit Fixture plane").focus();
  await row("Edit Fixture plane").click();
  assert.equal(await page.evaluate(() => window.whittle.useApp.getState().session?.featureId), "test-plane");
  await page.keyboard.press("Escape");
  await waitBuilt();

  await page.mouse.dblclick(...await screen(worlds[2]));
  assert.equal(await page.evaluate(() => window.whittle.useApp.getState().session?.featureId), "test-point");
  await page.keyboard.press("Escape");
  await waitBuilt();

  await row("Hide Fixture point").click();
  await row("Hide all datum points").click();
  await page.mouse.click(...await screen([-25, 0, 10]));
  assert.notEqual(await page.evaluate(() => window.whittle.useApp.getState().selection[0]?.id), "test-point-2", "Category hides visible members");
  await row("Show all datum points").click();
  await row("Show Fixture point").waitFor();
  await row("Hide Second point").waitFor();
  await page.mouse.click(...await screen(worlds[2]));
  assert.notEqual(await page.evaluate(() => window.whittle.useApp.getState().selection[0]?.id), "test-point", "Hidden point cannot be picked");
  await row("Show Fixture point").click();
  await page.mouse.click(...await screen(worlds[2]));
  assert.equal(await row("Fixture point").getAttribute("aria-pressed"), "true", "Showing the item restores picking");
  await row("Fixture plane").click();
  await page.keyboard.press("s");
  assert.deepEqual(await page.evaluate(() => {
    const s = window.whittle.useApp.getState();
    return s.doc.features.find((f) => f.id === s.session?.featureId)?.plane;
  }), { kind: "construction", plane: "test-plane", offset: "0" }, "Sketch command uses the selected plane");
  console.log("ok  datum selection, highlighting, edit gestures, and hierarchical visibility");
} finally {
  await browser.close();
}
