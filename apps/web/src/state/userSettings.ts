/** Loads the person's saved preferences and assistant settings once we know where they live (see stored.ts). */
import { type AiSettings, NO_AI_SETTINGS, useAi } from "./ai";
import type { Prefs } from "./prefs";
import { adoptBrowserCopy, readStored, setStorageMode } from "./stored";
import { applyLoadedPrefs, useApp } from "./store";

export async function loadUserSettings() {
  const p = useApp.getState().platform;
  if (p.kind === "server") {
    if (p.config.auth === "required" && !p.user) return setStorageMode("pending"); // signed out: nothing to load
    setStorageMode("remote");
  } else {
    setStorageMode("local");
  }
  try {
    await adoptBrowserCopy("prefs");
    await adoptBrowserCopy("ai");
    const prefs = await readStored<Partial<Prefs>>("prefs");
    if (prefs) applyLoadedPrefs(prefs);
    const ai = await readStored<AiSettings>("ai");
    if (ai && Array.isArray(ai.providers)) useAi.setState({ settings: ai });
  } catch {
    /* the defaults stay; nothing is overwritten */
  }
}

/** On sign-out: nothing of the person (not even provider keys) stays in memory. */
export function forgetUserSettings() {
  setStorageMode("pending");
  useAi.setState({ settings: NO_AI_SETTINGS, items: [] });
}
