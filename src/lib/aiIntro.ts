// First-run "what's new: on-device AI" prompt — gating logic.
//
// The AI tier setting ships in a release that previous versions did not
// have. We want to tell *existing* users (who are upgrading from a non-AI
// build) that the setting now exists — once — without nagging brand-new
// installs, who meet the AI tier naturally in Settings and via the
// onboarding tour.
//
// Signal for "existing user": the onboarding tour has been completed or
// skipped (`taskmanagerplus-onboarding-completed === "1"`). A brand-new
// install has not got that flag yet at first launch.

export const AI_INTRO_KEY = "taskmanagerplus-ai-intro-seen";
const ONBOARDING_KEY = "taskmanagerplus-onboarding-completed";

export type AiIntroDecision =
  | "show"                  // existing user upgrading — show the prompt
  | "mark-seen-silently"    // brand-new install — suppress without showing
  | "already-seen";         // prompt already shown once — do nothing

/**
 * Decide whether to show the AI intro prompt. Pure — takes a storage-like
 * object so it is trivially unit-testable.
 */
export function decideAiIntro(ls: Pick<Storage, "getItem">): AiIntroDecision {
  if (ls.getItem(AI_INTRO_KEY) === "1") return "already-seen";
  // No AI-intro flag yet. If the user has finished onboarding, they were
  // already using a pre-AI build — show them what's new. Otherwise this is
  // a fresh install: suppress the upgrade prompt entirely.
  if (ls.getItem(ONBOARDING_KEY) === "1") return "show";
  return "mark-seen-silently";
}
