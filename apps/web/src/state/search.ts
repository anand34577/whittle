/** How the command search ranks commands for what was typed. */
import { type Command, EVERYDAY_WORDS } from "./commands";
import { recentCommands } from "./learn";

/** Small words that carry no meaning in a search ("make it hollow" is about "hollow"). */
const FILLER = new Set(["a", "an", "the", "it", "its", "this", "that", "to", "of", "on", "in", "as", "and", "or", "my", "me", "i", "do", "make", "want", "how", "with", "for", "into", "some", "be", "is", "can", "please", "add"]);
/** "corners" finds "corner", "rounded" finds "round", "colour" finds "color". */
const stem = (w: string) => w.replace(/our$/, "or").replace(/(ing|ed|es|s)$/, "") || w;

/**
 * Whole words beat word starts, which beat letters inside a word ("round" finds Fillet before Ground). Filler words
 * are ignored and not every word has to match, so an everyday phrase still finds something (audit U-17).
 * `recentList`: the recent-command list, read once per search rather than once per command (audit UI-1).
 */
export function score(c: Pick<Command, "id" | "label" | "keywords" | "group" | "hint">, q: string, recentList: string[] = recentCommands()): number {
  if (!q) return 1;
  const label = c.label.toLowerCase();
  const labelWords = label.split(/[^a-z0-9]+/).filter(Boolean);
  const keyWords = `${c.keywords ?? ""} ${c.group}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const all = q.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
  const words = all.filter((w) => !FILLER.has(w));
  if (!words.length) words.push(...all);
  // The hint says what the command is for: a word found only there still counts, a little.
  const hintWords = (c.hint ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);
  const everyday = (EVERYDAY_WORDS[c.id] ?? "").split(" ").filter(Boolean).map(stem);
  let s = 0;
  let missed = 0;
  for (const w of words) {
    const st = stem(w);
    const starts = (x: string) => x.startsWith(w) || (st.length >= 3 && stem(x).startsWith(st));
    if (label.startsWith(w)) s += 8;
    else if (labelWords.some(starts)) s += 6;
    else if (keyWords.includes(w) || keyWords.some((x) => stem(x) === st)) s += 5;
    else if (keyWords.some(starts)) s += 3;
    else if (w.length >= 3 && (label.includes(w) || keyWords.some((x) => x.includes(w)))) s += 1;
    else if (hintWords.includes(st)) s += 1;
    else missed++;
    // The everyday words listed for a command are what people mean by it: they decide between close matches.
    if (everyday.includes(st)) s += 2;
  }
  if (missed === words.length) return 0;
  // Every word matching counts for more than a strong match on one of several.
  s = s - missed * 3 + (missed === 0 ? 2 : 0);
  if (s <= 0) return 0;
  const recent = recentList.indexOf(c.id);
  return s + (recent >= 0 ? 1.5 - recent * 0.15 : 0);
}

