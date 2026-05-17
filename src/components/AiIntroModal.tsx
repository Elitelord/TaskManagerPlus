import { useEffect, useState } from "react";
import { Sparkles, ChevronRight } from "lucide-react";
import { decideAiIntro, AI_INTRO_KEY } from "../lib/aiIntro";

/**
 * One-time "what's new: on-device AI" prompt shown to users upgrading from
 * a build that predates the AI tier setting. Brand-new installs never see
 * it (see `decideAiIntro`). Reuses the onboarding modal's CSS so it looks
 * native to the app's existing first-run UI.
 */
interface AiIntroModalProps {
  /** Wired to App-level `setActiveTab` so the CTA can jump to Settings. */
  onNavigate?: (tabId: string) => void;
}

export function AiIntroModal({ onNavigate }: AiIntroModalProps = {}) {
  const [open, setOpen] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      const decision = decideAiIntro(localStorage);
      if (decision === "show") {
        setOpen(true);
      } else {
        if (decision === "mark-seen-silently") {
          localStorage.setItem(AI_INTRO_KEY, "1");
        }
        setOpen(false);
      }
    } catch {
      setOpen(false);
    }
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(AI_INTRO_KEY, "1");
    } catch { /* ignore */ }
    setOpen(false);
  };

  if (open !== true) return null;

  return (
    <div
      className="onboarding-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-intro-title"
    >
      <div className="onboarding-dialog">
        <div className="onboarding-step">
          <div className="onboarding-hero">
            <Sparkles size={28} className="onboarding-hero-icon" />
            <h2 className="onboarding-title" id="ai-intro-title">
              New: on-device AI
            </h2>
            <p className="onboarding-subtitle">
              This update adds an optional AI tier that runs entirely on your
              device. Today it sharpens memory-leak detection — telling a
              genuine leak apart from harmless cache warmup or a one-off
              startup spike.
            </p>
          </div>
          <ul className="onboarding-bullets">
            <li>
              <span className="onboarding-bullet-mark">•</span>
              <span>
                <strong>Off by default.</strong> Nothing changes unless you
                turn it on — the rules-based engine works exactly as before.
              </span>
            </li>
            <li>
              <span className="onboarding-bullet-mark">•</span>
              <span>
                <strong>Fully offline.</strong> No data is uploaded. Turning
                AI on does not add any network connection.
              </span>
            </li>
            <li>
              <span className="onboarding-bullet-mark">•</span>
              <span>
                Change tiers any time in <strong>Settings → AI</strong>.
              </span>
            </li>
          </ul>
          <div className="onboarding-footer">
            <button
              type="button"
              className="onboarding-btn onboarding-btn--ghost"
              onClick={dismiss}
            >
              Keep AI off
            </button>
            <div className="onboarding-footer-right">
              <button
                type="button"
                className="onboarding-btn onboarding-btn--primary"
                onClick={() => {
                  onNavigate?.("settings");
                  dismiss();
                }}
              >
                Open AI settings <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
