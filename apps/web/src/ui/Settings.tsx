/** Settings: appearance, workspace profile, navigation and the assistant. */
import { useState } from "react";
import type { LengthUnit } from "@whittle/core";
import { ACCENTS, type Density, NAV_PRESETS, PROFILES, type Profile, THEMES, type ThemePref, smartSketchOn } from "../state/prefs";
import { setPrefs, useApp } from "../state/store";
import { APP_VERSION } from "@whittle/core";
import { AssistantSettings } from "./Assistant";
import { Select, Slider, Switch, Tabs } from "./controls";
import { Modal } from "./Dialogs";
import { Icon } from "./icons";
import { MATERIALS } from "./PropertiesPanel";

type Tab = "appearance" | "workspace" | "navigation" | "assistant" | "about";

const UNITS: { value: LengthUnit; label: string; hint: string }[] = [
  { value: "mm", label: "Millimetres", hint: "Most CAD, 3D printing and engineering" },
  { value: "cm", label: "Centimetres", hint: "Furniture, crafts" },
  { value: "m", label: "Metres", hint: "Architecture, large structures" },
  { value: "in", label: "Inches", hint: "US engineering and woodworking" },
  { value: "ft", label: "Feet", hint: "Construction, rooms" },
];

function ThemeCard({ id, label, swatch, blurb, on }: { id: ThemePref; label: string; swatch: [string, string, string]; blurb: string; on: boolean }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={`themecard ${on ? "is-on" : ""}`} onClick={() => setPrefs({ theme: id })} title={blurb}>
      <span className="themecard__art" style={{ background: swatch[0] }} aria-hidden="true">
        <span className="themecard__bar" style={{ background: swatch[1] }} />
        <span className="themecard__panel" style={{ background: swatch[1] }} />
        <span className="themecard__line" style={{ background: swatch[2] }} />
        <span className="themecard__line themecard__line--short" style={{ background: swatch[2] }} />
        <span className="themecard__dot" />
      </span>
      <span className="themecard__label">{label}</span>
    </button>
  );
}

