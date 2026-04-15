# Per-OEM Feature Plan

Features that require vendor-specific code paths because Windows exposes no universal API. All of these sit on top of either (a) a pre-installed OEM WMI interface that ships with the vendor's driver stack, or (b) direct EC / MSR access via a signed kernel helper driver.

## Legend

**Difficulty**
- **Low** — documented vendor WMI, stable across models, no driver shipping required.
- **Med** — undocumented WMI / reverse-engineered method IDs, varies by model generation, driver must already be loaded on user's machine.
- **High** — requires direct EC port I/O (`0x62/0x66`) or MSR access through a signed Ring-0 helper (`WinRing0`, `RwDrv`, or a custom driver). AV / HVCI / Smart App Control friction.
- **Very High** — model-by-model reverse engineering, signing liability, or SMM / UEFI-only.

**Access tier**
- **WMI-public** — documented `root\wmi` or `root\CIMV2` class.
- **WMI-private** — undocumented vendor namespace, method-ID based.
- **EC-direct** — must poke EC registers through a kernel driver.
- **MSR** — requires `rdmsr`/`wrmsr` via Ring 0.

---

## Feature matrix

### 1. Battery charge limit (stop charging at N%)

| OEM | Access | Difficulty | Notes |
|---|---|---|---|
| Lenovo (ThinkPad, IdeaPad, Legion) | WMI-private `root\WMI\LENOVO_GAMEZONE_DATA` / `LENOVO_UTILITY_DATA` | Low–Med | Method `SetBatteryChargeThreshold` on ThinkPads; Legion uses `SetFeatureValue(0x13)`. Driver (`ibmpmsvc` / `LenovoVantageService`) usually pre-installed. |
| ASUS (ROG, TUF, ZenBook, Vivobook) | WMI-private `\root\wmi\AsusAtkWmi_WMNB` method `DSTS/DEVS` with ID `0x00120057` | Med | Method IDs differ ROG vs ZenBook. G-Helper is the reference implementation. Needs `asus-nb-wmi` / `atkwmiacpi64.sys` loaded. |
| Dell (Latitude, XPS, Inspiron, Precision) | WMI-public `root\DCIM\SYSMAN\DCIM_Battery` via `BIOSAttributeInt` | Low | Clean, documented via Dell Command \| Configure. Thresholds: `PrimaryBattChargeCfg`. Works without extra driver on most models. |
| HP (EliteBook, ProBook, ZBook, Omen) | WMI-public `root\HP\InstrumentedBIOS` class `HP_BIOSSetting` | Low–Med | "Battery Health Manager" setting, values `Maximize my battery life` / `Adaptive`. No % slider, just modes. Omen uses different path. |
| Microsoft Surface | UEFI only | Very High | No runtime API. "Battery Limit" is a UEFI toggle (50% fixed), not runtime. |
| Razer | EC-direct | High | Razer Synapse hooks EC directly; would need reverse engineering. |
| MSI | WMI-private `\root\WMI\MSI_CENTER` | Med | Creator Center / MSI Center exposes "Battery Master" with 50/70/80/100% presets. |
| Samsung Galaxy Book | WMI-private `\root\wmi\SamsungPowerIntegration` | Med | "Battery Life Extender" — binary (on/off at 80%), not arbitrary %. |
| Framework | EC-direct via `framework_tool` | Med | Open-source EC; official Python/Rust tool exists. Could call `framework_tool.exe --charge-limit` as subprocess. |
| Acer (Predator, Nitro, Swift) | WMI-private `\root\WMI\AcerGamingWMI` | Med | "Battery Limiter" in PredatorSense. |

### 2. Fan speed read / control

