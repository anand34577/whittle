import { useApp } from "../state/store";

export type Tab = "appearance" | "workspace" | "navigation" | "assistant" | "about";

let startTab: Tab = "appearance";

/** Open Settings at a given tab. */
export function openSettings(tab: Tab = "appearance") {
  startTab = tab;
  useApp.setState({ panel: "settings" });
}

/** The tab Settings should open on (and forget it, so the next opening starts at the default). */
export function takeStartTab(): Tab {
  const t = startTab;
  startTab = "appearance";
  return t;
}
