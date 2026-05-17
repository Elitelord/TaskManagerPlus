import { describe, it, expect } from "vitest";
import { tierEnablesClassifiers, tierEnablesEmbeddings, AI_TIERS } from "./types";

describe("AI tier gates", () => {
  it("Off enables nothing — the 'AI is optional' contract", () => {
    expect(tierEnablesClassifiers("off")).toBe(false);
    expect(tierEnablesEmbeddings("off")).toBe(false);
  });

  it("Lite enables classifiers but not embeddings", () => {
    expect(tierEnablesClassifiers("lite")).toBe(true);
    expect(tierEnablesEmbeddings("lite")).toBe(false);
  });

  it("Standard and Enhanced enable both", () => {
    for (const tier of ["standard", "enhanced"] as const) {
      expect(tierEnablesClassifiers(tier)).toBe(true);
      expect(tierEnablesEmbeddings(tier)).toBe(true);
    }
  });

  it("every tier has a defined classifier gate", () => {
    // Guards against a new tier being added without updating the gates.
    for (const tier of AI_TIERS) {
      expect(typeof tierEnablesClassifiers(tier)).toBe("boolean");
      expect(typeof tierEnablesEmbeddings(tier)).toBe("boolean");
    }
  });
});
