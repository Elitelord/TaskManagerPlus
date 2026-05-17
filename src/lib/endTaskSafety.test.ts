import { describe, it, expect } from "vitest";
import { classifyEndTaskSafety, endTaskWarning } from "./endTaskSafety";

describe("classifyEndTaskSafety", () => {
  it("flags OS-core processes as critical", () => {
    for (const name of [
      "csrss.exe", "wininit.exe", "lsass.exe", "services.exe",
      "smss.exe", "winlogon.exe", "System", "Registry",
    ]) {
      expect(classifyEndTaskSafety({ name }), name).toBe("critical");
    }
  });

  it("flags session/desktop processes as caution", () => {
    for (const name of ["svchost.exe", "dwm.exe", "explorer.exe", "ctfmon.exe"]) {
      expect(classifyEndTaskSafety({ name }), name).toBe("caution");
    }
  });

  it("treats ordinary applications as normal", () => {
    for (const name of ["chrome.exe", "Code.exe", "discord.exe", "spotify.exe"]) {
      expect(classifyEndTaskSafety({ name }), name).toBe("normal");
    }
  });

  it("name matching is case-insensitive", () => {
    expect(classifyEndTaskSafety({ name: "LSASS.EXE" })).toBe("critical");
    expect(classifyEndTaskSafety({ name: "Dwm.exe" })).toBe("caution");
  });

  it("metadata promotes an unlisted Microsoft System32 binary to caution", () => {
    // A process not in any hardcoded set, but clearly OS plumbing.
    const safety = classifyEndTaskSafety({
      name: "someunlistedsvc.exe",
      company_name: "Microsoft Corporation",
      image_path: "C:\\Windows\\System32\\someunlistedsvc.exe",
    });
    expect(safety).toBe("caution");
  });

  it("does not promote a third-party app even if it lives under Windows", () => {
    const safety = classifyEndTaskSafety({
      name: "randomtool.exe",
      company_name: "Some Vendor LLC",
      image_path: "C:\\Windows\\System32\\randomtool.exe",
    });
    expect(safety).toBe("normal");
  });

  it("does not promote a Microsoft app outside system directories", () => {
    // e.g. VS Code — Microsoft-published but a normal app, safe to end.
    const safety = classifyEndTaskSafety({
      name: "code.exe",
      company_name: "Microsoft Corporation",
      image_path: "C:\\Users\\me\\AppData\\Local\\Programs\\VS Code\\Code.exe",
    });
    expect(safety).toBe("normal");
  });

  it("falls back to name-only classification when metadata is absent", () => {
    expect(classifyEndTaskSafety({ name: "csrss.exe" })).toBe("critical");
    expect(classifyEndTaskSafety({ name: "chrome.exe" })).toBe("normal");
  });
});

describe("endTaskWarning", () => {
  it("returns a warning for critical and caution, null for normal", () => {
    expect(endTaskWarning("critical")).toMatch(/crash|freeze/i);
    expect(endTaskWarning("caution")).toMatch(/system process/i);
    expect(endTaskWarning("normal")).toBeNull();
  });
});
