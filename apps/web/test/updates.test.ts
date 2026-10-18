/** Telling whether a release is newer than the running app. */
import { describe, expect, it } from "vitest";
import { isNewer } from "../src/state/updates";

describe("new versions", () => {
  it("compares versions number by number", () => {
    expect(isNewer("v0.11.0", "0.10.0")).toBe(true);
    expect(isNewer("v0.10.10", "0.10.9")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("v0.10.0", "0.10.0")).toBe(false);
    expect(isNewer("v0.9.9", "0.10.0")).toBe(false);
  });
  it("ignores pre-releases and tags that aren't versions", () => {
    expect(isNewer("v0.11.0-beta.1", "0.10.0")).toBe(false);
    expect(isNewer("nightly", "0.10.0")).toBe(false);
  });
});
