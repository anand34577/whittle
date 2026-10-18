/** Left panel: what's in the design (parameters, origin, bodies, sketches). */
import { useState } from "react";
import { activeEnd, documentEvaluator, formatQuantity, isSketchConsumed } from "@whittle/core";
import { createSketchOn, saveNamedView, showNamedView } from "../state/actions";
import { editFeature, mutate, useApp } from "../state/store";
import { Icon } from "./icons";

function Section({ title, count, children, defaultOpen = true, forceOpen = false }: { title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean; forceOpen?: boolean }) {
  const [userOpen, setOpen] = useState(defaultOpen);
  const open = userOpen || forceOpen;
  return (
    <section className="tree__section">
      <button className="tree__head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        <span>{title}</span>
        {count !== undefined && <span className="tree__count">{count}</span>}
      </button>
      {open && <div className="tree__items">{children}</div>}
    </section>
  );
}

export function Browser() {
  const doc = useApp((s) => s.doc);
  const regen = useApp((s) => s.regen);
  const selection = useApp((s) => s.selection);
  const mode = useApp((s) => s.mode);
  const end = activeEnd(doc);
  const ev = documentEvaluator(doc);
  const bodies = regen?.bodies ?? [];
  const sketches = doc.features.slice(0, end).filter((f) => f.type === "sketch");
  const cplanes = doc.features.slice(0, end).filter((f) => f.type === "cplane" || (f.type === "construct" && (f.mode.startsWith("plane") || f.mode === "midplane")));
  const refs = doc.features.slice(0, end).filter((f) => (f.type === "construct" && !(f.mode.startsWith("plane") || f.mode === "midplane")) || f.type === "curve");
  const isSel = (fn: (p: (typeof selection)[number]) => boolean) => selection.some(fn);

  return (
    <nav className="browser" aria-label="Design browser">
      <div className="tree">
        <Section title="Parameters" count={doc.parameters.length} defaultOpen={doc.parameters.length > 0}>
          {[...doc.parameters].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite)).map((p) => {
            const v = ev.params.get(p.name);
            return (
              <button key={p.id} className="tree__row" onClick={() => useApp.setState({ panel: "params" })} title={p.comment ?? p.expr}>
                {p.favorite ? <Icon name="starOn" size={12} /> : <span className="tree__glyph mono">fx</span>}
                <span className="tree__name mono">{p.name}</span>
                <span className={`tree__value mono ${v?.ok ? "" : "is-error"}`}>{v?.ok ? formatQuantity(v.value, p.kind, doc.units) : "error"}</span>
              </button>
            );
          })}
          <button className="tree__row tree__row--add" onClick={() => useApp.setState({ panel: "params" })}>
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
          {cplanes.map((c) => (
            <div key={c.id} className="tree__row" title="Sketch on this plane">
              <button className="tree__main" onClick={() => createSketchOn({ kind: "construction", plane: c.id, offset: "0" })} onDoubleClick={() => editFeature(c.id)}>
                <Icon name="plane" size={16} />
                <span className="tree__name">{c.name}</span>
                <span className="tree__action">Sketch</span>
              </button>
              <button className="tree__eye" title="Edit plane" aria-label="Edit plane" onClick={() => editFeature(c.id)}>
                <Icon name="edit" size={15} />
              </button>
            </div>
          ))}
        </Section>

        {refs.length > 0 && (
          <Section title="Axes & points" count={refs.length} defaultOpen={false}>
            {refs.map((c) => (
              <button key={c.id} className="tree__row" onClick={() => editFeature(c.id)} title="Edit">
                <Icon name={c.type === "curve" ? "path" : c.type === "construct" && c.mode.startsWith("axis") ? "axis" : "point"} size={16} />
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
                <button className="tree__main" onClick={() => useApp.setState({ selection: [{ kind: "body", bodyId: b.id }] })} onDoubleClick={() => editFeature(b.id)}>
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
              <button className="tree__main" onClick={() => useApp.setState({ selection: [{ kind: "sketch", sketchId: s.id }] })} onDoubleClick={() => editFeature(s.id)}>
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