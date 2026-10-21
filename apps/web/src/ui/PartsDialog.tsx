/** The parts library: a gallery of ready-made, fully editable parts. */
import { useMemo, useState } from "react";
import { PARTS, type PartDef, insertPart } from "../state/parts";
import { useApp } from "../state/store";
import { Modal } from "./Dialogs";
import { Icon } from "./icons";

/** Small line drawings, in the same hand as the icon set. */
function PartArt({ id }: { id: string }) {
  const s = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  const gear = (cx: number, cy: number, r: number, n: number) => {
    const pts: string[] = [];
    for (let i = 0; i < n * 4; i++) {
      const a = (i / (n * 4)) * Math.PI * 2;
      const rr = i % 4 < 2 ? r : r * 0.82;
      pts.push(`${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`);
    }
    return pts.join(" ");
  };
  const hex = (cx: number, cy: number, r: number) =>
    Array.from({ length: 6 }, (_, i) => `${(cx + r * Math.cos((i * Math.PI) / 3)).toFixed(1)},${(cy + r * Math.sin((i * Math.PI) / 3)).toFixed(1)}`).join(" ");
  let art: React.ReactNode;
  switch (id) {
    case "gear":
      art = (
        <>
          <polygon points={gear(40, 32, 22, 14)} {...s} />
          <circle cx="40" cy="32" r="5" {...s} />
        </>
      );
      break;
    case "nut":
      art = (
        <>
          <polygon points={hex(40, 32, 20)} {...s} />
          <circle cx="40" cy="32" r="8" {...s} />
        </>
      );
      break;
    case "washer":
      art = (
        <>
          <circle cx="40" cy="32" r="20" {...s} />
          <circle cx="40" cy="32" r="9" {...s} />
        </>
      );
      break;
    case "standoff":
      art = (
        <>
          <path d="M28 14 L34 10 H46 L52 14 V48 L46 52 H34 L28 48 Z" {...s} />
          <path d="M34 10 V52 M46 10 V52" {...s} opacity=".45" />
        </>
      );
      break;
    case "bracket":
      art = (
        <>
          <path d="M18 50 L18 14 L26 10 L26 42 L62 42 L62 50 Z" {...s} />
          <path d="M26 42 L34 38 L70 38 L62 42 M70 38 V46 L62 50" {...s} opacity=".55" />
          <ellipse cx="22" cy="24" rx="2.5" ry="4" {...s} />
          <ellipse cx="48" cy="40" rx="4" ry="1.6" {...s} />
        </>
      );
      break;
    case "plate":
      art = (
        <>
          <rect x="14" y="14" width="52" height="36" rx="5" {...s} />
          {[20, 60].map((x) => [20, 44].map((y) => <circle key={`${x}${y}`} cx={x} cy={y} r="2.6" {...s} />))}
        </>
      );
      break;
    case "enclosure":
      art = (
        <>
          <path d="M14 24 L40 14 L66 24 V44 L40 54 L14 44 Z" {...s} />
          <path d="M18 25 L40 17 L62 25 L40 33 Z" {...s} opacity=".55" />
          <path d="M14 24 L40 34 L66 24 M40 34 V54" {...s} opacity=".4" />
        </>
      );
      break;
    case "lid":
      art = (
        <>
          <path d="M14 28 L40 18 L66 28 L40 38 Z" {...s} />
          <path d="M14 28 V32 L40 42 L66 32 V28" {...s} />
          <path d="M22 36 V40 L40 47 L58 40 V36" {...s} opacity=".55" />
        </>
      );
      break;
    case "knob":
      art = (
        <>
          <polygon points={gear(40, 32, 21, 18)} {...s} />
          <path d="M37 28 H43 V36 H37 Z" {...s} />
        </>
      );
      break;
    case "nametag":
      art = (
        <>
          <rect x="10" y="20" width="60" height="24" rx="5" {...s} />
          <circle cx="17" cy="32" r="2.5" {...s} />
          <path d="M26 38 L29 26 L32 38 M36 26 V38 H42 M46 26 V38 M46 26 H52 M46 32 H51" {...s} />
        </>
      );
      break;
    case "vase":
      art = <path d="M30 54 C22 40 22 28 34 18 C36 16 35 12 33 10 H47 C45 12 44 16 46 18 C58 28 58 40 50 54 Z" {...s} />;
      break;
    case "pulley":
      art = (
        <>
          <ellipse cx="40" cy="32" rx="22" ry="22" {...s} />
          <ellipse cx="40" cy="32" rx="17" ry="17" {...s} opacity=".5" />
          <circle cx="40" cy="32" r="4" {...s} />
        </>
      );
      break;
    case "bolt":
      art = (
        <>
          <path d="M26 14 L33 8 H47 L54 14 L47 20 H33 Z" {...s} />
          <path d="M35 21 V54 L38 58 H42 L45 54 V21" {...s} />
          <path d="M35 28 L45 31 M35 35 L45 38 M35 42 L45 45 M35 49 L45 52" {...s} opacity=".5" />
        </>
      );
      break;
    case "boss":
      art = (
        <>
          <ellipse cx="40" cy="20" rx="11" ry="5" {...s} />
          <ellipse cx="40" cy="20" rx="4" ry="1.8" {...s} />
          <path d="M29 20 V48 C29 52 51 52 51 48 V20" {...s} />
          <path d="M29 44 L16 50 M51 44 L64 50 M40 52 V58" {...s} opacity=".6" />
        </>
      );
      break;
    case "grille":
      art = (
        <>
          <rect x="12" y="14" width="56" height="36" rx="3" {...s} />
          {[22, 30, 38, 46, 54, 62].map((x) => (
            <rect key={x} x={x - 2} y="20" width="4" height="24" rx="2" {...s} opacity=".7" />
          ))}
        </>
      );
      break;
    case "spring":
      art = <path d="M30 12 H50 M30 16 C30 12 50 14 50 18 C50 22 30 20 30 24 C30 28 50 26 50 30 C50 34 30 32 30 36 C30 40 50 38 50 42 C50 46 30 44 30 48 M30 52 H50" {...s} />;
      break;
    default:
      art = <rect x="20" y="16" width="40" height="32" {...s} />;
  }
  return (
    <svg viewBox="0 0 80 64" width="100%" height="100%" aria-hidden="true">
      {art}
    </svg>
  );
}