| OEM | Access | Difficulty | Notes |
|---|---|---|---|
| ASUS ROG / TUF | WMI-private `\root\wmi\AsusAtkWmi_WMNB` | Med–High | Read RPM: method `0x00110004`. Write fan curve: `0x00110024` / `0x00110025` (CPU/GPU). **This is exactly what G-Helper does.** Needs ASUS ACPI driver. |
| ASUS ZenBook / Vivobook | WMI-private | High | Different method IDs, silent-standard-turbo modes only (no curve). |
| Lenovo Legion | WMI-private `LENOVO_GAMEZONE_DATA` | Med | `GetFanSpeed`, `SetFanTable`. Legion Toolkit (open source) is the reference. |
| Lenovo ThinkPad | EC-direct or WMI `\root\wmi\ThinkPad_...` | High | `tpfancontrol` style; EC register 0x2F for control, 0x84 for RPM. Requires kernel driver. |
| Dell | EC-direct + `libsmbios` / `i8kfan` | Very High | Dell offers *no* WMI fan control. `i8kfan` (Linux) works via SMM calls — very risky on Windows without signed driver. |
| HP Omen / Victus | WMI-private `\root\WMI\HP_GamingWMIInterface` | Med | Omen Gaming Hub API; performance mode + fan max toggle. |
| MSI (gaming) | WMI-private + EC | Med–High | MSI Afterburner / Dragon Center; fan curve via EC writes. |
| Razer | EC-direct | Very High | Closed; requires Synapse reverse engineering. |
| Acer Predator | WMI-private | Med | `AcerGamingWMI` `SetFanSpeed`. |
| Framework | `framework_tool` subprocess | Low–Med | `fp-tool --fan-duty N` or similar. |
| Generic (any laptop) | LibreHardwareMonitor's bundled `WinRing0x64.sys` | High | Read-only RPM from EC via polling. **Shipping WinRing0 triggers SmartScreen + Defender flags** — vulnerable driver, Microsoft has it on the driver blocklist. |

### 3. Performance / power mode (Silent / Balanced / Turbo)

| OEM | Access | Difficulty | Notes |
|---|---|---|---|
| ASUS | WMI-private | Med | Method ID `0x00110019` — Silent=0x00, Perf=0x01, Turbo=0x02. |
| Lenovo Legion | WMI-private | Low–Med | `SetSmartFanMode` — Quiet/Balance/Perf/Custom. Legion Toolkit reference. |
| Lenovo ThinkPad | Intel DPTF / Microsoft slider | Low | Use Windows power slider + Intel DPTF — no vendor call needed. |
| Dell | `root\DCIM\SYSMAN` `ThermalConfig` | Low | Quiet/Cool/Ultra Performance. |
| HP Omen | WMI-private | Low | `HP_GamingWMIInterface` `SetPerformanceMode`. |
| MSI | WMI-private `MSI_CENTER` | Med | ECO / Balanced / High Performance / Turbo / Smart Auto. |
| Acer | WMI-private | Med | PredatorSense modes. |
| Razer | Synapse proxy | High | |
| Surface | Windows power slider | Low | Actually uses the standard Microsoft slider properly. |

### 4. Keyboard backlight control (brightness / RGB / per-key)

| OEM | Access | Difficulty | Notes |
|---|---|---|---|
| ASUS Aura | WMI-private + HID raw reports | Med–High | Static + breathing via WMI; per-key RGB via HID. Aura SDK exists but Windows-only DLL. |
| Razer Chroma | Chroma SDK (REST API) | Low | Official, documented. Requires Synapse running. |
| Corsair iCUE | iCUE SDK | Low | Official. |
| MSI Mystic Light | Mystic Light SDK | Low–Med | Official SDK, C++. |
| Lenovo Legion | WMI-private | Med | 4-zone RGB via `LENOVO_GAMEZONE_DATA`. |
| Lenovo ThinkPad | WMI `ThinkLight` | Low | Just on/off or dim/bright for ThinkLight / backlight. |
| HP Omen | WMI-private | Med | OmenLight SDK. |
| Dell Alienware | AlienFX SDK | Med | Historical SDK, deprecated. |

### 5. CPU undervolt / TDP limits

| OEM / Vendor | Access | Difficulty | Notes |
|---|---|---|---|
| Intel (generic) | MSR `0x150` (VoltagePlane) | High | ThrottleStop / XTU work this way. Since 10th gen, many mobile BIOSes lock MSR writes (plundervolt mitigation). |
| AMD | SMU mailbox via EC / PCI | Very High | RyzenAdj is the reference. Requires signed kernel driver; very CPU-model-specific. |
| ASUS | WMI-private PPT/TDP | Med | `SetPPT` methods — clean path that doesn't need MSR. G-Helper uses this. |
| Lenovo Legion | WMI-private | Med | `SetTDPMode`. |

