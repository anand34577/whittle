/** Right-hand panel: the active feature's editor, the selected sketch shape, or an inspector. */
import { useState } from "react";
import type { Draft } from "immer";
import { BODY_COLORS, FEATURE_LABELS, LENGTH_TO_MM, type LengthUnit, type SketchEntity, type SketchFeature, formatQuantity, trim } from "@whittle/core";
import { areaText, volumeText } from "../state/measure";
import type { FeatureStatus } from "@whittle/kernel";
import { circularCopies, duplicateEntity, linearCopies, mirrorEntity, rotateEntity } from "../state/sketchOps";
import { LOOKS } from "../viewport/looks";
import {
  cancelSession,
  commitSession,
  deleteEntity,
  findFeature,
  finishSketch,
  mutate,
  setPrefs,
  sketchMutate,
  updateFeature,
  useApp,
} from "../state/store";
import { ExprInput, Segmented, Toggle } from "./ExprInput";
import { ColorPicker, Disclosure, NumberField, Select } from "./controls";
import { FeatureEditor } from "./FeatureEditors";
import { Icon, type IconName } from "./icons";

export const FEATURE_ICONS: Record<string, IconName> = {
  sketch: "sketch",
  extrude: "extrude",
  revolve: "revolve",
  fillet: "fillet",
  chamfer: "chamfer",
  shell: "shell",
  primitive: "box",
  mirror: "mirror",
  pattern: "pattern",
  hole: "hole",
  loft: "loft",
  move: "move",
  combine: "combine",
  import: "import",
  sweep: "sweep",
  coil: "coil",
  split: "split",
  offset: "offset",
  scale: "scale",
  draft: "draft",
};

const ENTITY_LABELS: Record<SketchEntity["type"], string> = {
  rect: "Rectangle",
  circle: "Circle",
  polygon: "Polygon",
  slot: "Slot",
  polyline: "Outline",
  ellipse: "Ellipse",
  text: "Text",
  gear: "Spur gear",
};

function ShapeActions() {
  const [count, setCount] = useState(6);
  const [gap, setGap] = useState(20);
  return (
    <div className="shape-actions">
      <h3 className="eyebrow">Arrange</h3>
      <div className="btnrow">
        <button className="btn btn--small" onClick={() => duplicateEntity()} title="Duplicate (Ctrl+D)">
          <Icon name="duplicate" size={15} /> Duplicate
        </button>
        <button className="btn btn--small" onClick={() => rotateEntity(90)} title="Rotate 90° (Shift+R)">
          <Icon name="rotate" size={15} /> Rotate 90°
        </button>
      </div>
      <div className="btnrow">
        <button className="btn btn--small" onClick={() => mirrorEntity("y")} title="Mirrored copy across the vertical axis">
          <Icon name="mirror" size={15} /> Mirror ↔
        </button>
        <button className="btn btn--small" onClick={() => mirrorEntity("x")} title="Mirrored copy across the horizontal axis">
          <Icon name="mirror" size={15} style={{ transform: "rotate(90deg)" }} /> Mirror ↕
        </button>
      </div>
      <div className="copyrow">
        <span>Copies</span>
        <NumberField value={count} min={2} max={100} onChange={setCount} ariaLabel="Number of copies" width={104} />
        <button className="btn btn--small" onClick={() => circularCopies(count)} title="Evenly around the sketch origin">
          Around origin
        </button>
      </div>
      <div className="copyrow">
        <span>Gap</span>
        <NumberField value={gap} step={1} onChange={setGap} ariaLabel="Gap between copies" width={104} />
        <button className="btn btn--small" onClick={() => linearCopies(count, gap, 0)} title="In a row along X">
          Row →
        </button>
        <button className="btn btn--small" onClick={() => linearCopies(count, 0, gap)} title="In a column along Y">
          ↑
        </button>
      </div>
    </div>
  );
}

