/** Left panel: what's in the design (parameters, origin, bodies, sketches). */
import { useState } from "react";
import { type DatumKind, activeEnd, datumKind, documentEvaluator, featureInputs, formatQuantity, isSketchConsumed } from "@whittle/core";
import { createSketchOn, handlePick, saveNamedView, showNamedView } from "../state/actions";
import { editFeature, mutate, useApp } from "../state/store";
import { renameBody, renameStep } from "../state/steps";
import { Icon } from "./icons";
import { DeferredInput } from "./DeferredInput";

function Section({ title, count, children, defaultOpen = true, forceOpen = false, control }: { title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean; forceOpen?: boolean; control?: React.ReactNode }) {
  const [userOpen, setOpen] = useState(defaultOpen);
  const open = userOpen || forceOpen;
  return (
    <section className="tree__section">
      <div className="tree__heading">
        <button className="tree__head" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
          <span>{title}</span>
          {count !== undefined && <span className="tree__count">{count}</span>}
        </button>
        {control}
      </div>
      {open && <div className="tree__items">{children}</div>}
    </section>
  );
}

export function Browser() {
  const doc = useApp((s) => s.doc);
  const [editing, setEditing] = useState<string | null>(null);
  const regen = useApp((s) => s.regen);
  const selection = useApp((s) => s.selection);
  const mode = useApp((s) => s.mode);
  const sessionId = useApp((s) => s.session?.featureId);
  const edited = doc.features.find((f) => f.id === sessionId);
  const choosingDatum = edited?.type === "construct" || edited?.type === "cplane";
  const inputs = choosingDatum ? featureInputs(edited) : [];
  const end = activeEnd(doc);
  const ev = documentEvaluator(doc);
  const bodies = regen?.bodies ?? [];
  const sketches = doc.features.slice(0, end).filter((f) => f.type === "sketch");
  const active = doc.features.slice(0, end);
  const planes = active.filter((f) => datumKind(f) === "plane");
  const groups = [
    { kind: "plane", title: "Planes", features: planes },
    { kind: "axis", title: "Axes", features: active.filter((f) => datumKind(f) === "axis") },
    { kind: "point", title: "Points", features: active.filter((f) => datumKind(f) === "point") },
  ] as const satisfies ReadonlyArray<{ kind: DatumKind; title: string; features: typeof active }>;
  const curves = active.filter((f) => f.type === "curve");
  const isSel = (fn: (p: (typeof selection)[number]) => boolean) => selection.some(fn);

  return (
    <nav className="browser" aria-label="Design browser">
      {/* Narrow windows show the browser as a drawer over the model: give it a visible way out. */}
      <header className="browser__drawerhead">
        <span className="eyebrow">Browser</span>
        <button className="iconbtn iconbtn--small" title="Close" aria-label="Close the design browser" onClick={() => useApp.setState({ browserOpen: false })}>
          <Icon name="close" size={15} />
        </button>
      </header>
      <div className="tree">
        {/* Opens by itself once a design has parameters (a template, say): the numbers are the point (audit U-4). */}
        <Section key={doc.parameters.length > 0 ? "params" : "no-params"} title="Parameters" count={doc.parameters.length} defaultOpen={doc.parameters.length > 0}>
          {[...doc.parameters].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite)).map((p) =>
            // Click the value to change it right here, with the model in view (audit U-3).
            editing === p.id ? (
              <div key={p.id} className="tree__row tree__row--edit">
                <span className="tree__name mono">{p.name}</span>
                <DeferredInput
                  className="input input--small mono tree__input"
                  value={p.expr}
                  autoFocus
                  aria-label={`Value of ${p.name}`}
                  onCommit={(expr) => mutate(`${p.name} ${p.expr} → ${expr}`, (d) => void (d.parameters.find((x) => x.id === p.id)!.expr = expr), "param" + p.id + "expr")}
                  onDone={() => setEditing(null)}
                />
              </div>
            ) : (
              <div key={p.id} className="tree__row">
                <button className="tree__main" onClick={() => (useApp.setState({ focusParam: p.id, panel: "params" }))} title={`${p.comment ? p.comment + " · " : ""}Click the value to change it · the name opens the full list`}>
                  {p.favorite ? <Icon name="starOn" size={12} /> : <span className="tree__glyph mono">fx</span>}
                  <span className="tree__name mono">{p.name}</span>
                </button>
                <button className={`tree__value tree__value--edit mono ${ev.params.get(p.name)?.ok ? "" : "is-error"}`} onClick={() => setEditing(p.id)} title={`${p.expr} · click to change`}>
                  {ev.params.get(p.name)?.ok ? formatQuantity(ev.params.get(p.name)!.value, p.kind, doc.units) : "error"}
                </button>
              </div>
            ),
          )}
          <button className="tree__row tree__row--add" onClick={() => useApp.setState({ focusParam: null, panel: "params" })}>
            <Icon name="plus" size={14} />
            <span className="tree__name">Add parameter</span>
          </button>
        </Section>

        <Section title="Origin" defaultOpen={false} forceOpen={mode.kind === "pickPlane"}>
          {(["XY", "XZ", "YZ"] as const).map((pl) => (
            <button
              key={pl}
              className="tree__row"
              onClick={() => createSketchOn({ kind: "origin", plane: pl, offset: "0" })}
              title={`Start a sketch on the ${pl} plane`}
            >
              <Icon name="plane" size={16} />
              <span className="tree__name">{pl} plane</span>
              <span className="tree__action">Sketch</span>
            </button>
          ))}
        </Section>

        {groups.map(({ kind, title, features }) => {
          if (!features.length) return null;
          const categoryVisible = doc.datumVisibility?.categories?.[kind] !== false;
          const categoryLabel = `${categoryVisible ? "Hide" : "Show"} all datum ${title.toLowerCase()}`;
          return (
            <Section key={kind} title={title} count={features.length} forceOpen={kind === "plane" && mode.kind === "pickPlane"} control={
              <button className="tree__eye tree__datum-eye" aria-label={categoryLabel} title={categoryLabel} onClick={() => mutate(categoryLabel, (d) => {
                const settings = (d.datumVisibility ??= {});
                (settings.categories ??= {})[kind] = !categoryVisible;
              })}>
                <Icon name={categoryVisible ? "eye" : "eyeOff"} size={16} />
              </button>
            }>
              {features.map((f) => {
                const visible = doc.datumVisibility?.items?.[f.id] !== false;
                const selected = inputs.includes(f.id) || isSel((pick) => pick.kind === "datum" && pick.id === f.id);
                const visibilityLabel = `${visible ? "Hide" : "Show"} ${f.name}`;
                return (
                  <div key={f.id} className={`tree__row ${selected ? "is-selected" : ""}`}>
                    <button className="tree__main" aria-pressed={selected} title="Double-click to edit" onClick={(e) => {
                      if (mode.kind === "model" || mode.kind === "pickPlane") {
                        handlePick({ kind: "datum", id: f.id, datumKind: kind }, e.shiftKey || e.ctrlKey || e.metaKey);
                      }
                    }} onDoubleClick={() => mode.kind === "model" && !choosingDatum && editFeature(f.id)}>
                      <Icon name={kind} size={16} />
                      <span className={`tree__name ${visible && categoryVisible ? "" : "is-muted"}`}>{f.name}</span>
                    </button>
                    <button className="tree__eye" title="Edit" aria-label={`Edit ${f.name}`} onClick={() => editFeature(f.id)}>
                      <Icon name="edit" size={15} />
                    </button>
                    <button className="tree__eye tree__datum-eye" title={visibilityLabel} aria-label={visibilityLabel} onClick={() => mutate(visibilityLabel, (d) => {
                      const settings = (d.datumVisibility ??= {});
                      (settings.items ??= {})[f.id] = !visible;
                    })}>
                      <Icon name={visible ? "eye" : "eyeOff"} size={16} />
                    </button>
                  </div>
                );
              })}
            </Section>
          );
        })}

        {curves.length > 0 && (
          <Section title="Curves" count={curves.length} defaultOpen={false}>
            {curves.map((c) => (
              <button key={c.id} className="tree__row" onClick={() => editFeature(c.id)} title="Edit">
                <Icon name="path" size={16} />
                <span className="tree__name">{c.name}</span>
              </button>
            ))}
          </Section>
        )}

        <Section title="Views" count={doc.views?.length ?? 0} defaultOpen={!!doc.views?.length}>
          {(doc.views ?? []).map((v) => (
            <div key={v.id} className="tree__row">
              <button className="tree__main" onClick={() => showNamedView(v)} title="Go to this view">
                <Icon name="camera" size={14} />
                <span className="tree__name">{v.name}</span>
              </button>
              <button className="tree__eye" aria-label={`Delete view ${v.name}`} title="Delete view" onClick={() => mutate(`Delete view ${v.name}`, (d) => void (d.views = d.views?.filter((x) => x.id !== v.id)))}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
          <button className="tree__row tree__row--add" onClick={() => void saveNamedView()}>
            <Icon name="plus" size={14} />
            <span className="tree__name">Save current view</span>
          </button>
        </Section>

        <Section title="Bodies" count={bodies.length}>
          {bodies.length === 0 && <p className="tree__empty">No bodies yet</p>}
          {bodies.map((b) => {
            const meta = doc.bodies[b.id];
            const visible = meta?.visible !== false;
            return (
              <div key={b.id} className={`tree__row ${isSel((p) => (p.kind === "body" || p.kind === "face" || p.kind === "edge") && p.bodyId === b.id) ? "is-selected" : ""}`}>
                <button className="tree__main" onClick={() => useApp.setState({ selection: [{ kind: "body", bodyId: b.id }] })} onDoubleClick={() => editFeature(b.id)} onKeyDown={(e) => e.key === "F2" && (e.preventDefault(), void renameBody(b.id))} title="Double-click to edit its step · F2 to rename">
                  <span className="tree__swatch" style={{ background: meta?.color ?? "#ccc" }} />
                  <span className={`tree__name ${visible ? "" : "is-muted"}`}>{meta?.name ?? "Body"}</span>
                  {(meta?.component || meta?.grounded) && <span className="tree__action">{[meta?.component, meta?.grounded ? "grounded" : ""].filter(Boolean).join(" · ")}</span>}
                </button>
                <button
                  className="tree__eye"
                  aria-label={visible ? "Hide body" : "Show body"}
                  title={visible ? "Hide" : "Show"}
                  onClick={() =>
                    mutate(visible ? "Hide body" : "Show body", (d) => {
                      const m = d.bodies[b.id];
                      if (m) m.visible = !visible;
                    })
                  }
                >
                  <Icon name={visible ? "eye" : "eyeOff"} size={16} />
                </button>
              </div>
            );
          })}
        </Section>

        <Section title="Sketches" count={sketches.length}>
          {sketches.length === 0 && <p className="tree__empty">No sketches yet</p>}
          {sketches.map((s) => (
            <div key={s.id} className={`tree__row ${isSel((p) => p.kind === "sketch" && p.sketchId === s.id) ? "is-selected" : ""}`}>
              <button className="tree__main" onClick={() => useApp.setState({ selection: [{ kind: "sketch", sketchId: s.id }] })} onDoubleClick={() => editFeature(s.id)} onKeyDown={(e) => e.key === "F2" && (e.preventDefault(), void renameStep(s.id))} title="Double-click to edit · F2 to rename">
                <Icon name="sketch" size={16} />
                <span className={`tree__name ${isSketchConsumed(doc, s.id) ? "is-muted" : ""}`}>{s.name}</span>
              </button>
              <button className="tree__eye" title="Edit sketch" aria-label="Edit sketch" onClick={() => editFeature(s.id)}>
                <Icon name="edit" size={15} />
              </button>
            </div>
          ))}
        </Section>
      </div>
    </nav>
  );
}