### 6. Display: GPU MUX switch, refresh rate, color profile

| OEM | Access | Difficulty | Notes |
|---|---|---|---|
| ASUS ROG | WMI-private | Med | `SetMuxMode` (dGPU-only vs Optimus). Requires reboot. |
| Lenovo Legion | WMI-private | Med | Same — MUX toggle. |
| Razer | Synapse | High | |
| Generic refresh rate | Windows `ChangeDisplaySettingsEx` | Low | No OEM code needed. |
| Panel overdrive / G-Sync | WMI-private per OEM | High | |

---

## Implementation strategy

### Tier 1 — cheap wins (do first)

1. **Dell battery charge limit** — clean public WMI, biggest install base, no driver shipping.
2. **HP battery health mode** — public WMI, simple enum.
3. **Lenovo Legion performance mode + charge limit** — one namespace, well documented by Legion Toolkit authors, covers a huge gaming-laptop segment.
4. **ASUS perf mode + charge limit via G-Helper's known method IDs** — method IDs are public knowledge at this point; the ASUS driver is nearly always present on ASUS laptops.

All four can be done entirely from Rust using `wmi` crate + `windows` crate — **no native DLL changes, no kernel driver**.

### Tier 2 — reach features

5. **Fan RPM read-only** on ASUS / Lenovo Legion / HP Omen (WMI-private, read side is safe).
6. **Keyboard backlight** for Razer Chroma + Corsair iCUE (they have real SDKs).
7. **Framework laptop** via `framework_tool` subprocess — small user base but open-source and easy.

### Tier 3 — high effort, consider carefully

8. **Fan curve writing** — per OEM, risk of thermal damage if wrong, support burden.
9. **Generic EC read** via LibreHardwareMonitor driver — will get flagged by Defender; needs a first-class "you must accept this driver" flow.
10. **CPU undervolt / TDP** — BIOS-locked on most modern laptops, not worth it.

---

## Architecture recommendations

- **Detect OEM once at startup.** Read `Win32_ComputerSystem` (`Manufacturer`, `Model`). Then check which WMI namespaces actually exist (`root\wmi\AsusAtkWmi_WMNB`, `root\WMI\LENOVO_GAMEZONE_DATA`, `root\DCIM\SYSMAN`, `root\HP\InstrumentedBIOS`). Only expose UI that's actually actionable.
- **OEM module trait** in Rust:
  ```rust
  trait OemModule {
      fn name(&self) -> &'static str;
      fn supports_charge_limit(&self) -> Option<ChargeLimitCaps>;
      fn get_charge_limit(&self) -> Result<Option<u8>>;
      fn set_charge_limit(&self, pct: u8) -> Result<()>;
      fn supports_perf_mode(&self) -> Option<Vec<PerfMode>>;
      // ...etc
  }
  ```
  Dispatch at runtime based on detected OEM; implementations live in `src-tauri/src/oem/{dell,lenovo,asus,hp,msi}.rs`.
- **Never ship a kernel driver.** If LibreHardwareMonitor-style EC read becomes necessary later, make it opt-in with a separate installer and a very explicit security prompt.
- **Graceful fallback.** If the OEM is unknown, hide the per-OEM tabs entirely rather than showing broken controls.
- **Telemetry (opt-in) for detection hits / misses.** When a user's machine reports `Manufacturer=ASUS` but no `AsusAtkWmi_WMNB` namespace, that's useful signal for supporting more models.

## Reference projects to study

- **G-Helper** (github.com/seerge/g-helper) — ASUS, MIT-licensed, C#. Best source for ASUS method IDs.
- **Legion Toolkit** (github.com/BartoszCichecki/LenovoLegionToolkit) — Lenovo Legion, MIT, C#. Shows SetFeatureValue IDs.
- **framework_tool** (github.com/FrameworkComputer/framework-system) — Framework, Apache-2, Rust.
- **LibreHardwareMonitor** (github.com/LibreHardwareMonitor/LibreHardwareMonitor) — generic EC/SMBus via WinRing0.
- **RyzenAdj** (github.com/FlyGoat/RyzenAdj) — AMD SMU mailbox.
- **ThinkFan / tpfancontrol** — ThinkPad EC reference.
