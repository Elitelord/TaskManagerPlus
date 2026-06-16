/**
 * Local reference for Windows bug-check (BSOD) stop codes, plus the shared
 * vocabulary the crash card uses to describe and remediate any incident.
 *
 * Fully on-device — no lookups, no network. Each known code carries:
 *   - a symbolic name + plain-English summary,
 *   - a `presentation` (how it shows up: blue screen vs silent hang vs power
 *     loss vs thermal) so the card stops mislabeling hangs as "blue screens",
 *   - a `klass` (which subsystem is implicated) that drives the remediation
 *     playbook and the "likely area" device lookup.
 *
 * Unknown codes fall back to presentation/class inferred from the event kind.
 */

/** How the incident actually presented to the user. */
export type CrashPresentation =
  | "bluescreen"
  | "hang"
  | "power_loss"
  | "thermal"
  | "unknown";

/** Which subsystem the failure points at — drives remediation + device lookup. */
export type CrashClass =
  | "gpu"
  | "wifi"
  | "network"
  | "storage"
  | "memory"
  | "cpu_hw"
  | "power"
  | "usb"
  | "corruption"
  | "driver"
  | "unknown";

export interface StopCodeInfo {
  /** Canonical `0x........` form. */
  code: string;
  /** Symbolic name, e.g. "DRIVER_IRQL_NOT_LESS_OR_EQUAL". */
  name: string;
  /** What it means + the usual culprits. */
  summary: string;
  presentation: CrashPresentation;
  klass: CrashClass;
}

type Entry = Omit<StopCodeInfo, "code">;