const CATEGORIES = ["All", "Mechanical", "Fasteners", "Enclosures", "Everyday"] as const;

export function PartsDialog() {
  const [cat, setCat] = useState<(typeof CATEGORIES)[number]>("All");
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return PARTS.filter((p: PartDef) => (cat === "All" || p.category === cat) && words.every((w) => `${p.title} ${p.blurb} ${p.category}`.toLowerCase().includes(w)));
  }, [cat, q]);
  return (
    <Modal title="Parts library" wide onClose={() => useApp.setState({ panel: null })}>
      <div className="parts">
        <div className="parts__bar">
          <div className="seg" role="tablist">
            {CATEGORIES.map((c) => (
              <button key={c} role="tab" aria-selected={cat === c} className={cat === c ? "is-on" : ""} onClick={() => setCat(c)}>
                {c}
              </button>
            ))}
          </div>
          <label className="parts__search">
            <Icon name="search" size={16} />
            <input autoFocus placeholder="Search parts" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") void (q ? setQ("") : useApp.setState({ panel: null })); }} />
          </label>
        </div>
        <div className="parts__grid">
          {list.map((p) => (
            <button key={p.id} className="part" onClick={() => insertPart(p)}>
              <span className="part__art">
                <PartArt id={p.id} />
              </span>
              <span className="part__text">
                <b>{p.title}</b>
                <small>{p.blurb}</small>
              </span>
              <span className="part__tag">{p.category}</span>
            </button>
          ))}
          {list.length === 0 && <p className="muted">No parts match. Try another word.</p>}
        </div>
        <p className="parts__foot muted small">
          <Icon name="params" size={14} /> Every part is made of normal features. Change its sizes in Parameters, or edit its steps in the timeline.
        </p>
      </div>
    </Modal>
  );
}
