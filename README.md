# TaskManager+

A modern, feature-rich Windows Task Manager alternative with real-time performance monitoring, intelligent system insights, and a premium dark UI.

> **This application is not code-signed.** Windows SmartScreen may show a warning when you first run it. See [Installation](#installation) for how to bypass this safely.

---

## Download

**[Download Latest Release (Windows x64)](https://github.com/Elitelord/TaskManagerPlus/releases/latest)**

Download the `TaskManagerPlus_x.x.x_x64-setup.exe` installer from the latest release.

---

## Installation

### Windows SmartScreen Warning

Because this app is **not code-signed** (code signing certificates cost $200-400/year), Windows will show a SmartScreen warning the first time you run the installer or the app.

**How to bypass:**

1. When you see **"Windows protected your PC"**, click **"More info"**
2. Click **"Run anyway"**

This is standard behavior for any unsigned application. The full source code is available in this repository for review.

### Install Steps

1. Download `TaskManagerPlus_x.x.x_x64-setup.exe` from [Releases](https://github.com/Elitelord/TaskManagerPlus/releases/latest)
2. Run the installer (bypass SmartScreen as described above)
3. The app installs and creates a Start Menu shortcut
4. Updates are checked automatically on launch

---

## Features

### Process Management
- Real-time process list grouped by application with expand/collapse
- CPU, memory, disk I/O, network, GPU, and power usage per process
- Process icons, status badges (running/suspended), and group counts
- Right-click context menu with End Task and priority controls
- Search/filter processes by name
- Configurable column visibility

### Performance Monitoring
- **CPU** - Live usage graph, per-core grid with P-core/E-core labels, frequency tracking
- **Memory** - Usage graph with stacked breakdown, composition bar (in use/cached/available), memory pressure indicator, page file usage
- **Disk** - Read/write throughput graph, active %, queue depth, top consumers
- **Network** - Send/receive throughput graph, link speed, top bandwidth consumers
- **GPU** - Usage and VRAM graph, temperature monitoring (via D3DKMT API), top GPU consumers
- **Battery** - Power draw graph, charge status, battery health, power flow visualization, per-process power estimates, cycle count

### Insights (Smart Diagnostics)
- **Performance Score** (0-100) with real-time system health gauge
- **Memory leak detection** using linear regression on per-process memory trends
- **Workload detection** - Automatically identifies gaming, editing, development, browsing, streaming, office, or idle workloads based on running processes
- **Fan profile suggestions** - Recommends Silent/Balanced/Performance/Turbo based on detected workload
- **Optimization suggestions** - Context-aware recommendations to close unneeded apps (e.g., "Close browser to free 1.2 GB for gaming")
- **Bottleneck detection** - Sustained high CPU, disk saturation, network saturation alerts
- **GPU temperature warnings** with thermal throttling alerts
- **Battery health assessment** and high power drain warnings
- **Handle/thread leak detection** via trend analysis
- Analysis runs continuously in background, persists across tab switches

### System Tray Widget
- Compact popup showing CPU, memory, disk, network, GPU at a glance
- Smart positioning that stays within monitor bounds
- Click to open full app

### Settings
- Dark/Light theme with accent color presets (8 colors)
- Graph size: Small / Medium / Large
- Display mode: Percent / Values
- Temperature unit: Celsius / Fahrenheit
- Column visibility toggles
- Update interval (500ms - 5s)
- Confirm before ending tasks toggle
- Minimize to tray toggle

### Auto-Updater
- Checks for updates from GitHub Releases on launch
- One-click update and restart
- Cryptographically signed update packages

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19, TypeScript 6, Vite 8 |
| **Backend** | Tauri v2 (Rust) as IPC bridge |
| **Native** | C++ DLL for Windows performance counters, process enumeration, GPU telemetry |
| **UI** | Custom CSS with glassmorphism, neumorphic controls, system-native fonts |
| **Charts** | Canvas-based real-time graphs with requestAnimationFrame |
| **State** | TanStack React Query for data fetching, global listener pattern for settings |
| **Distribution** | NSIS installer, Tauri auto-updater with signature verification |

### Architecture

```
React UI (TypeScript)
    |
    | Tauri IPC (invoke)
    v
Rust Backend (src-tauri/)
    |
    | FFI (libloading)
    v
C++ DLL (native/)
    |
    | Windows APIs
    v
PDH Counters, DXGI, D3DKMT, NtQuerySystemInformation
```

### Key APIs Used
- **PDH (Performance Data Helper)** - CPU, disk, network counters
- **PROCESS_MEMORY_COUNTERS_EX** - Per-process memory (private, shared, working set)
- **DXGI** - GPU adapter enumeration and VRAM info
- **D3DKMTQueryAdapterInfo** - Cross-vendor GPU temperature (WDDM 2.5+)
- **NtQuerySystemInformation** - CPU set topology (P-core/E-core detection)
- **GetSystemPowerStatus / IOCTL_BATTERY** - Battery and power telemetry

---

## Building from Source

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/) (latest stable)
- [Visual Studio 2022](https://visualstudio.microsoft.com/) with C++ Desktop workload
- [CMake](https://cmake.org/) (3.20+)

### Steps

```bash
# Clone
git clone https://github.com/Elitelord/TaskManagerPlus.git
cd TaskManagerPlus

# Install dependencies
npm install

# Build native DLL (first time only)
cd native && cmake -B build -G "Visual Studio 17 2022" && cmake --build build --config Release && cd ..

# Dev mode (hot reload)
npx tauri dev

# Production build
npx tauri build
```

The installer will be at `src-tauri/target/release/bundle/nsis/TaskManagerPlus_x.x.x_x64-setup.exe`.

---

## Disclaimer

This software is provided as-is, without warranty of any kind. This application is **not code-signed** and is not verified by Microsoft. Windows SmartScreen and antivirus software may flag it as unrecognized. The complete source code is available in this repository for transparency and security review.

This application requires access to Windows performance counters and process information to function. It does not collect, transmit, or store any personal data.

---

## License

ISC
