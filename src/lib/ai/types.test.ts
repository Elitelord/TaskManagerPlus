import { describe, it, expect } from "vitest";
import { tierEnablesEmbeddings, AI_TIERS } from "./types";

describe("AI tier gates", () => {
  it("Off enables no embedding features", () => {
    expect(tierEnablesEmbeddings("off")).toBe(false);
  });

  it("Standard and Enhanced enable embeddings", () => {
    expect(tierEnablesEmbeddings("standard")).toBe(true);
    expect(tierEnablesEmbeddings("enhanced")).toBe(true);
  });

  it("every tier has a defined embedding gate", () => {
    // Guards against a new tier being added without updating the gate.
    for (const tier of AI_TIERS) {
      expect(typeof tierEnablesEmbeddings(tier)).toBe("boolean");
    }
  });

  it("does not include the retired 'lite' tier", () => {
    // The leak classifier that 'lite' used to gate now runs at every tier;
    // the tier setting governs only the embedding model.
    expect(AI_TIERS).toEqual(["off", "standard", "enhanced"]);
  });
});
