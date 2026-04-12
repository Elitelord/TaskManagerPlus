/**
 * Frequent apps tracker.
 *
 * Persists per-executable run time across sessions using localStorage, with
 * a rolling per-day bucket so we can answer:
 *   - "top N apps by time running this week"
 *   - "is this app a background / always-on app?" (used to filter workload
 *     detection so an always-on Discord doesn't drive the primary workload)
 *
 * The tracker is fed from the insights engine on every analysis tick so it
 * naturally reuses the same process list already being fetched by the
 * singleton IPC engine — no extra backend work.
 */

import type { ProcessInfo } from "./types";

const STORAGE_KEY = "taskmanagerplus.appUsage.v1";
/** Cap on how many distinct apps we remember. */
const MAX_TRACKED_APPS = 250;
/** Keep N days of per-day bucket data. */
const DAY_BUCKET_RETENTION = 14;
/** A tick interval longer than this is clamped (prevents huge jumps after sleep). */
const MAX_TICK_SECONDS = 30;
/** Seconds in a day a process must be running to count that day as "active". */
const DAY_ACTIVE_THRESHOLD_SECONDS = 60;
/** Background classification: active on at least this many of the last 7 days. */
const BACKGROUND_ACTIVE_DAYS = 5;
/** Persist cadence (ms) — avoids hammering localStorage every 5s tick. */
const PERSIST_DEBOUNCE_MS = 30_000;

/**
 * Tier 1: Hard ignore — we don't even record time for these. Pure OS plumbing
 * the user never interacts with.
 */
const IGNORED_PROCESSES = new Set([
  "system",
  "system idle process",
  "registry",
  "memory compression",
  "secure system",
  "smss.exe",
  "csrss.exe",
  "wininit.exe",
  "services.exe",
  "lsass.exe",
  "svchost.exe",
  "dwm.exe",
  "winlogon.exe",
  "fontdrvhost.exe",
  "spoolsv.exe",
  "conhost.exe",
  "dllhost.exe",
  "sihost.exe",
  "taskhostw.exe",
  "runtimebroker.exe",
  "searchhost.exe",
  "searchindexer.exe",
  "searchprotocolhost.exe",
  "searchfilterhost.exe",
  "startmenuexperiencehost.exe",
  "shellexperiencehost.exe",
  "textinputhost.exe",
  "widgetservice.exe",
  "ctfmon.exe",
  "audiodg.exe",
  "wudfhost.exe",
  "backgroundtaskhost.exe",
  "applicationframehost.exe",
  "systemsettings.exe",
  "taskmanagerplus",
  "taskmanagerplus.exe",
  "wmiprvse.exe",
  "rundll32.exe",
  "regsvr32.exe",
]);

/**
 * Tier 2: Known background services. These still get their time tracked (so
 * they still count as "background apps" for workload filtering) but they are
 * hidden from the default Frequent Apps list. Unlike tier 1 these are things
 * that are slightly more fuzzy or vendor-specific, and users may occasionally
 * want to see them by toggling `includeServices`.
 */
