import { describe, it, expect } from "vitest";
import { flagSuspiciousProcess } from "./processSuspicion";

describe("flagSuspiciousProcess", () => {
  it("does not flag an ordinary installed application", () => {
    const v = flagSuspiciousProcess({
      name: "chrome.exe",
      image_path: "C:\\Program Files\\Google\\Chrome\\chrome.exe",
      company_name: "Google LLC",
    });
    expect(v.unusual).toBe(false);
    expect(v.reasons).toEqual([]);
  });

  it("never flags Windows system processes", () => {
    expect(flagSuspiciousProcess({ name: "svchost.exe" }).unusual).toBe(false);
    expect(
      flagSuspiciousProcess({
        name: "x.exe",
        image_path: "C:\\Windows\\System32\\x.exe",
      }).unusual,
    ).toBe(false);
  });

  it("flags a process running from Downloads", () => {
    const v = flagSuspiciousProcess({
      name: "setup.exe",
      image_path: "C:\\Users\\me\\Downloads\\setup.exe",
      company_name: "Some Vendor",
    });
    expect(v.unusual).toBe(true);
    expect(v.reasons[0]).toMatch(/downloads folder/i);
  });

  it("flags a process running from a temp folder", () => {
    const v = flagSuspiciousProcess({
      name: "x.exe",
      image_path: "C:\\Users\\me\\AppData\\Local\\Temp\\x.exe",
    });
    expect(v.unusual).toBe(true);
    expect(v.reasons[0]).toMatch(/temporary folder/i);
  });

  it("flags a process running from the Recycle Bin", () => {
    const v = flagSuspiciousProcess({
      name: "x.exe",
      image_path: "C:\\$Recycle.Bin\\S-1-5-21\\x.exe",
    });
    expect(v.unusual).toBe(true);
    expect(v.reasons[0]).toMatch(/recycle bin/i);
  });

  it("adds a no-publisher reason as a compounding factor", () => {
    const v = flagSuspiciousProcess({
      name: "x.exe",
      image_path: "C:\\Users\\me\\Downloads\\x.exe",
    });
    expect(v.unusual).toBe(true);
    expect(v.reasons).toHaveLength(2);
    expect(v.reasons[1]).toMatch(/no publisher information/i);
  });

  it("does not add the no-publisher reason on its own", () => {
    // No metadata, but a normal install location — not flagged at all.
    const v = flagSuspiciousProcess({
      name: "x.exe",
      image_path: "C:\\Program Files\\X\\x.exe",
    });
    expect(v.unusual).toBe(false);
  });
});