// Keyed by the numeric bug-check value so padding/case differences between the
// two event sources (41 vs 1001) don't matter.
const TABLE: Record<number, Entry> = {
  0x0a: { name: "IRQL_NOT_LESS_OR_EQUAL", presentation: "bluescreen", klass: "driver",
    summary: "A driver accessed memory it shouldn't have. Usually a faulty or mismatched device driver; occasionally bad RAM." },
  0x1a: { name: "MEMORY_MANAGEMENT", presentation: "bluescreen", klass: "memory",
    summary: "Windows' memory manager hit an error. Often failing RAM or a driver corrupting memory — run Windows Memory Diagnostic." },
  0x1e: { name: "KMODE_EXCEPTION_NOT_HANDLED", presentation: "bluescreen", klass: "driver",
    summary: "A kernel-mode component raised an error Windows couldn't handle. Typically a buggy driver; sometimes faulty hardware." },
  0x3b: { name: "SYSTEM_SERVICE_EXCEPTION", presentation: "bluescreen", klass: "driver",
    summary: "An exception occurred while running system code. Commonly an outdated or corrupt driver — updating graphics/storage drivers often fixes it." },
  0x4e: { name: "PFN_LIST_CORRUPT", presentation: "bluescreen", klass: "memory",
    summary: "The memory manager's page list is corrupt. Almost always failing RAM, or a driver writing out of bounds." },
  0x50: { name: "PAGE_FAULT_IN_NONPAGED_AREA", presentation: "bluescreen", klass: "memory",
    summary: "Windows referenced memory that doesn't exist. Most often defective RAM, or a driver/antivirus touching freed memory." },
  0x77: { name: "KERNEL_STACK_INPAGE_ERROR", presentation: "bluescreen", klass: "storage",
    summary: "Windows couldn't read a kernel page from disk. Usually a failing drive, bad cable/connection, or disk corruption." },
  0x7a: { name: "KERNEL_DATA_INPAGE_ERROR", presentation: "bluescreen", klass: "storage",
    summary: "A page couldn't be read from disk. Points to a failing drive or controller, a loose cable, or sometimes bad RAM." },
  0x7e: { name: "SYSTEM_THREAD_EXCEPTION_NOT_HANDLED", presentation: "bluescreen", klass: "driver",
    summary: "A system thread hit an error it couldn't handle. Usually a driver problem — check recently installed or updated drivers." },
  0x7f: { name: "UNEXPECTED_KERNEL_MODE_TRAP", presentation: "bluescreen", klass: "cpu_hw",
    summary: "The CPU hit an unexpected fault. Often hardware-related: bad RAM, overheating, or an unstable overclock." },
  0x9c: { name: "MACHINE_CHECK_EXCEPTION", presentation: "bluescreen", klass: "cpu_hw",
    summary: "The CPU reported a fatal hardware error. Check temperatures, reseat/test RAM, and remove any overclock." },
  0x9f: { name: "DRIVER_POWER_STATE_FAILURE", presentation: "hang", klass: "power",
    summary: "A driver didn't complete a sleep/resume power transition, so the system hung instead of crashing cleanly. On laptops the usual offenders are Wi-Fi, graphics, or USB power drivers." },
  0xa0: { name: "INTERNAL_POWER_ERROR", presentation: "hang", klass: "power",
    summary: "The power policy manager failed. Often a battery/ACPI/power driver or firmware issue — update the BIOS and chipset drivers." },
  0xbe: { name: "ATTEMPTED_WRITE_TO_READONLY_MEMORY", presentation: "bluescreen", klass: "driver",
    summary: "A driver tried to write to read-only memory — a buggy driver is to blame." },
  0xc2: { name: "BAD_POOL_CALLER", presentation: "bluescreen", klass: "driver",
    summary: "A driver used a memory pool incorrectly. Almost always a faulty driver." },
  0xc4: { name: "DRIVER_VERIFIER_DETECTED_VIOLATION", presentation: "bluescreen", klass: "driver",
    summary: "Driver Verifier caught a driver breaking the rules. The driver named in the crash dump is the culprit." },
  0xc5: { name: "DRIVER_CORRUPTED_EXPOOL", presentation: "bluescreen", klass: "driver",
    summary: "A driver corrupted the system memory pool. A faulty driver, or failing RAM." },
  0xd1: { name: "DRIVER_IRQL_NOT_LESS_OR_EQUAL", presentation: "bluescreen", klass: "driver",
    summary: "A driver accessed memory at the wrong time — one of the most common driver bugs. Update the offending driver (frequently network or storage)." },
  0xea: { name: "THREAD_STUCK_IN_DEVICE_DRIVER", presentation: "hang", klass: "gpu",
    summary: "The graphics driver got stuck in a loop and the screen froze. Often a failing GPU or a bad display driver." },
  0xef: { name: "CRITICAL_PROCESS_DIED", presentation: "bluescreen", klass: "corruption",
    summary: "A process Windows can't run without ended unexpectedly. Often system-file corruption — run 'sfc /scannow' then 'DISM /Online /Cleanup-Image /RestoreHealth'." },
  0xf4: { name: "CRITICAL_OBJECT_TERMINATION", presentation: "bluescreen", klass: "storage",
    summary: "A critical system process terminated. Frequently a failing disk or corrupt system files." },
  0xfc: { name: "ATTEMPTED_EXECUTE_OF_NOEXECUTE_MEMORY", presentation: "bluescreen", klass: "driver",
    summary: "A driver tried to run code from non-executable memory. A driver bug, occasionally malware." },
  0x101: { name: "CLOCK_WATCHDOG_TIMEOUT", presentation: "hang", klass: "cpu_hw",
    summary: "A CPU core stopped responding to the system clock. Often an unstable overclock, a CPU/firmware issue, or inadequate cooling." },
  0x109: { name: "CRITICAL_STRUCTURE_CORRUPTION", presentation: "bluescreen", klass: "corruption",
    summary: "Windows detected its own kernel code/data was modified. A buggy driver, failing memory, or (rarely) tampering." },
  0x113: { name: "VIDEO_DXGKRNL_FATAL_ERROR", presentation: "bluescreen", klass: "gpu",
    summary: "The DirectX graphics kernel hit a fatal error. Update or clean-reinstall the GPU driver." },
  0x116: { name: "VIDEO_TDR_FAILURE", presentation: "hang", klass: "gpu",
    summary: "The graphics driver stopped responding and couldn't recover. Update or reinstall the GPU driver and check for overheating." },
  0x117: { name: "VIDEO_TDR_TIMEOUT_DETECTED", presentation: "hang", klass: "gpu",
    summary: "The graphics driver timed out. Usually a GPU driver issue or an overheating/failing graphics card." },
  0x119: { name: "VIDEO_SCHEDULER_INTERNAL_ERROR", presentation: "bluescreen", klass: "gpu",
    summary: "The GPU scheduler hit a fatal error. Update the graphics driver; the card may be failing." },
  0x124: { name: "WHEA_UNCORRECTABLE_ERROR", presentation: "bluescreen", klass: "cpu_hw",
    summary: "The hardware reported an unrecoverable error. Usually a genuine fault: CPU, RAM, motherboard, or overheating." },
  0x133: { name: "DPC_WATCHDOG_VIOLATION", presentation: "hang", klass: "storage",
    summary: "A driver or device stalled the CPU too long. Commonly outdated SSD firmware or a storage/USB driver — update both." },
  0x139: { name: "KERNEL_SECURITY_CHECK_FAILURE", presentation: "bluescreen", klass: "driver",
    summary: "Windows detected corruption of a kernel data structure. Often a driver bug or failing memory." },
  0x141: { name: "VIDEO_ENGINE_TIMEOUT_DETECTED", presentation: "hang", klass: "gpu",
    summary: "A GPU engine timed out. A graphics driver problem or an overheating/failing card." },
  0xc000021a: { name: "STATUS_SYSTEM_PROCESS_TERMINATED", presentation: "bluescreen", klass: "corruption",
    summary: "A subsystem critical to Windows (such as winlogon or csrss) failed. Often corrupt system files or a bad update — try the last good restore point." },
};