const KNOWN_SERVICE_NAMES = new Set<string>([
  // Windows security / telemetry
  "msmpeng.exe",
  "nissrv.exe",
  "mssense.exe",
  "mpdefendercoreservice.exe",
  "securityhealthservice.exe",
  "securityhealthsystray.exe",
  "sgrmbroker.exe",
  "sihclient.exe",
  "trustedinstaller.exe",
  "usoclient.exe",
  "mousocoreworker.exe",
  "smartscreen.exe",
  "compattelrunner.exe",
  "deviceenroller.exe",
  "wsqmcons.exe",
  "lsaiso.exe",
  "lockapp.exe",
  "logonui.exe",
  "locationnotificationwindows.exe",
  "sdxhelper.exe",
  "werfault.exe",
  "wermgr.exe",
  "cortana.exe",
  "shellhost.exe",
  "presentationhost.exe",
  "useroobebroker.exe",
  "crossdeviceservice.exe",
  "gamebar.exe",
  "gamebarpresencewriter.exe",
  // NVIDIA
  "nvdisplay.container.exe",
  "nvcontainer.exe",
  "nvtmru.exe",
  "nvbackend.exe",
  "nvidia web helper.exe",
  "nvidia share.exe",
  "nvsphelper64.exe",
  // Intel
  "igfxem.exe",
  "igfxtray.exe",
  "igfxcuiservice.exe",
  "heciserver.exe",
  "sockethciserver.exe",
  "intelcphdcpsvc.exe",
  "intelcpheciservice.exe",
  "intelcphecisvc.exe",
  "intelcpuruntimemonitor.exe",
  "esrv.exe",
  "esrv_svc.exe",
  // Realtek / audio
  "rtkauduservice64.exe",
  "rtkaudiouniversalservice.exe",
  "nahimicservice.exe",
  "nahimicsvc64.exe",
  "nahimicsvc32.exe",
  "realtekservice.exe",
  "rtkngui64.exe",
  // ASUS / ROG
  "armourycrate.service.exe",
  "armourycrate.usersessionhelper.exe",
  "armourysocketserver.exe",
  "asusoptimization.exe",
  "asussoftwaremanager.exe",
  "asuscertservice.exe",
  "asus_framework.exe",
  "asusdialhost.exe",
  "asmb8backgroundtask.exe",
  "asmb9backgroundtask.exe",
  "atkosd2.exe",
  "rogliveservice.exe",
  "asusupdatecheck.exe",
  // Dell
  "delltechhub.exe",
  "dellfoundationservices.exe",
  "dellmobileconnect.exe",
  "dellsupportassistagent.exe",
  "dellclientmanagementservice.exe",
  // HP
  "hpsupportassistant.exe",
  "hpcomputerrecovery.exe",
  "hpsupportsolutionsframework.exe",
  // Lenovo
  "lnbservice.exe",
  "lenovopcmanager.exe",
  "lenovovantage-(genericmessagesservice).exe",
  "tpnumlks.exe",
  // Updaters (almost never user-facing)
  "googleupdate.exe",
  "googleupdatecore.exe",
  "googlecrashhandler.exe",
  "googlecrashhandler64.exe",
  "microsoftedgeupdate.exe",
  "edgeupdate.exe",
  "msedgewebview2.exe",
  "onedrivestandaloneupdater.exe",
  "squirrel.exe",
  "update.exe",
  "setup.exe",
  "installer.exe",
  "jusched.exe",
  // Steam / launcher sub-services
  "steamservice.exe",
  "steamwebhelper.exe",
  "crashhandler.exe",
  "crashhandler64.exe",
  "epicwebhelper.exe",
  // Misc
  "nvidiacontainer.exe",
  "ibtsiva.exe",
  "hxtsr.exe",
  "ai.exe",
  "wlanext.exe",
  "snmptrap.exe",
  "ngciso.exe",
  // Windows Shell / File Explorer — always running, not a "frequent app"
  "explorer.exe",
  // Additional ASUS / ROG background tasks
  "asusoptimizationstartuptask.exe",
  "asusoledshifter.exe",
  "screenxpert.exe",
  "screenxpert.reunion.exe",
  "screenxpertreunion.exe",
  "asusscreenxpert.exe",
  "asusscreenxpertreunion.exe",
  "mcleansoftwareupdater.exe",
  "asusswitch.exe",
  "asusfanservice.exe",
  "asuskbfilter.exe",
  "aurawallpaperservice.exe",
  "lighting service.exe",
  "lightingservice.exe",
  // AMD bundled
  "amdpmfservice.exe",
  "amdpmf.exe",
  "amdrsserv.exe",
  "amdrssrcext.exe",
  "amdlogmanager.exe",
  "amdow.exe",
  "atievxx.exe",
  "atiesrxx.exe",
  "cncmd.exe",
  "rsiservice.exe",
  // Windows 11 "Click to Do" / Phone Link / Continuity components
  "clicktodo.exe",
  "clicktodo.apphost.exe",
  "crossdeviceservice.exe",
  "crossdeviceresume.exe",
  "phoneexperiencehost.exe",
  "yourphone.exe",
  "yourphoneserver.exe",
  // Windows 11 Widgets panel (the little "Widgets" icon on the taskbar)
  "widgets.exe",
  "widgetservice.exe",
  "widgetboard.exe",
  // Windows command interpreters — never a user-facing "frequent app"
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
  // AMD Software: Host Application + friends (Radeon / Adrenalin)
  "radeonsoftware.exe",
  "amdradeonsoftware.exe",
  "amdsoftware.exe",
  "amdrsservsrv.exe",
  "cnext.exe",
  // ASUS On-Screen Display (the volume/brightness overlay)
  "asusosd.exe",
  "asus osd.exe",
  "atkosd.exe",
  "atkosd2.exe",
  "hcontrol.exe",
  // Microsoft Teams — user asked to filter this out (cannot be closed cleanly)
  "teams.exe",
  "ms-teams.exe",
  "msteams.exe",
  "ms-teams-new.exe",
  "teams.windows.exe",
  // Adobe Express (ships as a hidden background WebView for sync/photos)
  "adobeexpress.exe",
  "adobe express.exe",
  "adobeexpressphotos.exe",
  "adobeexpressphotosview.exe",
  "creativecloud.exe",
  "adobeipcbroker.exe",
  "adobeupdateservice.exe",
  "adobenotificationclient.exe",
  // Adobe crash / telemetry sub-processes
  "adobecrashprocessor.exe",
  "adobecrashprocess.exe",
  "adobecrdaemon.exe",
  "adobecrashdaemon.exe",
  "crwindowsclientservice.exe",
  "adobeartslater.exe",
  "adobearmhelper.exe",
  "adobearm.exe",
  "armsvc.exe",
  "adobe crash process.exe",
  // Windows 11 "App Actions" (Copilot+ AI actions surface)
  "appactions.exe",
  "appactionshost.exe",
  "appactionsui.exe",
  "appactionsbackground.exe",
  "windowsappactions.exe",
  // Realtek Audio Console (companion UI to the audio driver)
  "realtekaudiocontrol.exe",
  "realtekaudiouniversalservice.exe",
  "realtekaudioconsole.exe",
  "ramaxelaudio.exe",
  "rtkauduservice.exe",
  "rtkngui.exe",
  "rtkauuservice64.exe",
  // WhatsApp secondary processes (main whatsapp.exe stays in allowlist).
  // WhatsApp ships a root WebView shell + update agent we don't care about.
  "whatsapp.root.exe",
  "whatsapproot.exe",
  "whatsappupdate.exe",
  "whatsappupdater.exe",
  // Cisco Secure Client (AnyConnect rebrand) — enterprise VPN, all background
  "csc_ui.exe",
  "cscui.exe",
  "vpnui.exe",
  "vpnagent.exe",
  "vpndownloader.exe",
  "acwebhelper.exe",
  "csc_umbrellaagent.exe",
  "umbrellaagent.exe",
  "aciseagent.exe",
  "aciseposture.exe",
  "acsocktool.exe",
  "acnamagent.exe",
  "dart.exe",
  "ciscocollabhost.exe",
  // Xbox app / Xbox Game Bar
  "xbox.exe",
  "xboxapp.exe",
  "xboxpcapp.exe",
  "xboxgamebar.exe",
  "xboxgamebarwidgets.exe",
  "gamebar.exe",
  "gamebarft.exe",
  "gameinputsvc.exe",
  "gamingservices.exe",
  "gamingservicesnet.exe",
  "xboxidentityprovider.exe",
  "xblgamesave.exe",
  // Chinese IME SmartScreen component
  "chxsmartscreen.exe",
  "chsime.exe",
  "imebroker.exe",
  "imecfmui.exe",
  "imewdbld.exe",
  // Generic "Microsoft Application" — almost always a worker/host with that
  // fallback FileDescription (e.g. MSEdgeWebView2 shims, store apps with
  // missing metadata)
  "microsoft.application.exe",
  "microsoftapplication.exe",
  "msapp.exe",
]);

