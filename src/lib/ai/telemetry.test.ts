// Telemetry-free assertion (AI_INTEGRATION_PLAN.md Stage 5).
//
// The app's no-telemetry contract: turning the AI tier on must NOT cause
// any data to leave the device. AI inference goes through Tauri's local
// IPC (`invoke`) — never the network. This test exercises every AI code
// path at every non-Off tier with all browser network primitives stubbed,
// and asserts none of them are ever touched.
//
// If a future change routes AI through `fetch` (a remote model download,
// cloud inference, analytics ping, ...) this test fails immediately.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AiTier } from "./types";

// `vi.mock` factories are hoisted above all imports, so anything they
// reference must be created with `vi.hoisted` (also hoisted). This holder
// carries the fake IPC channel and the test-controlled AI tier.
const h = vi.hoisted(() => ({
  // `invoke` is local IPC, not network — the ALLOWED transport. Mocked to
  // return benign shapes so the AI code paths run to completion.
  invokeMock: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "ai_classify_leak":
        return { class: "steady", confidence: 0.9 };
      case "ai_classify_process":
        return { category: "other", confidence: 0.5 };
      case "ai_classify_project_folder":
        return { category: null, confidence: null };
      default:
        return null;
    }
  }),
  tier: "off" as AiTier,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invokeMock }));
vi.mock("../settings", () => ({
  getSettings: () => ({ aiTier: h.tier }),
}));

import {
  tryClassifyLeak,
  tryClassifyProcess,
  tryClassifyProjectFolder,
  tryEmbedText,
} from "./tierGate";

// --- Network-primitive spies ----------------------------------------------
const fetchSpy = vi.fn(() => {
  throw new Error("network call attempted via fetch()");
});
const xhrOpenSpy = vi.fn(() => {
  throw new Error("network call attempted via XMLHttpRequest");
});
const sendBeaconSpy = vi.fn(() => {
  throw new Error("network call attempted via navigator.sendBeacon");
});
const wsSpy = vi.fn(() => {
  throw new Error("network call attempted via WebSocket");
});

beforeEach(() => {
  h.invokeMock.mockClear();
  fetchSpy.mockClear();
  xhrOpenSpy.mockClear();
  sendBeaconSpy.mockClear();
  wsSpy.mockClear();

  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  globalThis.WebSocket = class {
    constructor() { wsSpy(); }
  } as unknown as typeof WebSocket;
  if (typeof XMLHttpRequest !== "undefined") {
    XMLHttpRequest.prototype.open = xhrOpenSpy as unknown as XMLHttpRequest["open"];
  }
  if (typeof navigator !== "undefined") {
    (navigator as { sendBeacon?: unknown }).sendBeacon = sendBeaconSpy;
  }
});

function assertNoNetwork() {
  expect(fetchSpy, "fetch").not.toHaveBeenCalled();
  expect(xhrOpenSpy, "XMLHttpRequest").not.toHaveBeenCalled();
  expect(sendBeaconSpy, "sendBeacon").not.toHaveBeenCalled();
  expect(wsSpy, "WebSocket").not.toHaveBeenCalled();
}

/** Run every AI entry point exposed to the app. */
async function exerciseEveryAiPath() {
  await tryClassifyLeak([100, 110, 120, 130, 140, 150]);
  await tryClassifyProcess("chrome.exe");
  await tryClassifyProjectFolder("C:\\dev\\app");
  await tryEmbedText(["some text"]);
}

describe("AI subsystem makes no network calls", () => {
  for (const tier of ["lite", "standard", "enhanced"] as const) {
    it(`does not touch any network primitive at the "${tier}" tier`, async () => {
      h.tier = tier;
      await exerciseEveryAiPath();
      assertNoNetwork();
    });

    it(`routes classification through local IPC (not network) at "${tier}"`, async () => {
      h.tier = tier;
      await tryClassifyLeak([100, 120, 140, 160, 180, 200]);
      // The classifier ran — and it ran over Tauri's local invoke channel.
      expect(h.invokeMock).toHaveBeenCalledWith(
        "ai_classify_leak",
        expect.anything(),
      );
      assertNoNetwork();
    });
  }

  it("makes neither network calls nor IPC calls when the tier is Off", async () => {
    h.tier = "off";
    await exerciseEveryAiPath();
    assertNoNetwork();
    // Off means the gate short-circuits before any backend call at all.
    expect(h.invokeMock).not.toHaveBeenCalled();
  });

  it("falls back to null (never throws) if the IPC backend is unavailable", async () => {
    h.tier = "lite";
    h.invokeMock.mockRejectedValueOnce(new Error("backend not ready"));
    await expect(tryClassifyLeak([1, 2, 3])).resolves.toBeNull();
    assertNoNetwork();
  });
});
