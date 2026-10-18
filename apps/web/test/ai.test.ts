import { describe, expect, it } from "vitest";
import { unreachable } from "../src/state/ai";

describe("model server errors", () => {
  it("explains that an HTTPS page can't call a plain-HTTP server on the network", () => {
    expect(unreachable("http://172.17.20.16:11435/v1", "https://cad.example.com/")).toMatch(/served over HTTPS/);
  });
  it("lets HTTPS pages call this computer, and points at server settings otherwise", () => {
    expect(unreachable("http://localhost:11434/v1", "https://cad.example.com/")).toMatch(/OLLAMA_ORIGINS/);
    expect(unreachable("http://172.17.20.16:11435/v1", "http://172.17.20.5:8080/")).toMatch(/OLLAMA_HOST/);
  });
  it("catches a mistyped address", () => {
    expect(unreachable("172.17.20.16:11435", "http://x/")).toMatch(/valid address/);
  });
});
