import { describe, expect, it } from "vitest";
import { type Prefs, normalizePrefs } from "../src/state/prefs";

describe("preferences", () => {
  it("keeps known mouse layouts and falls back to the default for unknown ones", () => {
    const nav = (n: string) => normalizePrefs({ nav: n } as unknown as Partial<Prefs>).nav;
    expect(nav("middle-pan")).toBe("middle-pan");
    expect(nav("trackpad")).toBe("trackpad");
    expect(nav("something-else")).toBe("whittle");
  });

  it("falls back to Whittle's own keys for an unknown keyboard layout", () => {
    expect(normalizePrefs({ keys: "classic" }).keys).toBe("classic");
    expect(normalizePrefs({ keys: "other" } as unknown as Partial<Prefs>).keys).toBe("whittle");
  });

  it("checks for new versions unless switched off", () => {
    expect(normalizePrefs({}).updateCheck).toBe(true);
    expect(normalizePrefs({ updateCheck: false }).updateCheck).toBe(false);
  });
});
