import { describe, expect, it } from "vitest";
import { type Prefs, normalizePrefs } from "../src/state/prefs";

describe("preferences", () => {
  it("carries mouse layouts saved under their old names over to the new ones", () => {
    const old = (nav: string) => normalizePrefs({ nav } as unknown as Partial<Prefs>).nav;
    expect(old("fusion")).toBe("middle-pan");
    expect(old("solidworks")).toBe("middle-orbit");
    expect(old("blender")).toBe("middle-orbit-shift");
    expect(old("onshape")).toBe("right-orbit");
    expect(old("trackpad")).toBe("trackpad");
    expect(old("something-else")).toBe("whittle");
  });

  it("falls back to Whittle's own keys for an unknown keyboard layout", () => {
    expect(normalizePrefs({ keys: "classic" }).keys).toBe("classic");
    expect(normalizePrefs({ keys: "other" } as unknown as Partial<Prefs>).keys).toBe("whittle");
  });
});
