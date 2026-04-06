import { useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export function UpdateChecker() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [version, setVersion] = useState("");
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Check for updates 5 seconds after launch
    const timer = setTimeout(async () => {
      try {
        const update = await check();
        if (update) {
          setUpdateAvailable(true);
          setVersion(update.version);
        }
      } catch {
        // Silently fail — no network, no release, etc.
      }
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  const handleUpdate = async () => {
    setInstalling(true);
    try {
      const update = await check();
      if (update) {
        await update.downloadAndInstall();
        await relaunch();
      }
    } catch {
      setInstalling(false);
    }
  };

  if (!updateAvailable || dismissed) return null;

  return (
    <div className="update-banner">
      <span className="update-text">
        {installing
          ? "Installing update..."
          : `Update available: v${version}`
        }
      </span>
      {!installing && (
        <div className="update-actions">
          <button className="update-btn install" onClick={handleUpdate}>
            Update & Restart
          </button>
          <button className="update-btn dismiss" onClick={() => setDismissed(true)}>
            Later
          </button>
        </div>
      )}
    </div>
  );
}