/** Optional action a remediation step can offer. All non-destructive: they
 *  open a built-in tool / Settings page, or copy a command to the clipboard
 *  (the gentlest option) — they never change anything themselves. */
export type RemediationAction =
  | { kind: "device-manager"; label: string }
  | { kind: "windows-update"; label: string }
  | { kind: "copy"; label: string; value: string };

export interface RemediationStep {
  text: string;
  action?: RemediationAction;
}

const DEVMGR: RemediationAction = { kind: "device-manager", label: "Open Device Manager" };
const WUPDATE: RemediationAction = { kind: "windows-update", label: "Open Windows Update" };
const copyCmd = (value: string): RemediationAction => ({ kind: "copy", label: "Copy command", value });

/** Ordered, concrete remediation steps per implicated subsystem. */
export const CLASS_REMEDIATION: Record<CrashClass, RemediationStep[]> = {
  gpu: [
    { text: "Update or clean-reinstall your graphics driver (use the GPU vendor's installer; DDU for a clean wipe if it keeps recurring).", action: WUPDATE },
    { text: "Check GPU temperatures and airflow — overheating causes display timeouts." },
    { text: "If it started right after a driver update, roll the display driver back.", action: DEVMGR },
  ],
  wifi: [
    { text: "Update the Wi-Fi adapter driver (your laptop OEM's site, or Windows Update → optional driver updates).", action: WUPDATE },
    { text: "Device Manager → your Wi-Fi adapter → Power Management → uncheck \"Allow the computer to turn off this device to save power.\"", action: DEVMGR },
    { text: "If it began after an update, roll the Wi-Fi driver back.", action: DEVMGR },
  ],
  network: [
    { text: "Update the network adapter driver from the OEM or Windows Update.", action: WUPDATE },
    { text: "Device Manager → the adapter → Power Management → uncheck \"Allow the computer to turn off this device to save power.\"", action: DEVMGR },
    { text: "Roll the driver back if the problem started after an update.", action: DEVMGR },
  ],
  storage: [
    { text: "Update your storage/NVMe driver and the SSD's firmware from the drive maker.", action: WUPDATE },
    { text: "Run 'chkdsk /scan' and check the drive's SMART health — failing disks throw these.", action: copyCmd("chkdsk /scan") },
    { text: "On a desktop, reseat the drive or try a different cable/port." },
  ],
  memory: [
    { text: "Run Windows Memory Diagnostic (or MemTest86) — these usually mean failing RAM.", action: copyCmd("mdsched.exe") },
    { text: "If you run an XMP/EXPO memory profile, test at stock speeds." },
    { text: "Update the BIOS and chipset drivers.", action: WUPDATE },
  ],
  cpu_hw: [
    { text: "Check temperatures and cooling — overheating triggers hardware faults." },
    { text: "Remove any CPU/RAM overclock and test at stock settings." },
    { text: "Update the BIOS; if it persists, run hardware diagnostics — the CPU/board/RAM may be failing.", action: WUPDATE },
  ],
  power: [
    { text: "Device Manager → disable \"Allow the computer to turn off this device to save power\" on your Wi-Fi and USB controllers.", action: DEVMGR },
    { text: "Update the BIOS, chipset (power-management framework), Wi-Fi, and graphics drivers.", action: WUPDATE },
    { text: "This is a sleep/resume driver fault — start with the network and graphics drivers, which are the usual offenders." },
  ],
  usb: [
    { text: "Update your USB controller and chipset drivers.", action: WUPDATE },
    { text: "Disconnect docks/hubs and external USB devices to isolate the culprit, then add them back one at a time." },
    { text: "Disable selective suspend / device power-off on the USB Root Hubs.", action: DEVMGR },
  ],
  corruption: [
    { text: "Run 'sfc /scannow', then 'DISM /Online /Cleanup-Image /RestoreHealth'.", action: copyCmd("sfc /scannow") },
    { text: "Check disk health — a failing drive corrupts system files." },
    { text: "If it began after an update, uninstall that update or roll back to a restore point." },
  ],
  driver: [
    { text: "Update your drivers — especially graphics, network, and chipset — from the OEM or Windows Update.", action: WUPDATE },
    { text: "If it started recently, roll back the most recently updated driver.", action: DEVMGR },
    { text: "Run 'sfc /scannow' to repair any damaged system files.", action: copyCmd("sfc /scannow") },
  ],
  unknown: [
    { text: "Update Windows, your drivers, and the BIOS to current versions.", action: WUPDATE },
    { text: "Note when it happens (idle, gaming, sleep, on battery) — the pattern narrows the cause." },
    { text: "Enable crash dumps (Automatic memory dump) so the next event can name the driver." },
  ],
};

/** Look up a stop code (any padding/case) → its full info, or null. */
export function lookupStopCode(code?: string | null): StopCodeInfo | null {
  if (!code) return null;
  const raw = parseInt(code.replace(/^0x/i, ""), 16);
  if (Number.isNaN(raw)) return null;
  // Some sources prefix a "shadow" 0x1000xxxx form (e.g. 0x1000007E for 0x7E);
  // fall back to the low 16 bits when the full value isn't known.
  const entry = TABLE[raw] ?? TABLE[raw & 0xffff] ?? null;
  if (!entry) return null;
  const n = TABLE[raw] ? raw : raw & 0xffff;
  const width = n > 0xffffffff ? 16 : 8;
  return {
    code: "0x" + n.toString(16).toUpperCase().padStart(width, "0"),
    ...entry,
  };
}

/** Remediation steps for an implicated subsystem. */
export function remediationFor(klass: CrashClass): RemediationStep[] {
  return CLASS_REMEDIATION[klass] ?? CLASS_REMEDIATION.unknown;
}
