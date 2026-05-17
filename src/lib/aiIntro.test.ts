import { describe, it, expect } from "vitest";
import { decideAiIntro, AI_INTRO_KEY } from "./aiIntro";

/** Minimal getItem-only stub backed by a plain object. */
function stubStorage(entries: Record<string, string>): Pick<Storage, "getItem"> {
  return { getItem: (k: string) => (k in entries ? entries[k] : null) };
}

describe("decideAiIntro", () => {
  it("shows the prompt to an existing user who finished onboarding", () => {
    const ls = stubStorage({ "taskmanagerplus-onboarding-completed": "1" });
    expect(decideAiIntro(ls)).toBe("show");
  });

  it("suppresses the prompt silently for a brand-new install", () => {
    const ls = stubStorage({});
    expect(decideAiIntro(ls)).toBe("mark-seen-silently");
  });

  it("does nothing once the prompt has already been seen", () => {
    const ls = stubStorage({
      [AI_INTRO_KEY]: "1",
      "taskmanagerplus-onboarding-completed": "1",
    });
    expect(decideAiIntro(ls)).toBe("already-seen");
  });

  it("treats the seen flag as authoritative even mid-onboarding", () => {
    const ls = stubStorage({ [AI_INTRO_KEY]: "1" });
    expect(decideAiIntro(ls)).toBe("already-seen");
  });
});