function Appearance() {
  const prefs = useApp((s) => s.prefs);
  return (
    <div className="settings__section">
      <h3 className="eyebrow">Theme</h3>
      <div className="themegrid" role="radiogroup" aria-label="Theme">
        <ThemeCard id="system" label="Match system" swatch={["linear-gradient(135deg, #1b1a18 50%, #ece8df 50%)" as string, "#8884", "#999"]} blurb="Follows your operating system's light or dark mode" on={prefs.theme === "system"} />
        {THEMES.map((t) => (
          <ThemeCard key={t.id} id={t.id} label={t.label} swatch={t.swatch} blurb={t.blurb} on={prefs.theme === t.id} />
        ))}
      </div>
      <h3 className="eyebrow">Accent color</h3>
      <div className="accentrow" role="radiogroup" aria-label="Accent color">
        {ACCENTS.map((a) => (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={prefs.accent === a.id}
            aria-label={a.label}
            title={a.label}
            className={`accentdot ${prefs.accent === a.id ? "is-on" : ""}`}
            style={{ background: a.color }}
            onClick={() => setPrefs({ accent: a.id })}
          >
            {prefs.accent === a.id && <Icon name="check" size={14} />}
          </button>
        ))}
      </div>
      <div className="settings__grid">
        <div className="field field--stack">
          <span className="field__label">Density</span>
          <div className="seg" role="radiogroup">
            {(["compact", "comfortable", "spacious"] as Density[]).map((d) => (
              <button key={d} type="button" role="radio" aria-checked={prefs.density === d} className={`seg__btn ${prefs.density === d ? "is-on" : ""}`} onClick={() => setPrefs({ density: d })}>
                {d[0]!.toUpperCase() + d.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="field field--stack">
          <span className="field__label">
            Interface size <b className="mono">{Math.round(prefs.scale * 100)}%</b>
          </span>
          <Slider value={prefs.scale} min={0.85} max={1.3} step={0.05} ariaLabel="Interface size" format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setPrefs({ scale: v })} />
        </div>
      </div>
      <Switch label="Reduce motion" hint="Fewer animations and instant camera moves" checked={prefs.reduceMotion} onChange={(v) => setPrefs({ reduceMotion: v })} />
    </div>
  );
}

function Workspace() {
  const prefs = useApp((s) => s.prefs);
  return (
    <div className="settings__section">
      <h3 className="eyebrow">How you use Whittle</h3>
      <div className="profilegrid" role="radiogroup" aria-label="Workspace profile">
        {PROFILES.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={prefs.profile === p.id}
            className={`profilecard ${prefs.profile === p.id ? "is-on" : ""}`}
            onClick={() => applyProfile(p.id)}
          >
            <Icon name={p.icon} size={20} />
            <span>
              <b>{p.label}</b>
              <small>{p.blurb}</small>
            </span>
          </button>
        ))}
      </div>
      <p className="muted small">A profile only sets starting points: which tools sit on the toolbar, hints, units and the default material. Every tool stays available, and you can change anything below.</p>
      <div className="settings__grid">
        <Select label="Units for new designs" value={prefs.units} options={UNITS} onChange={(v) => setPrefs({ units: v })} />
        <Select
          label="Default material"
          value={prefs.material}
          options={MATERIALS.map((m) => ({ value: m.id, label: m.label, group: m.group, hint: `${m.density} g/cm³` }))}
          onChange={(v) => setPrefs({ material: v })}
        />
      </div>
      <Switch label="Constraint-ready shapes" hint="New rectangles, circles, polygons and slots are drawn as lines and arcs you can dimension, constrain, trim and fillet" checked={smartSketchOn(prefs)} onChange={(v) => setPrefs({ smartSketch: v })} />
      <Switch label="Show hints" hint="The hint line at the bottom always tells you the next step" checked={prefs.hints} onChange={(v) => setPrefs({ hints: v })} />
      <Switch label="Labels under toolbar icons" hint="Turn off for a slimmer toolbar once you know the icons" checked={prefs.toolLabels} onChange={(v) => setPrefs({ toolLabels: v })} />
    </div>
  );
}

/** Choose a profile and take on its defaults. */
export function applyProfile(id: Profile) {
  const p = PROFILES.find((x) => x.id === id)!;
  setPrefs({ profile: id, units: p.units, material: p.material, hints: p.hints, toolLabels: true });
}

function Navigation() {
  const prefs = useApp((s) => s.prefs);
  return (
    <div className="settings__section">
      <h3 className="eyebrow">Mouse navigation</h3>
      <p className="muted small">Coming from another CAD app? Use the mouse the way you're used to.</p>
      <div className="navlist" role="radiogroup" aria-label="Navigation style">
        {NAV_PRESETS.map((n) => (
          <button key={n.id} type="button" role="radio" aria-checked={prefs.nav === n.id} className={`navitem ${prefs.nav === n.id ? "is-on" : ""}`} onClick={() => setPrefs({ nav: n.id })}>
            <span className="navitem__radio" aria-hidden="true" />
            <span>
              <b>{n.label}</b>
              <small>{n.blurb}</small>
            </span>
          </button>
        ))}
      </div>
      <Switch label="Invert zoom direction" hint="Scroll up to zoom out instead of in" checked={prefs.invertZoom} onChange={(v) => setPrefs({ invertZoom: v })} />
    </div>
  );
}

function About() {
  const platform = useApp((s) => s.platform);
  const where = platform.kind === "desktop" ? "Desktop app" : platform.kind === "server" ? `Server ${platform.config.version}` : "Web browser";
  return (
    <div className="settings__section">
      <div className="about">
        <svg width="40" height="40" viewBox="0 0 64 64" aria-hidden="true">
          <path d="M14 46 L30 14 L50 40 Z" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinejoin="round" />
          <path d="M10 52 H54" stroke="var(--accent)" strokeWidth="5" strokeLinecap="round" />
        </svg>
        <div>
          <h3>Whittle {APP_VERSION}</h3>
          <p className="muted small">Open-source parametric 3D CAD · {where}</p>
        </div>
      </div>
      <dl className="stats">
        <dt>Geometry</dt>
        <dd>OpenCascade (B-rep), in a background worker</dd>
        <dt>Your data</dt>
        <dd>{platform.kind === "server" ? "Stored on your server" : platform.kind === "desktop" ? "Files on this computer" : "Files you save, plus versions in this browser"}</dd>
        <dt>Settings</dt>
        <dd>Kept on this device</dd>
        <dt>License</dt>
        <dd>MPL-2.0</dd>
      </dl>
      <div className="btnrow">
        <button className="btn btn--small" onClick={() => useApp.setState({ panel: "shortcuts" })}>
          <Icon name="keyboard" size={15} /> Keyboard shortcuts
        </button>
        <button className="btn btn--small btn--ghost" onClick={() => useApp.setState({ panel: "welcome" })}>
          <Icon name="home" size={15} /> Start screen
        </button>
      </div>
    </div>
  );
}

/** Open Settings at a given tab. */
export function openSettings(tab: Tab = "appearance") {
  startTab = tab;
  useApp.setState({ panel: "settings" });
}
let startTab: Tab = "appearance";

export function SettingsDialog() {
  const [tab, setTab] = useState<Tab>(() => {
    const t = startTab;
    startTab = "appearance";
    return t;
  });
  return (
    <Modal title="Settings" wide>
      <div className="settings">
        <Tabs<Tab>
          vertical
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "appearance", label: "Appearance", icon: "palette" },
            { value: "workspace", label: "Workspace", icon: "layers" },
            { value: "navigation", label: "Navigation", icon: "move" },
            { value: "assistant", label: "AI assistant", icon: "assistant" },
            { value: "about", label: "About", icon: "info" },
          ]}
        />
        <div className="settings__pane" role="tabpanel">
          {tab === "appearance" && <Appearance />}
          {tab === "workspace" && <Workspace />}
          {tab === "navigation" && <Navigation />}
          {tab === "assistant" && <AssistantSettings />}
          {tab === "about" && <About />}
        </div>
      </div>
    </Modal>
  );
}

/** First run: one question that tunes the workspace. Shown inside the start screen. */
export function ProfilePicker({ onDone }: { onDone: () => void }) {
  return (
    <div className="onboard">
      <h3>What brings you to Whittle?</h3>
      <p className="muted">Pick what fits best. It sets sensible defaults; you can change it any time in Settings.</p>
      <div className="profilegrid profilegrid--onboard">
        {PROFILES.map((p) => (
          <button
            key={p.id}
            type="button"
            className="profilecard"
            onClick={() => {
              applyProfile(p.id);
              onDone();
            }}
          >
            <Icon name={p.icon} size={22} />
            <span>
              <b>{p.label}</b>
              <small>{p.blurb}</small>
            </span>
          </button>
        ))}
      </div>
      <button className="link" onClick={() => (setPrefs({ profile: "maker" }), onDone())}>
        Skip for now
      </button>
    </div>
  );
}
