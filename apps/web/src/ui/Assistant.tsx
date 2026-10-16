/** The AI assistant panel and its provider settings. */
import { useEffect, useRef, useState } from "react";
import { PRESETS, type ProviderConfig, activeProvider, askAssistant, clearConversation, saveAiSettings, stopAssistant, useAi } from "../state/ai";
import { confirmDialog } from "../state/dialogs";
import { uid } from "@whittle/core";
import { useApp } from "../state/store";
import { Select, TextField } from "./controls";
import { Icon } from "./icons";
import { openSettings } from "./settingsTab";

const TOOL_LABELS: Record<string, string> = {
  get_design: "Read the design",
  set_parameter: "Set parameter",
  add_sketch: "Add sketch",
  add_feature: "Add feature",
  update_feature: "Edit feature",
  delete_feature: "Delete feature",
  set_body_appearance: "Change appearance",
  undo: "Undo",
};

const IDEAS = [
  "Make a 60 × 40 × 20 mm box with 2 mm walls and rounded corners",
  "Add four M3 mounting holes 5 mm from each corner of the top face",
  "Create a phone stand with a 70° viewing angle",
  "Turn the main dimensions into parameters I can edit",
];

function ToolStep({ name, input, result }: { name: string; input: Record<string, unknown>; result?: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const status = (result?.status as { state?: string; message?: string } | undefined) ?? undefined;
  const failed = !!result?.error || status?.state === "error";
  const what = (input.name as string) ?? (input.type as string) ?? (input.feature as string) ?? "";
  return (
    <div className={`aistep ${failed ? "is-error" : result ? "is-done" : "is-busy"}`}>
      <button className="aistep__head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="aistep__dot" aria-hidden="true" />
        <span>{TOOL_LABELS[name] ?? name}</span>
        {what && <span className="aistep__what">{what}</span>}
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
      </button>
      {failed && <p className="aistep__msg">{String(result?.error ?? status?.message ?? "")}</p>}
      {open && <pre className="aistep__json">{JSON.stringify({ input, result }, null, 2)}</pre>}
    </div>
  );
}

export function AssistantPanel() {
  const items = useAi((s) => s.items);
  const busy = useAi((s) => s.busy);
  const providers = useAi((s) => s.settings.providers);
  const provider = activeProvider();
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [items]);
  useEffect(() => box.current?.focus(), []);
  const send = (t = text) => {
    const v = t.trim();
    if (!v || busy) return;
    setText("");
    void askAssistant(v);
  };
  const close = () => useApp.setState({ assistant: false });
  return (
    <aside className="assistant" aria-label="AI assistant" onKeyDown={(e) => e.stopPropagation()}>
      <header className="assistant__head">
        <Icon name="assistant" size={18} />
        <div>
          <b>Assistant</b>
          <small className="muted">{provider ? `${provider.label} · ${provider.model || "no model"}` : "Not set up"}</small>
        </div>
        <span className="assistant__spacer" />
        {items.length > 0 && (
          <button className="iconbtn iconbtn--small" title="New conversation" onClick={clearConversation} disabled={busy}>
            <Icon name="refresh" size={15} />
          </button>
        )}
        <button className="iconbtn iconbtn--small" title="Assistant settings" onClick={() => openSettings("assistant")}>
          <Icon name="settings" size={15} />
        </button>
        <button className="iconbtn iconbtn--small" title="Close" onClick={close}>
          <Icon name="close" size={15} />
        </button>
      </header>
      <div className="assistant__list" ref={list}>
        {providers.length === 0 ? (
          <div className="assistant__empty">
            <Icon name="assistant" size={28} />
            <p>
              Describe what you want to make or change, and the assistant builds it with the same tools you use: sketches, features and parameters. Every step is
              undoable.
            </p>
            <p className="muted small">Connect Claude, OpenAI, or a model running on your own computer (Ollama, LM Studio).</p>
            <button className="btn btn--accent" onClick={() => openSettings("assistant")}>
              Set up a provider
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="assistant__empty">
            <p className="muted">Try:</p>
            {IDEAS.map((i) => (
              <button key={i} className="assistant__idea" onClick={() => send(i)}>
                {i}
              </button>
            ))}
          </div>
        ) : (
          items.map((it, i) =>
            it.kind === "user" ? (
              <div key={i} className="aimsg aimsg--user">
                {it.text}
              </div>
            ) : it.kind === "assistant" ? (
              <div key={i} className="aimsg aimsg--ai">
                {it.text}
              </div>
            ) : it.kind === "tool" ? (
              <ToolStep key={i} name={it.name} input={it.input} result={it.result} />
            ) : (
              <div key={i} className="aimsg aimsg--error" role="alert">
                <Icon name="warning" size={14} /> {it.text}
              </div>
            ),
          )
        )}
        {busy && <div className="aithinking" aria-live="polite">Working…</div>}
      </div>
      <form
        className="assistant__compose"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={box}
          className="assistant__input"
          rows={2}
          value={text}
          placeholder={providers.length ? "Describe a part or a change…" : "Set up a provider first"}
          disabled={!providers.length}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape") close();
          }}
        />
        {busy ? (
          <button type="button" className="btn btn--small" onClick={stopAssistant}>
            Stop
          </button>
        ) : (
          <button type="submit" className="iconbtn assistant__send" disabled={!text.trim() || !providers.length} aria-label="Send">
            <Icon name="send" size={16} />
          </button>
        )}
      </form>
    </aside>
  );
}

