import { describe, it, expect } from "vitest";
import { tierEnablesEmbeddings, AI_TIERS } from "./types";

describe("AI tier gates", () => {
  it("Off enables no embedding features", () => {
    expect(tierEnablesEmbeddings("off")).toBe(false);
  });

  it("Standard enables embeddings", () => {
    expect(tierEnablesEmbeddings("standard")).toBe(true);
  });

  it("every tier has a defined embedding gate", () => {
    // Guards against a new tier being added without updating the gate.
    for (const tier of AI_TIERS) {
      expect(typeof tierEnablesEmbeddings(tier)).toBe("boolean");
    }
  });

  it("is just off + standard (retired 'lite' and 'enhanced' tiers gone)", () => {
    // 'lite' collapsed into 'off' (S-8); 'enhanced' collapsed into
    // 'standard' (S-13/S-14 — a larger model didn't beat bge-small).
    expect(AI_TIERS).toEqual(["off", "standard"]);
  });
});
