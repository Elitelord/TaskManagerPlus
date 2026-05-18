// Thin wrappers around the Tauri `ai_*` commands. Every call goes
// through `tierGate.ts` in normal app code — this file is the raw
// transport. Don't call these directly from UI components.

import { invoke } from "@tauri-apps/api/core";
import type { AiStatus, AiTier, LeakClassification } from "./types";

export async function aiGetStatus(): Promise<AiStatus> {
  return invoke<AiStatus>("ai_get_status");
}

export async function aiSetTier(tier: AiTier): Promise<AiStatus> {
  return invoke<AiStatus>("ai_set_tier", { tier });
}

export async function aiClassifyLeak(memorySeries: number[]): Promise<LeakClassification> {
  return invoke<LeakClassification>("ai_classify_leak", { memorySeries });
}
