import { describe, expect, it } from "vitest";
import { safeName } from "../src/state/files";

describe("safeName", () => {
  it("replaces what file systems refuse and trims the ends", () => {
    expect(safeName(String.raw`a/b\c:d*e?f"g<h>i|j`)).toBe("a-b-c-d-e-f-g-h-i-j");
    expect(safeName("  My part.  ")).toBe("My part");
    expect(safeName("...")).toBe("design");
    expect(safeName("")).toBe("design");
    expect(safeName("tab\there")).toBe("tab-here");
  });

  it("avoids the names Windows reserves, and very long ones", () => {
    expect(safeName("CON")).toBe("CON design");
    expect(safeName("nul.txt")).toBe("nul.txt design");
    expect(safeName("COM1")).toBe("COM1 design");
    expect(safeName("console")).toBe("console");
    expect(safeName("x".repeat(500))).toHaveLength(120);
  });
});