/**
 * Tier 3: naming-convention patterns on the EXE name. Anything matching these
 * is treated as a background service regardless of whether it is in the
 * explicit list.
 */
const SERVICE_NAME_PATTERNS: RegExp[] = [
  /service\d*\.exe$/i,
  /svc\d*\.exe$/i,
  /daemon\.exe$/i,
  /host\.exe$/i,
  /broker\.exe$/i,
  /agent\.exe$/i,
  /updater?\.exe$/i,
  /runtime\.exe$/i,
  /telemetry\.exe$/i,
  /tray\.exe$/i,
  /backgroundtask\.exe$/i,
  /startuptask\.exe$/i,
  /crashhandler(64)?\.exe$/i,
  /crashreporter\.exe$/i,
  /crashpad_handler\.exe$/i,
  /^amd(pmf|rs).*\.exe$/i,
  /^asusoptimization.*\.exe$/i,
  /screenxpert.*\.exe$/i,
  /^clicktodo.*\.exe$/i,
  /^crossdevice.*\.exe$/i,
];

/**
 * Tier 3b: pattern matching against the FRIENDLY DISPLAY NAME (FileDescription).
 * OEMs ship their background daemons with weird exe names but the
 * FileDescription almost always says "<Something> Service" / "<Something> Task" /
 * etc. This is the single most reliable signal that something is a service.
 */
