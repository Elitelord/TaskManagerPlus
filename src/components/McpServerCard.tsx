// Y2-A — Settings card explaining the MCP integration and surfacing the
// exact launch snippet for the user to paste into their MCP client
// (Claude Desktop, Claude Code, Cursor, …).
//
// The sidecar `tmp_mcp.exe` is always present on disk regardless of the
// toggle below; this card just gates whether the connection snippets are
// shown, so users explicitly opt-in to "yes, surface MCP" before they
// see the path. See settings.ts `mcpEnabled` for the rationale.

import { useEffect, useState } from "react";
import { useSettings } from "../lib/settings";
import {
  getMcpClientsAvailable,
  getMcpDestructiveEnabled,
  getMcpSidecarPath,
  installMcpClaudeCode,
  installMcpClaudeDesktop,
  setMcpDestructiveEnabled,
  type McpClientAvailability,
} from "../lib/ipc";

type InstallState =
  | { kind: "idle" }
  | { kind: "running"; client: "claudeCode" | "claudeDesktop" }
  | { kind: "ok"; client: "claudeCode" | "claudeDesktop" }
  | { kind: "error"; client: "claudeCode" | "claudeDesktop"; message: string };

export function McpServerCard() {
  const [settings, update] = useSettings();
  const [sidecarPath, setSidecarPath] = useState<string | null>(null);
  const [clients, setClients] = useState<McpClientAvailability | null>(null);
  const [install, setInstall] = useState<InstallState>({ kind: "idle" });
  const [copied, setCopied] = useState<string | null>(null);
  // Z1 — destructive-tool opt-in. Lives in the backend mcp_config.json,
  // NOT in the React settings store, because the sidecar reads it from
  // disk independently of the running app. Mirroring it into settings.ts
  // would let the two drift; instead we read+write through Tauri commands.
  const [destructive, setDestructive] = useState<boolean | null>(null);
  const [destructiveSaving, setDestructiveSaving] = useState(false);

  // Resolve the bundled sidecar path + detect installed MCP clients once
  // per mount. Both are static facts of the install, so refetching on
  // every setting change would be wasted work.
  useEffect(() => {
    let cancelled = false;
    getMcpSidecarPath().then((p) => {
      if (!cancelled) setSidecarPath(p);
    });
    getMcpClientsAvailable()
      .then((c) => {
        if (!cancelled) setClients(c);
      })
      .catch(() => { /* non-Tauri / backend not ready */ });
    getMcpDestructiveEnabled()
      .then((v) => {
        if (!cancelled) setDestructive(v);
      })
      .catch(() => {
        // Treat read failures as "off" so the UI reflects the safe default.
        if (!cancelled) setDestructive(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleDestructive = async (next: boolean) => {
    setDestructiveSaving(true);
    try {
      await setMcpDestructiveEnabled(next);
      setDestructive(next);
    } catch {
      // Roll back optimistically on error so the toggle reflects truth.
      setDestructive((v) => v);
    } finally {
      setDestructiveSaving(false);
    }
  };

  const runInstall = async (client: "claudeCode" | "claudeDesktop") => {
    setInstall({ kind: "running", client });
    try {
      if (client === "claudeCode") {
        await installMcpClaudeCode();
      } else {
        await installMcpClaudeDesktop();
      }
      setInstall({ kind: "ok", client });
      window.setTimeout(() => {
        setInstall((s) => (s.kind === "ok" && s.client === client ? { kind: "idle" } : s));
      }, 2500);
    } catch (e) {
      setInstall({
        kind: "error",
        client,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const enabled = settings.mcpEnabled;

  const claudeCodeSnippet = sidecarPath
    ? `claude mcp add taskmanagerplus "${sidecarPath}"`
    : "";

  // JSON.stringify with 2-space indent keeps the example readable when
  // pasted into the user's claude_desktop_config.json. Backslashes get
  // escaped automatically so we never hand the user a broken Windows path.
  const claudeDesktopSnippet = sidecarPath
    ? JSON.stringify(
        {
          mcpServers: {
            taskmanagerplus: { command: sidecarPath },
          },
        },
        null,
        2,
      )
    : "";

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1400);
    } catch {
      // Fallback if clipboard API is denied — surface a hint via the
      // copied state so the user knows it failed, vs silently no-oping.
      setCopied("error");
    }
  };

  return (
    <div className="info-panel">
      <h3 className="section-title">AI Assistant Integration (MCP)</h3>
      <p className="setting-description">
        Lets AI assistants — Claude Desktop, Claude Code, Cursor, and other
        MCP-compatible clients — read TaskManager+ data on demand. The
        assistant can ask things like &ldquo;what&rsquo;s eating my
        disk?&rdquo; and call into the same telemetry the app already
        shows you.
      </p>
      <p className="setting-description setting-privacy-note">
        <strong>What gets shared:</strong> running processes, performance
        counters, mounted drives, top folders, installed apps, detected
        projects. Read-only by default. Destructive actions (ending
        processes, recycling files) require an extra opt-in below.
      </p>
      <p className="setting-description setting-privacy-note">
        <strong>Privacy boundary:</strong> TaskManager+ doesn&rsquo;t send
        anything anywhere. The MCP client you connect (e.g. Claude
        Desktop) is what may forward this data to a hosted model — whether
        it does is governed by the client&rsquo;s own privacy settings,
        not TaskManager+&rsquo;s. Disable here at any time.
      </p>

      <label className="setting-toggle-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => update({ mcpEnabled: e.target.checked })}
        />
        <span className="toggle-track">
          <span className="toggle-thumb" />
        </span>
        <span className="setting-label">
          Show connection instructions for AI clients
        </span>
      </label>

      {enabled && !sidecarPath && (
        <p className="setting-description" style={{ marginTop: "1rem" }}>
          <em>
            Sidecar binary not found. In dev, run{" "}
            <code>cargo build --release --bin tmp_mcp</code> from{" "}
            <code>src-tauri/</code>. In a release build this shouldn&rsquo;t
            happen — please file an issue.
          </em>
        </p>
      )}

      {enabled && sidecarPath && (
        <div className="mcp-config-block">
          {/* One-click install row. Renders a button per detected client
              ('claude' CLI on PATH → Claude Code; %APPDATA%\Claude\
              exists → Claude Desktop). Hidden entirely when neither
              client is present, so users on Cursor / Zed / Cline see
              the copy-paste snippets below unchanged. */}
          {(clients?.claudeCode || clients?.claudeDesktop) && (
            <div className="mcp-quickinstall">
              <p className="setting-description" style={{ margin: 0 }}>
                <strong>Quick install:</strong>
              </p>
              {clients?.claudeCode && (
                <button
                  type="button"
                  className="copy-btn"
                  disabled={install.kind === "running"}
                  onClick={() => runInstall("claudeCode")}
                >
                  {install.kind === "running" && install.client === "claudeCode"
                    ? "Installing…"
                    : install.kind === "ok" && install.client === "claudeCode"
                      ? "Installed — restart Claude Code"
                      : "Install for Claude Code"}
                </button>
              )}
              {clients?.claudeDesktop && (
                <button
                  type="button"
                  className="copy-btn"
                  disabled={install.kind === "running"}
                  onClick={() => runInstall("claudeDesktop")}
                >
                  {install.kind === "running" && install.client === "claudeDesktop"
                    ? "Installing…"
                    : install.kind === "ok" && install.client === "claudeDesktop"
                      ? "Installed — restart Claude Desktop"
                      : "Install for Claude Desktop"}
                </button>
              )}
              {install.kind === "error" && (
                <p
                  className="setting-description"
                  style={{ color: "var(--danger, #e8836a)", margin: 0 }}
                >
                  {install.message}
                </p>
              )}
            </div>
          )}

          {/* Manual snippets behind a <details> so they don't take
              ~15 vertical lines of card space by default. Users with a
              one-click install (above) usually never need to expand
              this; users on other clients (Cursor's per-project
              config, Zed, Cline, etc.) get the canonical paste-able
              forms here. */}
          <details className="settings-details">
            <summary>Manual setup (other clients)</summary>
            <div className="settings-details-body">
              <div className="mcp-snippet-group">
                <div className="mcp-snippet-head">
                  <span className="setting-label">
                    Claude Code / Cursor (terminal)
                  </span>
                  <button
                    type="button"
                    className="copy-btn"
                    onClick={() => copy(claudeCodeSnippet, "code")}
                  >
                    {copied === "code" ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre className="mcp-snippet">{claudeCodeSnippet}</pre>
              </div>

              <div className="mcp-snippet-group">
                <div className="mcp-snippet-head">
                  <span className="setting-label">
                    Claude Desktop (claude_desktop_config.json)
                  </span>
                  <button
                    type="button"
                    className="copy-btn"
                    onClick={() => copy(claudeDesktopSnippet, "desktop")}
                  >
                    {copied === "desktop" ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre className="mcp-snippet">{claudeDesktopSnippet}</pre>
                <p className="setting-description" style={{ marginTop: "0.5rem" }}>
                  Merge the <code>mcpServers</code> key into your
                  existing config (location:{" "}
                  <code>%APPDATA%\Claude\claude_desktop_config.json</code>),
                  then restart Claude Desktop.
                </p>
              </div>
            </div>
          </details>

          {/* Z1 — destructive-tool opt-in. Hidden behind <details>
              because the default answer is "no, don't enable this" and
              we don't want to bait users into flipping it just because
              it's there. Expanding the section shows the full warning
              before the toggle. */}
          <details className="settings-details">
            <summary>Allow destructive actions (advanced)</summary>
            <div className="settings-details-body">
              <p className="setting-description" style={{ margin: 0 }}>
                Lets the AI end processes and send files to the Recycle
                Bin via MCP. Each call requires the AI to preview the
                action first (a dry run) before committing. System
                processes (Windows kernel, lsass, etc.) and protected
                paths (C:\Windows, Program Files, drive roots) are
                refused regardless of this toggle.
              </p>
              <p
                className="setting-description"
                style={{ margin: "0.5rem 0 0", color: "var(--danger, #e8836a)" }}
              >
                <strong>Restart your MCP client after toggling.</strong>{" "}
                The sidecar reads this flag once at startup, so the new
                tool list only appears after Claude Desktop / Cursor /
                Claude Code reconnects.
              </p>
              <label
                className="setting-toggle-row"
                style={{ marginTop: "0.75rem" }}
              >
                <input
                  type="checkbox"
                  checked={destructive === true}
                  disabled={destructive === null || destructiveSaving}
                  onChange={(e) => toggleDestructive(e.target.checked)}
                />
                <span className="toggle-track">
                  <span className="toggle-thumb" />
                </span>
                <span className="setting-label">
                  Allow AI to end processes and recycle files
                </span>
              </label>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
