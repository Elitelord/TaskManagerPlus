import { describe, it, expect } from "vitest";
import { tierEnablesEmbeddings, tierEnablesGenerative, AI_TIERS } from "./types";

describe("AI tier gates", () => {
  it("Off enables nothing", () => {
    expect(tierEnablesEmbeddings("off")).toBe(false);
    expect(tierEnablesGenerative("off")).toBe(false);
  });

  it("Standard enables embeddings but not generative", () => {
    expect(tierEnablesEmbeddings("standard")).toBe(true);
    expect(tierEnablesGenerative("standard")).toBe(false);
  });

  it("Enhanced enables both embeddings and generative (superset)", () => {
    expect(tierEnablesEmbeddings("enhanced")).toBe(true);
    expect(tierEnablesGenerative("enhanced")).toBe(true);
  });

  it("every tier has defined gates", () => {
    for (const tier of AI_TIERS) {
      expect(typeof tierEnablesEmbeddings(tier)).toBe("boolean");
      expect(typeof tierEnablesGenerative(tier)).toBe("boolean");
    }
  });

  it("is off + standard + enhanced ('enhanced' reused for the generative add-on)", () => {
    // 'lite' collapsed into 'off' (S-8). 'enhanced' originally meant a larger
    // embedding model (killed by S-13/S-14); the name is now the generative
    // tier (Standard + on-device writing model).
    expect(AI_TIERS).toEqual(["off", "standard", "enhanced"]);
  });
});