const SERVICE_DISPLAY_NAME_PATTERNS: RegExp[] = [
  /\bservice\b/i,
  /\bservices\b/i,
  /\bstartup task\b/i,
  /\bbackground task\b/i,
  /\bscheduled task\b/i,
  /\boptimization\b/i,
  /\boptimizer\b/i,
  /\btelemetry\b/i,
  /\bhelper\b/i,
  /\bdaemon\b/i,
  /\btray icon\b/i,
  /\bcrash ?(handler|reporter|pad)\b/i,
  /\bupdater?\b/i,
  /\bauto ?update\b/i,
  /\bshifter\b/i,
  /\bcross ?device\b/i,
  /\breunion( package)?\b/i,
  /\bbackground ?(task|host|process|worker)\b/i,
  /^click ?to ?do\b/i,
  /\bscreen ?xpert\b/i,
  /\bapp ?host\b/i,
  /\bruntime broker\b/i,
  /\bnotification ?(center|host)\b/i,
  /\binput ?(host|method)\b/i,
  /\bphone link\b/i,
  /\byour phone\b/i,
  // New: Windows / OEM overlays and shell pieces
  /\bwidgets?\b/i,
  /^command processor$/i,
  /\bwindows command processor\b/i,
  /\bwindows powershell\b/i,
  /\bon[- ]?screen display\b/i,
  /\bosd\b/i,
  /\bhost application\b/i,
  /\badobe express\b/i,
  /\bcreative cloud\b/i,
  /\bmicrosoft teams\b/i,
  /^teams$/i,
  // Crash telemetry / installer plumbing
  /\bcrash (process|processor|daemon|reporter|handler|pad|service)\b/i,
  /\badobe crash\b/i,
  /\barm ?svc\b/i,
  // Windows 11 AI surfaces
  /\bapp ?actions\b/i,
  // Audio console UIs (Realtek / Nahimic / Dolby)
  /\baudio console\b/i,
  /\brealtek audio\b/i,
  /\bdolby (access|atmos)\b/i,
  /\bnahimic\b/i,
  // Cisco / VPN clients
  /\bcisco secure client\b/i,
  /\banyconnect\b/i,
  /\bvpn ?(agent|client|ui|downloader)\b/i,
  /\bumbrella agent\b/i,
  // WhatsApp non-UI helper shells
  /whatsapp.*\b(root|update|updater|helper|background)\b/i,
  // Xbox app / Game Bar
  /^xbox( app| pc app)?$/i,
  /\bxbox game bar\b/i,
  /\bxbox identity provider\b/i,
  /\bgaming services\b/i,
  /\bgame input service\b/i,
  // Chinese IME SmartScreen
  /\bchx smart ?screen\b/i,
  /\bchs ?ime\b/i,
  /\bime ?(broker|cfmui|wdbld)\b/i,
  /\binput method editor\b/i,
  // Generic "Microsoft Application" fallback FileDescription — virtually
  // never the user's actual target. Real MS apps (Word, Excel, Edge,
  // VS Code, …) have specific FileDescriptions.
  /^microsoft application$/i,
  /^microsoft ® application$/i,
];

/**
 * A handful of apps that LOOK like services by name but are real user-facing
 * apps the user definitely cares about (allow-list overrides the regex/set).
 */
