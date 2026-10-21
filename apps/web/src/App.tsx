import { useEffect } from "react";
import { commandById, commandForKey, isAvailable } from "./state/commands";
import { openDroppedFile, startAutosave, startDesktop, startLaunchQueue } from "./state/files";
import { aiAvailable, apiHooks, detectPlatform } from "./state/platform";
import { startKernel } from "./state/kernel";
import { startOffline } from "./state/offline";
import { checkForUpdate } from "./state/updates";
import { forgetUserSettings, loadUserSettings } from "./state/userSettings";
import { cancelSession, commitSession, finishSketch, isNarrow, setSketchTool, toast, useApp } from "./state/store";
import { Browser } from "./ui/Browser";
import { CommandPalette, QuickBox, StatusBar, TitleBar, Toasts, Toolbar } from "./ui/Chrome";
import { AccountDialog, SignIn, UsersDialog } from "./ui/Account";
import { Coach, ExportDialog, ParamsDialog, ShortcutsDialog, VersionsDialog, Welcome } from "./ui/Dialogs";
import { DialogHost, TooltipLayer } from "./ui/DialogHost";
import { SettingsDialog } from "./ui/Settings";
import { AssistantPanel } from "./ui/Assistant";
import { applyPrefs, resolveTheme } from "./state/prefs";
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
  if (document.querySelector(".scrim--dialog")) return;
  // Space: tools and search right at the cursor, for what you are doing now.
  if (e.key === " " && !mod && !e.altKey && !isTyping(e) && !s.panel && !s.session) {
    e.preventDefault();
    useApp.setState({ panel: "quick" });
    return;
  }
  // Escape closes the open panel even when focus isn't inside it.
  if (s.panel && e.key === "Escape" && !isTyping(e)) {
    useApp.setState({ panel: null });
    return;
  }
  if (s.panel || isTyping(e)) return;
  // A drawer over the model closes with Escape, before Escape means anything for the model underneath.
  if (e.key === "Escape" && isNarrow() && s.browserOpen) {
    useApp.setState({ browserOpen: false });
    return;
  }

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
      // One step back at a time: the tool, then a constraint waiting for picks, then the selection, then the sketch itself.
      if (s.mode.tool !== "select") setSketchTool("select");
      else if (s.pendingConstraint) useApp.setState({ pendingConstraint: null });
      else if (s.sketchSel.length || s.selectedEntity) useApp.setState({ sketchSel: [], selectedEntity: null });
      else finishSketch();
    } else if (s.mode.kind === "pickPlane") useApp.setState({ mode: { kind: "model" } });
    else if (s.session) cancelSession();
    else useApp.setState({ selection: [] });
    return;
  }
  if (e.key === "Enter" && s.session && s.mode.kind === "model") {
    commitSession(true);
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
  const prefs = useApp((s) => s.prefs);
  const assistant = useApp((s) => s.assistant);
  const panel = useApp((s) => s.panel);
  const session = useApp((s) => s.session);
  const mode = useApp((s) => s.mode);
  const platform = useApp((s) => s.platform);
  const platformReady = useApp((s) => s.platformReady);
  const signedOut = platform.kind === "server" && platform.config.auth === "required" && !platform.user;

  useEffect(() => applyPrefs(prefs, theme), [prefs, theme]);

  // "Match system" follows the OS switching between light and dark.
  useEffect(() => {
    if (prefs.theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const on = () => useApp.setState({ theme: resolveTheme("system") });
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [prefs.theme]);

  useEffect(() => {
    startKernel();
    startAutosave();
    startOffline();
    startLaunchQueue();
    // Every launch opens on the start screen (new, open, recover, templates),
    // unless the desktop app was started by double-clicking a design.
    useApp.setState({ panel: "welcome" });
    apiHooks.unauthorized = () => {
      const p = useApp.getState().platform;
      if (p.kind === "server" && p.user) {
        useApp.setState({ platform: { ...p, user: null } });
        forgetUserSettings();
        toast("warn", "Your session ended. Sign in again; your open design is still here.");
      }
    };
    void detectPlatform().then(async (platform) => {
      useApp.setState({ platform, platformReady: true });
      void loadUserSettings();
      if (platform.kind === "desktop") {
        await startDesktop();
        void checkForUpdate();
      }
      const err = new URLSearchParams(window.location.search).get("login_error");
      if (err) {
        toast("error", err);
        window.history.replaceState(null, "", window.location.pathname);
      }
      if (new URLSearchParams(window.location.search).get("linked") === "1") {
        toast("ok", "Single sign-on is linked to your account.");
        window.history.replaceState(null, "", window.location.pathname);
      }
    });
    window.addEventListener("keydown", onKey);
    // The browser's own context menu never appears inside the app (text fields keep theirs).
    const noMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!(t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) e.preventDefault();
    };
    window.addEventListener("contextmenu", noMenu);
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
      window.removeEventListener("contextmenu", noMenu);
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const editing = !!session || mode.kind === "sketch";
  const browserOpen = useApp((s) => s.browserOpen);
  const sideOpen = useApp((s) => s.panelOpen);

  // On narrow windows the properties drawer opens by itself when a feature or sketch needs it, so the editor is never
  // hidden, and closes again when the editing ends, so it doesn't sit over the model.
  useEffect(() => {
    if (isNarrow()) useApp.setState(editing ? { panelOpen: true, browserOpen: false } : { panelOpen: false });
  }, [editing]);
  // Crossing the breakpoint: drawers start closed when narrow, columns open when wide.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1100px)");
    const on = () => useApp.setState({ browserOpen: !mq.matches, panelOpen: !mq.matches });
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  return (
    <div className={`app ${editing ? "has-session" : ""} ${prefs.hints ? "" : "no-hints"} ${browserOpen ? "browser-open" : "browser-closed"} ${sideOpen ? "panel-open" : "panel-closed"}`}>
      {(browserOpen || (sideOpen && !editing)) && <div className="app__drawer-scrim" onClick={() => useApp.setState({ browserOpen: false, panelOpen: false })} />}
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
      {panel === "quick" && <QuickBox />}
      {panel === "params" && <ParamsDialog />}
      {panel === "export" && <ExportDialog />}
      {panel === "welcome" && platformReady && !signedOut && <Welcome />}
      {panel === "versions" && <VersionsDialog />}
      {panel === "account" && <AccountDialog />}
      {panel === "users" && <UsersDialog />}
      {signedOut && <SignIn />}
      {panel === "shortcuts" && <ShortcutsDialog />}
      {panel === "parts" && <PartsDialog />}
      {panel === "settings" && <SettingsDialog />}
      {assistant && !signedOut && aiAvailable(platform) && <AssistantPanel />}
      <DialogHost />
      <TooltipLayer />
    </div>
  );
}