function StatusNote({ status, featureId }: { status?: FeatureStatus; featureId: string }) {
  if (!status || (status.state !== "error" && status.state !== "warning") || !status.message) return null;
  const fix = status.fix;
  return (
    <div className={`note note--${status.state}`} role="status">
      <Icon name={status.state === "error" ? "error" : "warning"} size={16} />
      <div>
        <p>{status.message}</p>
        {fix && (
          <button
            className="btn btn--small"
            onClick={() =>
              updateFeature(featureId, fix.label, (d) => {
                (d as unknown as Record<string, string>)[fix.field] = fix.value;
              })
            }
          >
            {fix.label}
          </button>
        )}
      </div>
    </div>
  );
}

const PLAIN_NUM = /^\s*-?\d*\.?\d+\s*$/;

/** A circle is stored by radius but edited by diameter; `(d) / 2` round-trips to `d` so formulas don't grow on every edit. */
function diameterOf(r: string): string {
  if (PLAIN_NUM.test(r)) return trim(parseFloat(r) * 2, 4);
  const m = /^\((.*)\) \/ 2$/.exec(r);
  let depth = 0;
  const balanced = !!m && [...m[1]!].every((c) => (depth += c === "(" ? 1 : c === ")" ? -1 : 0) >= 0) && depth === 0;
  return balanced ? m![1]! : `2 * (${r})`;
}

