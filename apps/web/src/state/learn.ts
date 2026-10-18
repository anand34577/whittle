/**
 * Learning as you go, like an IDE's key promoter: the second time a tool with a shortcut is
 * clicked, a tip names its key (once per tool). Also the recently used commands, for the palette.
 */
import type { Command } from "./commands";
import { toast, useApp } from "./store";

const read = (k: string): string[] => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? "[]");
  } catch {
    return [];
  }
};
const write = (k: string, v: string[]) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode: tips just repeat next time */
  }
};

const clicks = new Map<string, number>();

/** A tool was clicked with the mouse. */
export function noteClick(c: Command) {
  noteRun(c.id);
  if (!c.keys || !useApp.getState().prefs.hints) return;
  const n = (clicks.get(c.id) ?? 0) + 1;
  clicks.set(c.id, n);
  const told = read("whittle.keyTips");
  if (n < 2 || told.includes(c.id)) return;
  write("whittle.keyTips", [...told, c.id]);
  toast("info", `Tip: press ${c.keys} for ${c.label}, no need to reach for the toolbar.`);
}

/** Most recent first, at most eight. */
export function recentCommands(): string[] {
  return read("whittle.recent");
}

export function noteRun(id: string) {
  write("whittle.recent", [id, ...recentCommands().filter((x) => x !== id)].slice(0, 8));
}
