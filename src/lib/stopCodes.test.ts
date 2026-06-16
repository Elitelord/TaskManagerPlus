import { describe, it, expect } from "vitest";
import { lookupStopCode } from "./stopCodes";

describe("lookupStopCode", () => {
  it("resolves a known code regardless of padding/case", () => {
    const a = lookupStopCode("0x0000007E");
    expect(a?.name).toBe("SYSTEM_THREAD_EXCEPTION_NOT_HANDLED");
    expect(a?.code).toBe("0x0000007E");
    // Short + lowercase form maps to the same entry.
    expect(lookupStopCode("0x7e")?.name).toBe(a?.name);
    expect(lookupStopCode("7E")?.name).toBe(a?.name);
  });

  it("handles the wide status-code form", () => {
    const s = lookupStopCode("0xC000021A");
    expect(s?.name).toBe("STATUS_SYSTEM_PROCESS_TERMINATED");
    expect(s?.code).toBe("0xC000021A");
  });

  it("maps shadow 0x1000xxxx codes down to their base code", () => {
    expect(lookupStopCode("0x1000007E")?.code).toBe("0x0000007E");
    expect(lookupStopCode("0x1000007E")?.name).toBe("SYSTEM_THREAD_EXCEPTION_NOT_HANDLED");
  });

  it("carries presentation + class for the card", () => {
    expect(lookupStopCode("0x9F")?.presentation).toBe("hang");
    expect(lookupStopCode("0x9F")?.klass).toBe("power");
    expect(lookupStopCode("0x116")?.klass).toBe("gpu");
    expect(lookupStopCode("0x0000007E")?.presentation).toBe("bluescreen");
  });

  it("returns null for unknown or empty input", () => {
    expect(lookupStopCode("0xDEADBEEF")).toBeNull();
    expect(lookupStopCode(null)).toBeNull();
    expect(lookupStopCode(undefined)).toBeNull();
    expect(lookupStopCode("nonsense")).toBeNull();
  });
});