function EntityEditor({ e }: { e: SketchEntity }) {
  const set = (label: string, recipe: (d: Draft<SketchEntity>) => void) =>
    sketchMutate(
      label,
      (s) => {
        const x = s.entities.find((y) => y.id === e.id);
        if (x) recipe(x);
      },
      e.id + label,
    );
  const L = (label: string, key: string, auto = false) => (
    <ExprInput
      key={key}
      label={label}
      kind="length"
      autoFocus={auto}
      value={(e as unknown as Record<string, string>)[key] ?? "0"}
      onChange={(v) => set(label, (d) => void ((d as unknown as Record<string, string>)[key] = v))}
    />
  );
  return (
    <div className="panel__section">
      <h3 className="eyebrow">{ENTITY_LABELS[e.type]}</h3>
      {e.type === "text" && (
        <>
          <label className="field">
            <span className="field__label">Text</span>
            <input
              className="textfield"
              autoFocus
              value={e.text}
              onChange={(ev) => set("Text", (d) => void ((d as typeof e).text = ev.target.value))}
              onKeyDown={(ev) => ev.stopPropagation()}
            />
          </label>
          <div className="field-row">
            {L("Size", "size")}
            <ExprInput label="Rotation" kind="angle" value={e.angle} onChange={(v) => set("Rotation", (d) => void ((d as typeof e).angle = v))} />
          </div>
          <div className="field-row">
            {L("X", "x")}
            {L("Y", "y")}
          </div>
          <Toggle label="Bold" checked={!!e.bold} onChange={(v) => set("Bold", (d) => void ((d as typeof e).bold = v))} />
        </>
      )}
      {e.type === "ellipse" && (
        <>
          <div className="field-row">
            {L("Radius X", "rx", true)}
            {L("Radius Y", "ry")}
          </div>
          <div className="field-row">
            {L("Center X", "cx")}
            {L("Center Y", "cy")}
          </div>
          <ExprInput label="Rotation" kind="angle" value={e.angle} onChange={(v) => set("Rotation", (d) => void ((d as typeof e).angle = v))} />
        </>
      )}
      {e.type === "gear" && (
        <>
          <div className="field-row">
            <ExprInput label="Teeth" kind="count" autoFocus value={e.teeth} min={6} onChange={(v) => set("Teeth", (d) => void ((d as typeof e).teeth = v))} />
            {L("Module", "module")}
          </div>
          {L("Bore Ø", "bore")}
          <div className="field-row">
            {L("Center X", "cx")}
            {L("Center Y", "cy")}
          </div>
          <p className="muted small">
            Gears mesh when they share a module. Center distance = module × (teeth A + teeth B) / 2.
          </p>
        </>
      )}
      {e.type === "rect" && (
        <>
          <div className="field-row">
            {L("Width", "w", true)}
            {L("Height", "h")}
          </div>
          <div className="field-row">
            {L(e.anchor === "center" ? "Center X" : "Corner X", "x")}
            {L(e.anchor === "center" ? "Center Y" : "Corner Y", "y")}
          </div>
          <ExprInput label="Rounded corners" kind="length" value={e.corner ?? "0"} min={0} onChange={(v) => set("Corner", (d) => void ((d as typeof e).corner = v))} />
          <ExprInput label="Rotation" kind="angle" value={e.angle ?? "0"} onChange={(v) => set("Rotation", (d) => void ((d as typeof e).angle = v))} />
          <Segmented
            label="Position from"
            value={e.anchor}
            options={[
              { value: "corner", label: "Corner" },
              { value: "center", label: "Center" },
            ]}
            onChange={(v) => set("Anchor", (d) => void ((d as typeof e).anchor = v))}
          />
        </>
      )}
      {e.type === "circle" && (
        <>
          <ExprInput
            label="Diameter"
            kind="length"
            autoFocus
            value={diameterOf(e.r)}
            onChange={(v) => v !== diameterOf(e.r) && set("Diameter", (d) => void ((d as typeof e).r = PLAIN_NUM.test(v) ? trim(parseFloat(v) / 2, 6) : `(${v}) / 2`))}
          />
          <div className="field-row">
            {L("Center X", "cx")}
            {L("Center Y", "cy")}
          </div>
        </>
      )}
      {e.type === "polygon" && (
        <>
          {L("Radius", "r", true)}
          <ExprInput label="Sides" kind="count" value={e.sides} min={3} onChange={(v) => set("Sides", (d) => void ((d as typeof e).sides = v))} />
          <div className="field-row">
            {L("Center X", "cx")}
            {L("Center Y", "cy")}
          </div>
          <ExprInput label="Rotation" kind="angle" value={e.angle} onChange={(v) => set("Rotation", (d) => void ((d as typeof e).angle = v))} />
        </>
      )}
      {e.type === "slot" && (
        <>
          <div className="field-row">
            {L("Length", "length", true)}
            {L("Width", "width")}
          </div>
          <div className="field-row">
            {L("Center X", "cx")}
            {L("Center Y", "cy")}
          </div>
          <ExprInput label="Rotation" kind="angle" value={e.angle} onChange={(v) => set("Rotation", (d) => void ((d as typeof e).angle = v))} />
        </>
      )}
      {e.type === "polyline" && (
        <>
          <Toggle label="Smooth curve" hint="A flowing spline through the points" checked={!!e.smooth} onChange={(v) => set("Smooth", (d) => void ((d as typeof e).smooth = v))} />
          {!e.smooth && <ExprInput label="Round corners" kind="length" value={e.corner ?? "0"} min={0} onChange={(v) => set("Corner", (d) => void ((d as typeof e).corner = v))} />}
          <Toggle label="Open path" hint="A line that isn't closed: a path for sweeps, never a solid" checked={!!e.open} onChange={(v) => set("Open", (d) => void ((d as typeof e).open = v))} />
          <Disclosure summary={`${e.points.length} points`}>
            {e.points.map((p, i) => (
              <div className="field-row" key={i}>
                <ExprInput label={`P${i + 1} X`} kind="length" value={p[0]} onChange={(v) => set("Point", (d) => void ((d as typeof e).points[i]![0] = v))} />
                <ExprInput label="Y" kind="length" value={p[1]} onChange={(v) => set("Point", (d) => void ((d as typeof e).points[i]![1] = v))} />
              </div>
            ))}
          </Disclosure>
        </>
      )}
      <Segmented
        label="Solid or hole"
        value={e.mode ?? "auto"}
        options={[
          { value: "auto", label: "Automatic", title: "Inside another shape = hole" },
          { value: "add", label: "Solid" },
          { value: "subtract", label: "Hole" },
        ]}
        onChange={(v) => set("Mode", (d) => void (d.mode = v))}
      />
      <Toggle label="Construction" hint="Guides only: no solid" checked={!!e.construction} onChange={(v) => set("Construction", (d) => void (d.construction = v))} />
      <ShapeActions />
      <button className="btn btn--ghost btn--danger" onClick={() => deleteEntity(e.id)}>
        <Icon name="trash" size={16} /> Delete shape
      </button>
    </div>
  );
}