/* ───────────────────────────── Settings tab ───────────────────────────── */

function ProviderEditor({ p, onChange, onRemove }: { p: ProviderConfig; onChange: (p: ProviderConfig) => void; onRemove: () => void }) {
  return (
    <div className="provider">
      <div className="provider__head">
        <b>{p.label}</b>
        <small className="muted">{p.kind === "anthropic" ? "Anthropic API" : "OpenAI-compatible"}</small>
        <span className="assistant__spacer" />
        <button className="iconbtn iconbtn--small" title="Remove" onClick={onRemove}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      {p.kind === "openai" && <TextField label="Endpoint" value={p.baseUrl} placeholder="https://…/v1" onChange={(v) => onChange({ ...p, baseUrl: v })} type="url" />}
      <TextField label="Model" value={p.model} placeholder={p.kind === "anthropic" ? "claude-opus-5-5" : "e.g. gpt-…, qwen2.5:14b"} onChange={(v) => onChange({ ...p, model: v.trim() })} />
      <TextField label="API key" type="password" value={p.apiKey} placeholder={p.kind === "anthropic" ? "sk-ant-…" : "Leave empty for local servers"} onChange={(v) => onChange({ ...p, apiKey: v.trim() })} autoComplete="off" />
    </div>
  );
}

export function AssistantSettings() {
  const platform = useApp((s) => s.platform);
  const settings = useAi((s) => s.settings);
  const [preset, setPreset] = useState("");
  const update = (p: ProviderConfig) => saveAiSettings({ ...settings, providers: settings.providers.map((x) => (x.id === p.id ? p : x)) });
  const add = (id: string) => {
    const pr = PRESETS.find((x) => x.id === id);
    if (!pr) return;
    const p: ProviderConfig = { id: uid("ai"), label: pr.label, kind: pr.kind, baseUrl: pr.baseUrl, model: pr.model, apiKey: "" };
    saveAiSettings({ providers: [...settings.providers, p], active: settings.active ?? p.id });
    setPreset("");
  };
  return (
    <div className="settings__section">
      <h3 className="eyebrow">AI assistant</h3>
      <p className="muted small">
        The assistant designs and edits models with Whittle's own tools, so its work is ordinary, editable features you can undo. {platform.kind === "server" ? "Your settings and keys are kept in your account on this server (the database)" : "Keys are stored only on this device"} and
        sent only to the provider you choose.
      </p>
      {settings.providers.length > 1 && (
        <Select
          label="Use"
          value={settings.active ?? settings.providers[0]!.id}
          options={settings.providers.map((p) => ({ value: p.id, label: p.label, hint: p.model }))}
          onChange={(v) => saveAiSettings({ ...settings, active: v })}
        />
      )}
      {settings.providers.map((p) => (
        <ProviderEditor
          key={p.id}
          p={p}
          onChange={update}
          onRemove={() =>
            void confirmDialog({ title: `Remove ${p.label}?`, message: "Its settings and key are removed from your saved settings.", confirmLabel: "Remove", danger: true }).then(
              (ok) =>
                ok &&
                saveAiSettings({
                  providers: settings.providers.filter((x) => x.id !== p.id),
                  active: settings.active === p.id ? (settings.providers.find((x) => x.id !== p.id)?.id ?? null) : settings.active,
                }),
            )
          }
        />
      ))}
      <Select
        label="Add a provider"
        value={preset}
        placeholder="Choose…"
        options={PRESETS.map((p) => ({ value: p.id, label: p.label, hint: p.blurb }))}
        onChange={(v) => add(v)}
      />
    </div>
  );
}
