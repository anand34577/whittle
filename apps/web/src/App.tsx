import { useEffect } from "react";
import { commandById, commandForKey, isAvailable } from "./state/commands";
import { openDroppedFile, startAutosave, startDesktop } from "./state/files";
import { apiHooks, detectPlatform } from "./state/platform";
import { startKernel } from "./state/kernel";
import { cancelSession, commitSession, finishSketch, setSketchTool, toast, useApp } from "./state/store";
import { Browser } from "./ui/Browser";
import { CommandPalette, StatusBar, TitleBar, Toasts, Toolbar } from "./ui/Chrome";
import { AccountDialog, SignIn, UsersDialog } from "./ui/Account";
import { Coach, ExportDialog, ParamsDialog, ShortcutsDialog, VersionsDialog, Welcome } from "./ui/Dialogs";
import { PartsDialog } from "./ui/PartsDialog";
import { PropertiesPanel } from "./ui/PropertiesPanel";
import { Timeline } from "./ui/Timeline";
import { ViewportView, sketchKeys } from "./ui/ViewportView";

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

function onKey(e: KeyboardEvent) {
  const s = useApp.getState();
  const p = s.platform;
  if (p.kind === "server" && p.config.auth === "required" && !p.user) return; // sign-in screen is up
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    useApp.setState({ panel: s.panel === "palette" ? null : "palette" });
    return;
  }
  if (s.panel || isTyping(e)) return;

  // Sketch tools get first go (typed dimensions, Esc, Enter, Backspace).
  if (sketchKeys.handle?.(e)) {
    e.preventDefault();
    return;
  }
  if (!mod && sketchKeys.typeDigit?.(e.key)) {
    e.preventDefault();
    return;
  }

  if (e.key === "Escape") {
    if (s.radial) useApp.setState({ radial: null });
    else if (s.mode.kind === "measure") useApp.setState({ mode: { kind: "model" }, measure: [] });
    else if (s.mode.kind === "sketch") {
      if (s.mode.tool !== "select") setSketchTool("select");
      else finishSketch();
    } else if (s.mode.kind === "pickPlane") useApp.setState({ mode: { kind: "model" } });
    else if (s.session) cancelSession();
    else useApp.setState({ selection: [] });
    return;
  }
  if (e.key === "Enter" && s.session && s.mode.kind === "model") {
    commitSession();
    return;
  }

  const id = commandForKey(e, s);
  if (!id) return;
  const c = commandById(id);
  if (!isAvailable(c, s)) return;
  e.preventDefault();
  c.run();
}

export function App() {
  const theme = useApp((s) => s.theme);
  const panel = useApp((s) => s.panel);
  const session = useApp((s) => s.session);
  const mode = useApp((s) => s.mode);
  const platform = useApp((s) => s.platform);
  const platformReady = useApp((s) => s.platformReady);
  const signedOut = platform.kind === "server" && platform.config.auth === "required" && !platform.user;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    startKernel();
    startAutosave();
    // Every launch opens on the start screen (new, open, recover, templates),
    // unless the desktop app was started by double-clicking a design.
    useApp.setState({ panel: "welcome" });
    apiHooks.unauthorized = () => {
      const p = useApp.getState().platform;
      if (p.kind === "server" && p.user) {
        useApp.setState({ platform: { ...p, user: null } });
        toast("warn", "Your session ended. Sign in again; your open design is still here.");
      }
    };
    void detectPlatform().then(async (platform) => {
      useApp.setState({ platform, platformReady: true });
      if (platform.kind === "desktop") await startDesktop();
      const err = new URLSearchParams(window.location.search).get("login_error");
      if (err) {
        toast("error", err);
        window.history.replaceState(null, "", window.location.pathname);
      }
    });
    window.addEventListener("keydown", onKey);
    const prevent = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) void openDroppedFile(f);
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const panelOpen = !!session || mode.kind === "sketch";

  return (
    <div className={`app ${panelOpen ? "has-session" : ""}`}>
      <TitleBar />
      <Toolbar />
      <Browser />
      <ViewportView />
      <PropertiesPanel />
      <Timeline />
      <StatusBar />
      <Coach />
      <Toasts />
      {panel === "palette" && <CommandPalette />}
      {panel === "params" && <ParamsDialog />}
      {panel === "export" && <ExportDialog />}
      {panel === "welcome" && platformReady && !signedOut && <Welcome />}
      {panel === "versions" && <VersionsDialog />}
      {panel === "account" && <AccountDialog />}
      {panel === "users" && <UsersDialog />}
      {signedOut && <SignIn />}
      {panel === "shortcuts" && <ShortcutsDialog />}
      {panel === "parts" && <PartsDialog />}
    </div>
  );
}