function SketchPanel({ sketch }: { sketch: SketchFeature }) {
  const selected = useApp((s) => s.selectedEntity);
  const e = sketch.entities.find((x) => x.id === selected);
  const status = useApp((s) => s.regen?.status.find((x) => x.id === sketch.id));
  return (
    <>
      <header className="panel__head">
        <Icon name="sketch" />
        <div>
          <h2>{sketch.name}</h2>
          <p className="muted">
            {sketch.plane.kind === "origin" ? `On the ${sketch.plane.plane} plane` : "On a model face"} · {sketch.entities.length} shape{sketch.entities.length === 1 ? "" : "s"}
          </p>
        </div>
      </header>
      <div className="panel__body">
        <StatusNote status={status} featureId={sketch.id} />
        {e ? (
          <EntityEditor key={e.id} e={e} />
        ) : (
          <div className="panel__section">
            <ExprInput
              label="Plane offset"
              kind="length"
              value={sketch.plane.offset}
              onChange={(v) => updateFeature(sketch.id, "Offset", (d) => void ((d as SketchFeature).plane.offset = v), "offset")}
            />
            <div className="tips">
              <p>
                <b>Draw:</b> pick a tool above, then click twice. Start typing to enter exact sizes.
              </p>
              <p>
                <b>Holes:</b> shapes inside other shapes become holes automatically. The shaded area is what will become solid.
              </p>
              <p>
                <b>Snapping:</b> points, centers and the grid. Hold Alt to place freely.
              </p>
              <p>
                <b>Arrange:</b> select a shape to duplicate, mirror, rotate or copy it around a circle.
              </p>
            </div>
          </div>
        )}
      </div>
      <footer className="panel__foot">
        <button className="btn btn--accent btn--wide" onClick={finishSketch}>
          <Icon name="finish" size={16} /> Finish sketch
        </button>
        <button className="btn btn--ghost" onClick={cancelSession} title="Discard changes to this sketch">
          Cancel
        </button>
      </footer>
    </>
  );
}

/** Grams below a kilogram, then kilograms. */
const massText = (g: number) => (g >= 1000 ? `${trim(g / 1000, 2)} kg` : `${trim(g, 1)} g`);

const UNIT_NAMES: Record<LengthUnit, string> = { mm: "millimetres", cm: "centimetres", m: "metres", in: "inches", ft: "feet" };

/** Densities in g/cm³ (typical values). */
export const MATERIALS = [
  { id: "pla", label: "PLA", density: 1.24, group: "Plastics" },
  { id: "petg", label: "PETG", density: 1.27, group: "Plastics" },
  { id: "abs", label: "ABS", density: 1.04, group: "Plastics" },
  { id: "nylon", label: "Nylon (PA12)", density: 1.01, group: "Plastics" },
  { id: "resin", label: "Resin (SLA)", density: 1.18, group: "Plastics" },
  { id: "acrylic", label: "Acrylic", density: 1.18, group: "Plastics" },
  { id: "al", label: "Aluminium 6061", density: 2.7, group: "Metals" },
  { id: "steel", label: "Steel", density: 7.85, group: "Metals" },
  { id: "stainless", label: "Stainless steel", density: 8.0, group: "Metals" },
  { id: "brass", label: "Brass", density: 8.5, group: "Metals" },
  { id: "copper", label: "Copper", density: 8.96, group: "Metals" },
  { id: "titanium", label: "Titanium", density: 4.43, group: "Metals" },
  { id: "pine", label: "Pine", density: 0.5, group: "Wood & other" },
  { id: "oak", label: "Oak", density: 0.75, group: "Wood & other" },
  { id: "plywood", label: "Plywood", density: 0.6, group: "Wood & other" },
  { id: "mdf", label: "MDF", density: 0.75, group: "Wood & other" },
  { id: "walnut", label: "Walnut", density: 0.64, group: "Wood & other" },
  { id: "bamboo", label: "Bamboo", density: 0.7, group: "Wood & other" },
  { id: "glass", label: "Glass", density: 2.5, group: "Wood & other" },
  { id: "concrete", label: "Concrete", density: 2.4, group: "Wood & other" },
  { id: "ceramic", label: "Ceramic (porcelain)", density: 2.4, group: "Wood & other" },
  { id: "silicone", label: "Silicone rubber", density: 1.1, group: "Plastics" },
  { id: "tpu", label: "TPU (flexible)", density: 1.21, group: "Plastics" },
  { id: "pc", label: "Polycarbonate", density: 1.2, group: "Plastics" },
  { id: "pom", label: "Acetal (POM)", density: 1.41, group: "Plastics" },
  { id: "al7075", label: "Aluminium 7075", density: 2.81, group: "Metals" },
  { id: "castiron", label: "Cast iron", density: 7.2, group: "Metals" },
  { id: "zinc", label: "Zinc (die cast)", density: 6.6, group: "Metals" },
  { id: "silver", label: "Sterling silver", density: 10.4, group: "Metals" },
  { id: "gold", label: "Gold (18k)", density: 15.6, group: "Metals" },
].sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));

