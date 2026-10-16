/** Inspect commands that ask the kernel about the solids (interference, tight corners) and body organisation. */
import { LENGTH_TO_MM, type Id, documentEvaluator, formatQuantity } from "@whittle/core";
import { matchFace } from "./actions";
import { promptDialog } from "./dialogs";
import { getKernel } from "./kernel";
import { withTask } from "./tasks";
import { mutate, toast, useApp } from "./store";

export async function runInterference() {
  const { doc } = useApp.getState();
  try {
    const r = await withTask("Checking for overlaps…", () => getKernel().inspect(doc, "interference"));
    if (r.kind !== "interference") return;
    useApp.setState({ interference: r.items });
    if (!r.items.length) return toast("ok", "No bodies overlap.");
    const name = (id: Id) => doc.bodies[id]?.name ?? "Body";
    const first = r.items[0]!;
    toast("warn", `${r.items.length} overlap${r.items.length > 1 ? "s" : ""}: ${name(first.a)} and ${name(first.b)} share ${formatQuantity(first.volume, "number", doc.units).replace(/\s*$/, "")} mm\u00b3${r.items.length > 1 ? " (and more)" : ""}. Red boxes mark them; run Interference again to refresh.`);
  } catch (e) {
    toast("warn", "The check couldn't run: " + (e instanceof Error ? e.message : String(e)));
  }
}

/** Ask OpenCascade whether every body is a valid solid (rebuilds only warn when a result looks broken). */
export async function runGeometryCheck() {
  const { doc } = useApp.getState();
  try {
    const r = await withTask("Checking the geometry…", () => getKernel().inspect(doc, "validity"));
    if (r.kind !== "validity") return;
    if (!r.items.length) return toast("info", "There are no bodies to check.");
    const bad = r.items.filter((i) => !i.valid);
    if (!bad.length) return toast("ok", `All ${r.items.length} bod${r.items.length > 1 ? "ies are" : "y is"} valid.`);
    const names = bad.map((i) => doc.bodies[i.bodyId]?.name ?? "Body").join(", ");
    useApp.setState({ selection: bad.map((i) => ({ kind: "body" as const, bodyId: i.bodyId })) });
    toast("warn", `Not a valid solid: ${names} (selected). Booleans, fillets and export may misbehave; undo the last steps or simplify the sketch behind it.`);
  } catch (e) {
    toast("warn", "The check couldn't run: " + (e instanceof Error ? e.message : String(e)));
  }
}

export function clearInterference() {
  useApp.setState({ interference: [] });
}

/** Select the inside round faces a cutter of this diameter can't reach into. */
export async function runMinRadius() {
  const { doc } = useApp.getState();
  const unit = doc.units;
  const v = await promptDialog({
    title: "Minimum radius",
    label: "Cutter diameter",
    message: "Inside rounded corners tighter than the cutter's radius can't be machined. They get selected.",
    initial: "6",
    unit,
    validate: (t) => {
      const r = documentEvaluator(doc).eval(t, "length");
      return !r.ok ? r.error : r.value <= 0 ? "Use a size greater than zero" : null;
    },
  });
  if (v === null) return;
  const cutter = documentEvaluator(doc).eval(v, "length");
  if (!cutter.ok) return;
  const r = await withTask("Measuring inside corners…", () => getKernel().inspect(doc, "radii"));
  if (r.kind !== "radii") return;
  const bodies = useApp.getState().regen?.bodies ?? [];
  const tight = r.items.filter((i) => i.concave && i.radius < cutter.value / 2 - 1e-6);
  const picks = tight.flatMap((i) => {
    const b = bodies.find((x) => x.id === i.bodyId);
    const idx = b ? matchFace(b.faces, { bodyId: i.bodyId, center: i.center, normal: i.normal, surface: "CYLINDRE", area: 0 }) : -1;
    return idx >= 0 ? [{ kind: "face" as const, bodyId: i.bodyId, index: idx }] : [];
  });
  useApp.setState({ selection: picks });
  if (!tight.length) toast("ok", `No inside corners are tighter than a ${formatQuantity(cutter.value, "length", unit)} cutter's radius.`);
  else toast("warn", `${tight.length} inside corner${tight.length > 1 ? "s are" : " is"} tighter than a ${formatQuantity(cutter.value, "length", unit)} cutter can reach (selected). Smallest radius: ${formatQuantity(Math.min(...tight.map((t) => t.radius)), "length", unit)}.`);
  void LENGTH_TO_MM;
}

const PALETTE = ["#6aa6e8", "#e8956a", "#7bc78a", "#d27fc9", "#e3c95f", "#6fd0d0", "#b58de8", "#e87a7a"];

/** Give each component (or each body without one) its own color. */
export function colorByComponent() {
  const { doc } = useApp.getState();
  const keys = new Map<string, number>();
  mutate("Color by component", (d) => {
    for (const [id, m] of Object.entries(d.bodies)) {
      const key = m.component ?? id;
      if (!keys.has(key)) keys.set(key, keys.size);
      m.color = PALETTE[keys.get(key)! % PALETTE.length]!;
    }
  });
  void doc;
}

/** Put the selected bodies in one new component (they then move together under joints). */
export function makeComponent() {
  const { selection, doc } = useApp.getState();
  const ids = [...new Set(selection.flatMap((p) => (p.kind === "body" || p.kind === "face" || p.kind === "edge" ? [p.bodyId] : [])))];
  if (!ids.length) return toast("info", "Click the bodies for the component first (Shift+click to add more).");
  const used = new Set(Object.values(doc.bodies).map((m) => m.component));
  let n = 1;
  while (used.has(`Component ${n}`)) n++;
  const name = `Component ${n}`;
  mutate("Make component", (d) => void ids.forEach((id) => d.bodies[id] && (d.bodies[id]!.component = name)));
  toast("ok", `${ids.length} bod${ids.length > 1 ? "ies" : "y"} now in ${name}.`);
}

/** Ground or un-ground the selected bodies (a grounded body never moves under a joint). */
export function toggleGround() {
  const { selection, doc } = useApp.getState();
  const ids = [...new Set(selection.flatMap((p) => (p.kind === "body" || p.kind === "face" || p.kind === "edge" ? [p.bodyId] : [])))];
  if (!ids.length) return toast("info", "Click the body to ground first.");
  const on = !ids.every((id) => doc.bodies[id]?.grounded);
  mutate(on ? "Ground" : "Unground", (d) => void ids.forEach((id) => d.bodies[id] && (d.bodies[id]!.grounded = on || undefined)));
}
