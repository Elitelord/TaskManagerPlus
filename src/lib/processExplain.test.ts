import { describe, it, expect } from "vitest";
import {
  explainProcess,
  explainProcessGroup,
  classifyRunLocation,
  isLowInfoExplanation,
} from "./processExplain";

describe("classifyRunLocation", () => {
  it("buckets common locations", () => {
    expect(classifyRunLocation("C:\\Windows\\System32\\svchost.exe")).toBe("system");
    expect(classifyRunLocation("C:\\Program Files\\Google\\Chrome\\chrome.exe")).toBe("program-files");
    expect(classifyRunLocation("C:\\Program Files (x86)\\App\\a.exe")).toBe("program-files");
    expect(classifyRunLocation("C:\\Users\\me\\AppData\\Local\\Discord\\discord.exe")).toBe("appdata");
    expect(classifyRunLocation("C:\\Users\\me\\Downloads\\setup.exe")).toBe("downloads");
    expect(classifyRunLocation("C:\\$Recycle.Bin\\S-1-5\\x.exe")).toBe("recycle-bin");
    expect(classifyRunLocation("")).toBe("other");
  });

  it("treats AppData\\Local\\Temp as temp, not appdata", () => {
    expect(classifyRunLocation("C:\\Users\\me\\AppData\\Local\\Temp\\x.exe")).toBe("temp");
  });
});

describe("explainProcess", () => {
  it("explains core OS processes", () => {
    expect(explainProcess({ name: "csrss.exe" })).toMatch(/core windows/i);
  });

  it("explains system processes", () => {
    expect(explainProcess({ name: "svchost.exe" })).toMatch(/system process/i);
  });

  it("names the owner of a Chromium subprocess", () => {
    const txt = explainProcess({
      name: "chrome.exe",
      process_type: "renderer",
      product_name: "Google Chrome",
    });
    expect(txt).toMatch(/renderer process of google chrome/i);
  });

  it("explains a helper process", () => {
    const txt = explainProcess({ name: "AcmeHelper.exe", company_name: "Acme Inc" });
    expect(txt).toMatch(/helper for acme inc/i);
  });

  it("uses version-resource metadata when present", () => {
    expect(
      explainProcess({ name: "x.exe", product_name: "Foo App", company_name: "Acme Inc" }),
    ).toBe("Foo App — published by Acme Inc.");
    expect(explainProcess({ name: "x.exe", company_name: "Acme Inc" }))
      .toBe("Published by Acme Inc.");
  });

  it("falls back to run location when there is no metadata", () => {
    expect(
      explainProcess({ name: "bar.exe", image_path: "C:\\Program Files\\Bar\\bar.exe" }),
    ).toMatch(/installed desktop application/i);
    expect(
      explainProcess({ name: "sketchy.exe", image_path: "C:\\Users\\me\\Downloads\\sketchy.exe" }),
    ).toMatch(/downloads folder/i);
  });

  it("is honest when nothing is known", () => {
    expect(explainProcess({ name: "mystery.exe" })).toMatch(/no publisher information/i);
  });

  it("asGroup skips the subprocess label and describes the app itself", () => {
    // A renderer child, but explained as the group → the application line.
    const txt = explainProcess(
      { name: "chrome.exe", process_type: "renderer", product_name: "Google Chrome", company_name: "Google LLC" },
      { asGroup: true },
    );
    expect(txt).not.toMatch(/renderer/i);
    expect(txt).toMatch(/google chrome/i);
  });
});

describe("explainProcessGroup", () => {
  it("describes a system group as OS plumbing regardless of children", () => {
    const txt = explainProcessGroup([{ name: "whatever.exe" }], true);
    expect(txt).toMatch(/windows system process/i);
  });

  it("explains a browser group as the browser, not a random renderer tab", () => {
    // children[0] is a renderer — the old bug explained the group as that.
    const children = [
      { name: "chrome.exe", process_type: "renderer", product_name: "Google Chrome", company_name: "Google LLC" },
      { name: "chrome.exe", process_type: "gpu-process", product_name: "Google Chrome", company_name: "Google LLC" },
      { name: "chrome.exe", process_type: "", product_name: "Google Chrome", company_name: "Google LLC" },
    ];
    const txt = explainProcessGroup(children, false);
    expect(txt).not.toMatch(/renderer/i);
    expect(txt).toMatch(/google chrome.*google llc/i);
  });

  it("still works when no main process is present (all subprocesses)", () => {
    const children = [
      { name: "chrome.exe", process_type: "renderer", product_name: "Google Chrome", company_name: "Google LLC" },
      { name: "chrome.exe", process_type: "utility", product_name: "Google Chrome", company_name: "Google LLC" },
    ];
    const txt = explainProcessGroup(children, false);
    expect(txt).not.toMatch(/renderer|utility/i);
    expect(txt).toMatch(/google chrome/i);
  });

  it("handles an empty group", () => {
    expect(explainProcessGroup([], false)).toMatch(/several background processes/i);
  });
});

describe("isLowInfoExplanation (P5 gate)", () => {
  it("is true for an unknown exe with no metadata", () => {
    expect(isLowInfoExplanation({ name: "mystery.exe" })).toBe(true);
    expect(
      isLowInfoExplanation({ name: "tool.exe", image_path: "C:\\Tools\\tool.exe" }),
    ).toBe(true);
  });

  it("is false when the process carries publisher metadata", () => {
    expect(isLowInfoExplanation({ name: "x.exe", product_name: "Foo App" })).toBe(false);
    expect(isLowInfoExplanation({ name: "x.exe", company_name: "Acme Inc" })).toBe(false);
  });

  it("is false for OS / system processes (already classified)", () => {
    expect(isLowInfoExplanation({ name: "csrss.exe" })).toBe(false);
    expect(isLowInfoExplanation({ name: "svchost.exe" })).toBe(false);
  });

  it("is false for subprocesses and helpers (already have a role label)", () => {
    expect(isLowInfoExplanation({ name: "app.exe", process_type: "renderer" })).toBe(false);
    expect(isLowInfoExplanation({ name: "SomethingHelper.exe" })).toBe(false);
  });
});