function Inspector() {
  const doc = useApp((s) => s.doc);
  const regen = useApp((s) => s.regen);
  const selection = useApp((s) => s.selection);
  const mat = useApp((s) => (MATERIALS.some((m) => m.id === s.prefs.material) ? s.prefs.material : "pla"));
  const unit = doc.units;
  const L = (v: number) => formatQuantity(v, "length", unit);
  const density = MATERIALS.find((m) => m.id === mat)!.density;
  const p = selection[0];

  const bodyId = p && (p.kind === "body" || p.kind === "face" || p.kind === "edge") ? p.bodyId : undefined;
  const body = regen?.bodies.find((b) => b.id === bodyId);
  const meta = bodyId ? doc.bodies[bodyId] : undefined;
  const bodies = regen?.bodies ?? [];
  const totalVolume = bodies.reduce((a, b) => a + b.volume, 0);


  return (
    <>
      <header className="panel__head">
        <Icon name={body ? "body" : "file"} />
        <div>
          {body && meta ? (
            <input
              className="title-input"
              value={meta.name}
              aria-label="Body name"
              onChange={(e) => mutate("Rename body", (d) => void (d.bodies[body.id]!.name = e.target.value), "rename" + body.id)}
            />
          ) : (
            <h2>{doc.name}</h2>
          )}
          <p className="muted">{body ? "Body" : `Design \u00b7 ${UNIT_NAMES[unit]}`}</p>
        </div>
      </header>
      <div className="panel__body">
        {body && meta && (
          <div className="panel__section">
            <h3 className="eyebrow">Appearance</h3>
            <div className="swatches">
              {BODY_COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch ${meta.color === c ? "is-on" : ""}`}
                  style={{ background: c }}
                  aria-label={`Color ${c}`}
                  onClick={() => mutate("Body color", (d) => void (d.bodies[body.id]!.color = c))}
                />
              ))}
              <ColorPicker
                label="Any color"
                value={meta.color}
                presets={BODY_COLORS}
                onChange={(c) => mutate("Body color", (d) => void (d.bodies[body.id]!.color = c), "color" + body.id)}
              />
            </div>
            <div className="looks" role="radiogroup" aria-label="Finish">
              {LOOKS.map((l) => (
                <button
                  key={l.id}
                  role="radio"
                  aria-checked={(meta.look ?? "matte") === l.id}
                  className={`look ${(meta.look ?? "matte") === l.id ? "is-on" : ""}`}
                  onClick={() => mutate("Body finish", (d) => void (d.bodies[body.id]!.look = l.id))}
                  title={l.hint}
                >
                  <span className={`look__ball look__ball--${l.id}`} style={{ background: meta.color }} />
                  {l.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {p?.kind === "face" && body && (
          <div className="panel__section">
            <h3 className="eyebrow">Face</h3>
            <dl className="stats">
              <dt>Type</dt>
              <dd>{body.faces[p.index]?.surface.toLowerCase().replace("cylindre", "cylinder").replace("_surface", "")}</dd>
              <dt>Area</dt>
              <dd className="mono">{areaText(body.faces[p.index]?.area ?? 0, unit, 3)}</dd>
            </dl>
          </div>
        )}
        {p?.kind === "edge" && body && (
          <div className="panel__section">
            <h3 className="eyebrow">Edge</h3>
            <dl className="stats">
              <dt>Type</dt>
              <dd>{body.edges[p.index]?.curve.toLowerCase().replace("_curve", "")}</dd>
              <dt>Length</dt>
              <dd className="mono">{L(body.edges[p.index]?.length ?? 0)}</dd>
            </dl>
          </div>
        )}
        <div className="panel__section">
          <h3 className="eyebrow">{body ? "Measurements" : "Model"}</h3>
          <dl className="stats">
            {!body && (
              <>
                <dt>Features</dt>
                <dd className="mono">{doc.features.length}</dd>
                <dt>Bodies</dt>
                <dd className="mono">{bodies.length}</dd>
              </>
            )}
            {(body ? [body] : bodies.length ? bodies : []).length > 0 && (
              <>
                <dt>Volume</dt>
                <dd className="mono">{volumeText(body ? body.volume : totalVolume, unit, 2)}</dd>
                <dt>Mass</dt>
                <dd className="mono">
                  {massText(((body ? body.volume : totalVolume) / 1000) * density)}
                  <Select
                    size="sm"
                    ariaLabel="Material"
                    value={mat}
                    onChange={(v) => setPrefs({ material: v })}
                    options={MATERIALS.map((m) => ({ value: m.id, label: m.label, group: m.group, hint: `${m.density} g/cm³` }))}
                  />
                </dd>
              </>
            )}
            {body && (
              <>
                <dt>Size</dt>
                <dd className="mono">
                  {[0, 1, 2].map((i) => trim((body.bbox[1][i]! - body.bbox[0][i]!) / LENGTH_TO_MM[unit], 2)).join(" \u00d7 ")} {unit}
                </dd>
                <dt>Area</dt>
                <dd className="mono">{areaText(body.area, unit)}</dd>
              </>
            )}
          </dl>
          {!body && bodies.length === 0 && <p className="muted small">Nothing to measure yet. Sketch a shape and extrude it, or add a quick Box.</p>}
        </div>
      </div>
    </>
  );
}

export function PropertiesPanel() {
  const session = useApp((s) => s.session);
  const mode = useApp((s) => s.mode);
  const doc = useApp((s) => s.doc);
  const regen = useApp((s) => s.regen);

  if (mode.kind === "sketch") {
    const sk = findFeature(doc, mode.sketchId, "sketch");
    if (sk) return <aside className="panel">{<SketchPanel sketch={sk} />}</aside>;
  }
  const f = session ? findFeature(doc, session.featureId) : undefined;
  if (f && session) {
    const status = regen?.status.find((x) => x.id === f.id);
    const busy = !regen || status?.state === "incomplete";
    return (
      <aside className="panel" aria-label={`${f.name} properties`}>
        <header className="panel__head">
          <Icon name={FEATURE_ICONS[f.type]!} />
          <div>
            <input
              className="title-input"
              value={f.name}
              aria-label="Feature name"
              onChange={(e) => updateFeature(f.id, "Rename", (d) => void (d.name = e.target.value), "rename")}
            />
            <p className="muted">{session.isNew ? `New ${FEATURE_LABELS[f.type].toLowerCase()}` : "Editing"}</p>
          </div>
        </header>
        <form
          className="panel__body"
          onSubmit={(e) => {
            e.preventDefault();
            // Only Enter (the hidden default button) applies; other buttons in the panel never submit.
            const by = (e.nativeEvent as SubmitEvent).submitter;
            if (by && !by.hasAttribute("data-submit")) return;
            commitSession();
          }}
        >
          <StatusNote status={status} featureId={f.id} />
          <div className="panel__section">
            <FeatureEditor f={f} />
          </div>
          <button type="submit" hidden data-submit />
        </form>
        <footer className="panel__foot">
          <button className="btn btn--accent btn--wide" onClick={commitSession} disabled={busy}>
            <Icon name="check" size={16} /> OK
          </button>
          <button className="btn btn--ghost" onClick={cancelSession}>
            Cancel
          </button>
        </footer>
      </aside>
    );
  }
  return (
    <aside className="panel">
      <Inspector />
    </aside>
  );
}