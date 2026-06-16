import { describe, it, expect } from "vitest";
import {
  isStale,
  keyDrivers,
  staleDrivers,
  oemSupportLink,
  healthSignature,
} from "./systemHealth";
import type { DriverInfo } from "./crashEvents";

const now = new Date("2026-06-15T12:00:00").getTime();
const at = (d: string) => new Date(d).getTime();

const drivers: DriverInfo[] = [
  { class: "storage", name: "Samsung SSD", version: "5.1", dateMs: at("2026-05-01") },
  { class: "gpu", name: "AMD Radeon 890M", version: "32.0", dateMs: at("2026-03-01") },
  { class: "wifi", name: "MediaTek MT7922", version: "3.4", dateMs: at("2024-06-30") }, // ~2yr → stale
  { class: "usb", name: "USB Root Hub", version: "10.0", dateMs: at("2020-01-01") }, // not a key class
];

describe("isStale", () => {
  it("flags drivers older than the threshold", () => {
    expect(isStale(at("2024-06-30"), now)).toBe(true);
    expect(isStale(at("2026-03-01"), now)).toBe(false);
    expect(isStale(null, now)).toBe(false);
  });
});

describe("keyDrivers", () => {
  it("keeps only crash-relevant classes, ordered", () => {
    const k = keyDrivers(drivers);
    expect(k.map((d) => d.class)).toEqual(["gpu", "wifi", "storage"]);
    expect(k.some((d) => d.class === "usb")).toBe(false);
  });
});

describe("staleDrivers", () => {
  it("returns only the out-of-date key drivers", () => {
    const s = staleDrivers(drivers, now);
    expect(s).toHaveLength(1);
    expect(s[0].name).toContain("MT7922");
  });

  it("never flags a Windows-inbox driver, however old", () => {
    const withInbox: DriverInfo[] = [
      ...drivers,
      { class: "storage", name: "Disk drive", version: "10.0", dateMs: at("2006-06-21"), provider: "Microsoft" },
    ];
    const s = staleDrivers(withInbox, now);
    // Still just the MediaTek — the 2006 Microsoft disk driver is excluded.
    expect(s.map((d) => d.name)).toEqual(["MediaTek MT7922"]);
  });
});

describe("oemSupportLink", () => {
  it("maps known manufacturers", () => {
    expect(oemSupportLink("ASUSTeK COMPUTER INC.")?.url).toContain("asus.com");
    expect(oemSupportLink("Dell Inc.")?.label).toContain("Dell");
    expect(oemSupportLink("HP")?.url).toContain("hp.com");
  });
  it("returns null for unknown manufacturers", () => {
    expect(oemSupportLink("Some Whitebox OEM")).toBeNull();
  });
});

describe("healthSignature", () => {
  it("is non-empty and changes when the stale set changes", () => {
    const sig = healthSignature(drivers, now);
    expect(sig.length).toBeGreaterThan(0);
    // Updating the stale Wi-Fi driver changes the signature.
    const fixed = drivers.map((d) =>
      d.class === "wifi" ? { ...d, dateMs: at("2026-06-01") } : d,
    );
    expect(healthSignature(fixed, now)).not.toBe(sig);
  });
});
