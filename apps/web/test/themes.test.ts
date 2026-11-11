/** Every theme's muted text and accent buttons stay readable (audit V-2): WCAG AA, 4.5:1, for small text. */
import { describe, expect, it } from "vitest";
import { contrast, parseColor, themeTokens } from "./contrast";

const themes = themeTokens();
const base = themes.get("graphite")!;

describe("theme contrast", () => {
  for (const [name, own] of themes) {
    // Dark variants without their own accent use Graphite's.
    const v = { ...base, ...own };
    const c = (a: string, b: string) => contrast(parseColor(v[a]!)!, parseColor(v[b]!)!);
    it(`${name}: muted text on every panel`, () => {
      for (const bg of ["--bg-0", "--bg-1", "--bg-2"]) expect(c("--text-3", bg), `${name} text-3 on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: text on accent buttons`, () => {
      expect(c("--accent-ink", "--accent")).toBeGreaterThanOrEqual(4.5);
    });
  }
});