const USER_APP_ALLOWLIST = new Set<string>([
  "discord.exe",
  "spotify.exe",
  "slack.exe",
  "telegram.exe",
  "whatsapp.exe",
  "signal.exe",
  "onedrive.exe",
  "dropbox.exe",
  "googledrivefs.exe",
  "zoom.exe",
  "obs64.exe",
  "obs32.exe",
  "steam.exe",
  "epicgameslauncher.exe",
  "battle.net.exe",
  // Explicitly user-facing — these LOOK like they might get caught by the
  // display-name regex but are real apps.
  "quickshare.exe",
  "quick share.exe",
  "nearbyshare.exe",
  "lunarclient.exe",
  "lunar client.exe",
  "ticktick.exe",
  "ticktick.app.exe",
]);

/**
 * Classify a stored entry as either a real user app or a background service.
 * Real apps almost always:
 *   - have an icon embedded
 *   - have a FileDescription distinct from the exe name (shows up in
 *     `display_name`)
 *
 * Combined with the explicit/regex rules above, this is a conservative filter
 * that removes the obvious junk (Defender, NVIDIA containers, updaters, …)
 * without accidentally eating Discord / Steam / Chrome.
 */
function classifyAppKind(entry: AppUsageEntry): "app" | "service" {
  // Defensive: stored entries from older versions could be missing `name`.
  const rawName = typeof entry?.name === "string" ? entry.name : "";
  if (!rawName) return "service";
  const lower = rawName.toLowerCase();

  // 1. Allow-list wins over everything else.
  if (USER_APP_ALLOWLIST.has(lower)) return "app";

  // 2. Explicit exe blocklist.
  if (KNOWN_SERVICE_NAMES.has(lower)) return "service";

  // 3. Exe name regex patterns.
  for (const re of SERVICE_NAME_PATTERNS) {
    if (re.test(lower)) return "service";
  }

  // 4. Display-name (FileDescription) patterns. This is the single most
  //    reliable signal — OEMs always put "Service" / "Task" / "Optimization"
  //    in the FileDescription even when the exe name is innocuous.
  const rawFriendly =
    typeof entry.displayName === "string" ? entry.displayName : "";
  const friendly = rawFriendly.trim();
  if (friendly.length > 0) {
    for (const re of SERVICE_DISPLAY_NAME_PATTERNS) {
      if (re.test(friendly)) return "service";
    }
  }

  // 5. Metadata heuristic: no icon AND the display name is identical to the
  //    exe name (FileDescription was never populated). Anything the user
  //    launches from the Start Menu will trip at least one of these.
  const hasIcon =
    typeof entry.iconBase64 === "string" && entry.iconBase64.length > 0;
  const friendlyLower = friendly.toLowerCase();
  const exeStem = lower.replace(/\.exe$/i, "");
  const hasFriendlyName =
    friendlyLower.length > 0 &&
    friendlyLower !== lower &&
    friendlyLower !== exeStem;
  if (!hasIcon && !hasFriendlyName) return "service";

  return "app";
}

export interface AppUsageEntry {
  /** Lowercased exe name (e.g. "chrome.exe"). */
  name: string;
  /** Friendly display name (falls back to `name`). */
  displayName: string;
  /** Optional base64 icon (most recent observation). */
  iconBase64?: string;
  /** Cumulative time the process has been observed running, in seconds. */
  totalSeconds: number;
  /** Count of distinct runs (process disappeared then re-appeared). */
  sessions: number;
  /** First ever observation (ms since epoch). */
  firstSeen: number;
  /** Most recent observation (ms since epoch). */
  lastSeen: number;
  /** Per-day seconds running, keyed by local `YYYY-MM-DD`. */
  dayBuckets: Record<string, number>;
}

interface AppUsageDB {
  version: 1;
  apps: Record<string, AppUsageEntry>;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let db: AppUsageDB = loadDb();
let lastTickMs = 0;
let previousNames: Set<string> = new Set();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach(fn => fn());
}

function loadDb(): AppUsageDB {
  if (typeof localStorage === "undefined") {
    return { version: 1, apps: {} };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, apps: {} };
    const parsed = JSON.parse(raw) as AppUsageDB;
    if (!parsed || parsed.version !== 1 || typeof parsed.apps !== "object") {
      return { version: 1, apps: {} };
    }
    return parsed;
  } catch {
    return { version: 1, apps: {} };
  }
}

function schedulePersist() {
  dirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
      }
    } catch {
      // Quota / disabled storage — silently ignore; in-memory state still works.
    }
  }, PERSIST_DEBOUNCE_MS);
}

function dayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function last7DayKeys(): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    out.push(dayKey(d));
  }
  return out;
}

function pruneOldDayBuckets(entry: AppUsageEntry, keepKeys: Set<string>) {
  for (const k of Object.keys(entry.dayBuckets)) {
    if (!keepKeys.has(k)) delete entry.dayBuckets[k];
  }
}

function buildRetentionKeySet(): Set<string> {
  const out = new Set<string>();
  const now = new Date();
  for (let i = 0; i < DAY_BUCKET_RETENTION; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    out.add(dayKey(d));
  }
  return out;
}

function capTrackedApps() {
  const names = Object.keys(db.apps);
  if (names.length <= MAX_TRACKED_APPS) return;
  // Drop entries with the smallest lifetime totalSeconds first.
  names.sort((a, b) => db.apps[a].totalSeconds - db.apps[b].totalSeconds);
  const toRemove = names.length - MAX_TRACKED_APPS;
  for (let i = 0; i < toRemove; i++) delete db.apps[names[i]];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Feed the tracker with the current process list. Should be called from the
 * insights engine's analysis tick (≈every 5s).
 */
export function feedAppUsage(processes: ProcessInfo[] | undefined) {
  if (!processes) return;

  const now = Date.now();
  const prevTick = lastTickMs;
  lastTickMs = now;

  // First tick in this session — no delta, just seed previousNames.
  if (prevTick === 0) {
    const seed = new Set<string>();
    for (const p of processes) {
      const name = (p.name || "").toLowerCase();
      if (!name || IGNORED_PROCESSES.has(name)) continue;
      seed.add(name);
    }
    previousNames = seed;
    return;
  }

  const deltaSec = Math.min(Math.max((now - prevTick) / 1000, 0), MAX_TICK_SECONDS);
  if (deltaSec <= 0) return;

  const today = dayKey();
  const retentionKeys = buildRetentionKeySet();

  // Dedupe by lowercased exe name — a single "chrome.exe" with 20 processes
  // should only count once per tick.
  const seenThisTick = new Map<string, ProcessInfo>();
  for (const p of processes) {
    const name = (p.name || "").toLowerCase();
    if (!name || IGNORED_PROCESSES.has(name)) continue;
    if (!seenThisTick.has(name)) seenThisTick.set(name, p);
  }

  for (const [name, p] of seenThisTick) {
    let entry = db.apps[name];
    if (!entry) {
      entry = {
        name,
        displayName: p.display_name || p.name || name,
        iconBase64: p.icon_base64 || undefined,
        totalSeconds: 0,
        sessions: 1,
        firstSeen: now,
        lastSeen: now,
        dayBuckets: {},
      };
      db.apps[name] = entry;
    } else {
      // New session: this name wasn't running last tick
      if (!previousNames.has(name)) entry.sessions += 1;
      if (p.display_name && p.display_name !== entry.displayName) {
        entry.displayName = p.display_name;
      }
      if (p.icon_base64) entry.iconBase64 = p.icon_base64;
    }

    entry.lastSeen = now;
    entry.totalSeconds += deltaSec;
    entry.dayBuckets[today] = (entry.dayBuckets[today] ?? 0) + deltaSec;
    pruneOldDayBuckets(entry, retentionKeys);
  }

  previousNames = new Set(seenThisTick.keys());

  capTrackedApps();
  schedulePersist();
  notify();
}

/** Sum of `dayBuckets` across the last 7 calendar days, in seconds. */
export function last7DaysSeconds(entry: AppUsageEntry): number {
  let total = 0;
  for (const k of last7DayKeys()) {
    total += entry.dayBuckets[k] ?? 0;
  }
  return total;
}

/**
 * Classify an app as "background / always-on" if it has been active on at
 * least BACKGROUND_ACTIVE_DAYS of the last 7 days. Used to suppress false
 * positives in workload detection (e.g. always-on Discord).
 */
export function isBackgroundApp(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  const entry = db.apps[name.toLowerCase()];
  if (!entry || !entry.dayBuckets) return false;
  let activeDays = 0;
  for (const k of last7DayKeys()) {
    const v = Number(entry.dayBuckets[k] ?? 0);
    if (Number.isFinite(v) && v >= DAY_ACTIVE_THRESHOLD_SECONDS) activeDays++;
  }
  return activeDays >= BACKGROUND_ACTIVE_DAYS;
}

export interface FrequentApp {
  name: string;
  displayName: string;
  iconBase64?: string;
  weekSeconds: number;
  totalSeconds: number;
  sessions: number;
  firstSeen: number;
  lastSeen: number;
  isBackground: boolean;
  /** Number of days in the last 7 where this app ran > threshold. */
  activeDaysLast7: number;
  /** "app" = user-facing application, "service" = background service. */
  kind: "app" | "service";
}

function entryToFrequent(entry: AppUsageEntry): FrequentApp | null {
  // Skip malformed entries left over from older storage versions rather than
  // letting `.toLowerCase()` on undefined throw inside the analysis tick.
  if (!entry || typeof entry.name !== "string" || entry.name.length === 0) {
    return null;
  }
  const buckets =
    entry.dayBuckets && typeof entry.dayBuckets === "object"
      ? entry.dayBuckets
      : {};
  const weekKeys = last7DayKeys();
  let weekSeconds = 0;
  let activeDays = 0;
  for (const k of weekKeys) {
    const v = Number(buckets[k] ?? 0);
    if (!Number.isFinite(v)) continue;
    weekSeconds += v;
    if (v >= DAY_ACTIVE_THRESHOLD_SECONDS) activeDays++;
  }
  return {
    name: entry.name,
    displayName: entry.displayName || entry.name,
    iconBase64: entry.iconBase64,
    weekSeconds,
    totalSeconds: Number.isFinite(entry.totalSeconds) ? entry.totalSeconds : 0,
    sessions: Number.isFinite(entry.sessions) ? entry.sessions : 0,
    firstSeen: entry.firstSeen ?? 0,
    lastSeen: entry.lastSeen ?? 0,
    isBackground: activeDays >= BACKGROUND_ACTIVE_DAYS,
    activeDaysLast7: activeDays,
    kind: classifyAppKind(entry),
  };
}

export interface GetFrequentAppsOptions {
  /** Include background services in the result (default: false). */
  includeServices?: boolean;
}

/**
 * Top N apps by running time in the last 7 days. Empty week (fresh install)
 * falls back to ordering by all-time `totalSeconds`. By default, background
 * services (Defender, NVIDIA containers, updaters, …) are excluded — pass
 * `{ includeServices: true }` to see the full list.
 */
export function getFrequentApps(
  limit: number = 6,
  options: GetFrequentAppsOptions = {},
): FrequentApp[] {
  const includeServices = options.includeServices ?? false;
  const all: FrequentApp[] = [];
  for (const entry of Object.values(db.apps)) {
    const freq = entryToFrequent(entry);
    if (!freq) continue;
    if (!includeServices && freq.kind !== "app") continue;
    all.push(freq);
  }
  const hasWeekData = all.some(a => a.weekSeconds > 0);
  all.sort((a, b) => {
    if (hasWeekData) {
      if (b.weekSeconds !== a.weekSeconds) return b.weekSeconds - a.weekSeconds;
    }
    return b.totalSeconds - a.totalSeconds;
  });
  return all.slice(0, limit);
}

/** Returns true if the given exe name is classified as a background service. */
export function isBackgroundService(name: string): boolean {
  const entry = db.apps[name.toLowerCase()];
  if (!entry) {
    // Entry not yet tracked — still run the name-based rules so the caller
    // (workload detector) can short-circuit obvious services.
    const lower = name.toLowerCase();
    if (USER_APP_ALLOWLIST.has(lower)) return false;
    if (KNOWN_SERVICE_NAMES.has(lower)) return true;
    for (const re of SERVICE_NAME_PATTERNS) {
      if (re.test(lower)) return true;
    }
    return false;
  }
  return classifyAppKind(entry) === "service";
}

/** Clears all tracked data (for the Settings page "reset" action, if any). */
export function resetAppUsage() {
  db = { version: 1, apps: {} };
  previousNames = new Set();
  lastTickMs = 0;
  dirty = true;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  notify();
}

export function subscribeAppUsage(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Format seconds as "Xh Ym" / "Ym" / "Xs" for compact UI labels. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hours < 24) return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}
