/** Browser and viewport regression for construction datum gestures and visibility. */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("whittle.debug", "1");
    // Use an in-memory file handle in place of the OS picker.
    let file;
    const handle = {
      name: "datum-regression.whittle",
      createWritable: async () => ({
        write: async (bytes) => { file = new File([bytes], handle.name); },
        close: async () => {},
      }),
      getFile: async () => file,
    };
    window.showSaveFilePicker = async () => handle;
    window.showOpenFilePicker = async () => [handle];
  });
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
  const step = (name) => page.locator(".timeline").getByRole("button", { name, exact: true });
  const icon = (button) => button.locator("svg").innerHTML();
  const datumIcons = new Set();
  const screen = (world) => page.evaluate((world) => {
    const vp = window.whittle.viewportRef.current;
    const [x, y] = vp.worldToScreen(world);
    const bounds = document.querySelector(".viewport canvas").getBoundingClientRect();
    return [bounds.left + x * bounds.width / vp.size.x, bounds.top + y * bounds.height / vp.size.y];
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
    assert.equal(await step(datum.name).getAttribute("aria-pressed"), "true", "Viewport pick selects the timeline step");
    await page.evaluate(() => window.whittle.useApp.setState({ selection: [] }));
    await step(datum.name).click();
    await page.mouse.move(3, 3);
    assert.equal(await row(datum.name).getAttribute("aria-pressed"), "true", "Timeline click selects the Browser row");
    assert.notEqual(await opacity(), unselected, "Timeline selection highlights the datum after the pointer leaves");
    const glyph = await icon(step(datum.name));
    assert.equal(glyph, await icon(row(datum.name)), "Timeline and Browser share a datum icon");
    datumIcons.add(glyph);
  }

  await row("Fixture plane").dblclick();
  assert.equal(await page.evaluate(() => window.whittle.useApp.getState().session?.featureId), "test-plane");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await waitBuilt();
  await row("Edit Fixture plane").focus();
  await row("Edit Fixture plane").click();
  assert.equal(await page.evaluate(() => window.whittle.useApp.getState().session?.featureId), "test-plane");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await waitBuilt();

  await page.mouse.dblclick(...await screen(worlds[2]));
  assert.equal(await page.evaluate(() => window.whittle.useApp.getState().session?.featureId), "test-point");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
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
  await page.getByRole("button", { name: "Finish sketch", exact: true }).click();
  await waitBuilt();
  await page.evaluate(() => window.whittle.viewportRef.current.viewTo("home"));
  await page.waitForFunction(() => !window.whittle.viewportRef.current.anim);
  console.log("ok  datum selection, highlighting, edit gestures, and hierarchical visibility");

  const run = async (id, inputId) => {
    await page.evaluate((id) => {
      const command = window.whittle.commands.find((command) => command.id === id);
      if (!command.when(window.whittle.useApp.getState())) throw new Error(`Construction command ${id} is disabled`);
      command.run();
    }, id);
    await waitBuilt();
    await page.waitForFunction((inputId) => window.whittle.viewportRef.current.filter.datumInputs?.has(inputId), inputId);
  };
  const active = () => page.evaluate(() => {
    const { doc, session } = window.whittle.useApp.getState();
    return doc.features.find((feature) => feature.id === session?.featureId);
  });
  const finish = async () => {
    await waitBuilt();
    await page.getByRole("button", { name: "OK", exact: true }).click();
    await waitBuilt();
    assert.equal(await active(), undefined);
  };
  const clickDatumOutline = async (id, clicks = 1) => {
    const segments = await page.evaluate((id) => window.whittle.viewportRef.current.datums.get(id).segments, id);
    for (const [start, end] of segments) {
      const [x, y] = await screen(start.map((value, i) => (value + end[i]) / 2));
      const pick = await page.evaluate(([clientX, clientY]) => window.whittle.viewportRef.current.pick({ clientX, clientY }), [x, y]);
      if (pick?.id === id) {
        await page.mouse.click(x, y, { clickCount: clicks });
        return;
      }
    }
    assert.fail(`No pickable outline for datum ${id}`);
  };

  await page.evaluate(() => {
    const { useApp } = window.whittle;
    const side = { id: "test-yz", name: "Side plane", type: "cplane", plane: { kind: "origin", plane: "YZ", offset: "8" } };
    useApp.setState(({ doc }) => ({ doc: { ...doc, features: [...doc.features, side] } }));
  });
  await waitBuilt();
  await run("construct-axis2pl", "test-yz");
  await row("Fixture axis").click();
  assert.equal((await active()).refs, undefined, "Wrong-kind Browser pick is ignored");
  await row("Fixture plane").click();
  await clickDatumOutline("test-yz");
  const intersectionAxis = await active();
  assert.deepEqual(intersectionAxis.refs.planes, [{ kind: "plane", id: "test-plane" }, { kind: "plane", id: "test-yz" }]);
  assert.equal(await row("Side plane").getAttribute("aria-pressed"), "true");
  await finish();

  await run("construct-axis2p", "test-point");
  await row("Second point").click();
  await page.mouse.click(...await screen(worlds[2]));
  const pointAxis = await active();
  assert.deepEqual(pointAxis.refs.points, [{ kind: "point", id: "test-point-2" }, { kind: "point", id: "test-point" }]);
  await finish();

  await row("Edit Fixture plane").click();
  const offset = page.getByLabel("Offset", { exact: true });
  await offset.fill("6");
  await offset.press("Tab");
  await finish();
  const regenerated = await page.evaluate((id) => window.whittle.useApp.getState().regen.planes.find((frame) => frame.id === id), intersectionAxis.id);
  assert.ok(Math.abs(regenerated.origin[2] - 6) < 1e-6, "Changing the plane offset moves its dependent axis");
  console.log("ok  Browser and viewport construction picks persist and regenerate");

  const command = (id) => page.evaluate((id) => window.whittle.commands.find((c) => c.id === id).run(), id);
  await command("csys");
  const csys = await active();
  const originX = page.getByLabel("Origin X", { exact: true });
  await originX.fill("12");
  await originX.press("Tab");
  await waitBuilt();
  const frameFor = (id) => page.evaluate((id) => {
    const { regen } = window.whittle.useApp.getState();
    return [...regen.planes, ...regen.sketches].find((frame) => frame.id === id);
  }, id);
  assert.deepEqual((await frameFor(csys.id)).origin, [12, 0, 0]);
  await page.getByRole("radio", { name: "From datums", exact: true }).click();
  await page.getByRole("button", { name: "Pick Origin", exact: true }).click();
  await row("Fixture axis").click();
  assert.equal((await active()).refs.origin, undefined, "Wrong-kind pick is rejected in the CSYS editor");
  await row("Second point").click();
  await page.getByRole("button", { name: "Pick Z direction", exact: true }).click();
  await page.waitForFunction((id) => window.whittle.viewportRef.current.filter.datumInputs?.has(id), intersectionAxis.id);
  await clickDatumOutline(intersectionAxis.id);
  await page.getByRole("button", { name: "Pick X direction", exact: true }).click();
  await step(pointAxis.name).click();
  assert.deepEqual((await active()).refs, {
    origin: { kind: "point", id: "test-point-2" },
    z: { kind: "axis", id: intersectionAxis.id },
    x: { kind: "axis", id: pointAxis.id },
  });
  await finish();

  const color = () => page.evaluate((id) => window.whittle.viewportRef.current.datums.get(id).materials[0].color.getHex(), csys.id);
  await page.mouse.move(3, 3);
  const initial = await color();
  await row(csys.name).click();
  assert.notEqual(await color(), initial, "CSYS Browser selection highlights its triad");
  await page.evaluate(() => window.whittle.useApp.setState({ selection: [] }));
  await clickDatumOutline(csys.id);
  assert.equal(await row(csys.name).getAttribute("aria-pressed"), "true", "Viewport triad selects its Browser row");
  assert.equal(await step(csys.name).getAttribute("aria-pressed"), "true", "Triad picks select the timeline step");
  const csysIcon = await icon(step(csys.name));
  assert.equal(csysIcon, await icon(row(csys.name)));
  datumIcons.add(csysIcon);
  assert.equal(datumIcons.size, 4, "Planes, axes, points and CSYS have distinct icons");
  await step(csys.name).dblclick();
  assert.equal((await active()).id, csys.id, "Double-clicking the timeline step edits the CSYS");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await waitBuilt();

  await clickDatumOutline(csys.id, 2);
  assert.equal((await active()).id, csys.id, "Double-clicking the triad edits the CSYS");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await waitBuilt();

  const visible = () => page.evaluate((id) => window.whittle.viewportRef.current.datums.has(id), csys.id);
  await row(`Hide ${csys.name}`).click();
  assert.equal(await visible(), false);
  await row("Hide all datum coordinate systems").click();
  await row(`Show ${csys.name}`).click();
  assert.equal(await visible(), false, "Category visibility overrides the item setting");
  await row("Show all datum coordinate systems").click();
  assert.equal(await visible(), true);

  await step(csys.name).click();
  await page.keyboard.press("s");
  await page.getByRole("button", { name: "YZ", exact: true }).click();
  const sketch = await active();
  assert.deepEqual(sketch.plane, { kind: "csys", csys: csys.id, plane: "YZ", offset: "0" });
  await waitBuilt();
  await page.waitForFunction(() => !window.whittle.viewportRef.current.anim);
  const canvas = await page.locator(".viewport canvas").boundingBox();
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;
  await command("tool-rect");
  await page.mouse.click(cx - 50, cy - 30);
  await page.mouse.click(cx + 50, cy + 30);
  await waitBuilt();
  assert.ok((await active()).geometry.length > 0, "A profile can be drawn on the CSYS plane");
  await page.getByRole("button", { name: "Finish sketch", exact: true }).click();
  await waitBuilt();
  await command("save");
  await page.waitForFunction(() => window.whittle.useApp.getState().fileName === "datum-regression.whittle" && !window.whittle.useApp.getState().dirty);
  const beforeOpen = await frameFor(csys.id);
  await command("open");
  await page.getByText("Opened datum-regression.whittle", { exact: true }).waitFor();
  await waitBuilt();
  assert.deepEqual(await frameFor(csys.id), beforeOpen);
  assert.deepEqual((await frameFor(sketch.id)).origin, beforeOpen.origin);
  console.log("ok  CSYS creation, reference picking, triad selection, visibility, principal plane sketch, and save/reopen");
} finally {
  await browser.close();
}
