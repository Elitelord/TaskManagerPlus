//! Display / monitor information and GPU adapter enumeration.
//!
//! Exposes Tauri commands that the frontend GPU page uses to render the
//! resolution/refresh-rate switchers and the adapter list.

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct DisplayMode {
    pub width: u32,
    pub height: u32,
    pub refresh_hz: u32,
    pub bpp: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct MonitorInfo {
    pub device_name: String,      // DEVMODE device (e.g. "\\\\.\\DISPLAY1")
    pub friendly_name: String,    // Monitor name (best effort)
    pub is_primary: bool,
    pub current: DisplayMode,
    /// Sorted, de-duplicated list of modes that share `current`'s bit depth.
    pub available_modes: Vec<DisplayMode>,
    /// Refresh rates available at the *current* resolution (sorted descending).
    pub refresh_rates_at_current: Vec<u32>,
    /// Unique resolutions (widthxheight) present in `available_modes`.
    pub resolutions: Vec<(u32, u32)>,
}

#[derive(Serialize, Clone, Debug)]
pub struct GpuAdapterInfo {
    pub name: String,
    pub vendor_id: u32,
    pub device_id: u32,
    pub dedicated_vram_bytes: u64,
    pub shared_memory_bytes: u64,
    pub is_integrated: bool,
    pub is_primary: bool,
    pub luid_high: i32,
    pub luid_low: u32,
}

#[cfg(windows)]
#[tauri::command]
pub fn list_monitors() -> Result<Vec<MonitorInfo>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayDevicesW, EnumDisplaySettingsExW, DEVMODEW, DISPLAY_DEVICEW,
        DISPLAY_DEVICE_ACTIVE, DISPLAY_DEVICE_PRIMARY_DEVICE, ENUM_CURRENT_SETTINGS,
        ENUM_DISPLAY_SETTINGS_FLAGS, ENUM_DISPLAY_SETTINGS_MODE,
    };

    let mut monitors: Vec<MonitorInfo> = Vec::new();

    unsafe {
        let mut idev: u32 = 0;
        loop {
            let mut dd: DISPLAY_DEVICEW = std::mem::zeroed();
            dd.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
            let ok = EnumDisplayDevicesW(PCWSTR::null(), idev, &mut dd, 0);
            if !ok.as_bool() {
                break;
            }
            idev += 1;

            // Skip inactive adapters (disconnected monitors)
            if (dd.StateFlags & DISPLAY_DEVICE_ACTIVE) == 0 {
                continue;
            }

            let device_name = widestr_to_string(&dd.DeviceName);
            let is_primary = (dd.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE) != 0;

            // Current mode
            let mut cur: DEVMODEW = std::mem::zeroed();
            cur.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
            let cur_pcwstr = PCWSTR::from_raw(dd.DeviceName.as_ptr());
            let current = if EnumDisplaySettingsExW(
                cur_pcwstr,
                ENUM_CURRENT_SETTINGS,
                &mut cur,
                ENUM_DISPLAY_SETTINGS_FLAGS(0),
            )
            .as_bool()
            {
                DisplayMode {
                    width: cur.dmPelsWidth,
                    height: cur.dmPelsHeight,
                    refresh_hz: cur.dmDisplayFrequency,
                    bpp: cur.dmBitsPerPel,
                }
            } else {
                DisplayMode {
                    width: 0,
                    height: 0,
                    refresh_hz: 0,
                    bpp: 0,
                }
            };

            // Enumerate every supported mode
            let mut all_modes: Vec<DisplayMode> = Vec::new();
            let mut imode: u32 = 0;
            loop {
                let mut dm: DEVMODEW = std::mem::zeroed();
                dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
                let ok = EnumDisplaySettingsExW(
                    cur_pcwstr,
                    ENUM_DISPLAY_SETTINGS_MODE(imode),
                    &mut dm,
                    ENUM_DISPLAY_SETTINGS_FLAGS(0),
                );
                imode += 1;
                if !ok.as_bool() {
                    break;
                }
                // Filter to the current bit depth so we don't show weird 8-bit modes
                if current.bpp != 0 && dm.dmBitsPerPel != current.bpp {
                    continue;
                }
                all_modes.push(DisplayMode {
                    width: dm.dmPelsWidth,
                    height: dm.dmPelsHeight,
                    refresh_hz: dm.dmDisplayFrequency,
                    bpp: dm.dmBitsPerPel,
                });
            }

            // De-duplicate
            all_modes.sort_by(|a, b| {
                b.width
                    .cmp(&a.width)
                    .then(b.height.cmp(&a.height))
                    .then(b.refresh_hz.cmp(&a.refresh_hz))
            });
            all_modes.dedup_by(|a, b| {
                a.width == b.width && a.height == b.height && a.refresh_hz == b.refresh_hz
            });

            // Unique resolutions
            let mut resolutions: Vec<(u32, u32)> = Vec::new();
            for m in &all_modes {
                let pair = (m.width, m.height);
                if !resolutions.contains(&pair) {
                    resolutions.push(pair);
                }
            }

            // Refresh rates at the current resolution (sorted desc, unique)
            let mut refresh_rates_at_current: Vec<u32> = all_modes
                .iter()
                .filter(|m| m.width == current.width && m.height == current.height)
                .map(|m| m.refresh_hz)
                .collect();
            refresh_rates_at_current.sort_unstable_by(|a, b| b.cmp(a));
            refresh_rates_at_current.dedup();

            // EnumDisplayDevices trick: calling it with the adapter's
            // DeviceName as the first arg pivots the returned struct to
            // describe the *monitor* attached to that adapter, and
            // DeviceString then holds the monitor's friendly name.
            let friendly_name = {
                let mut mon: DISPLAY_DEVICEW = std::mem::zeroed();
                mon.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
                let mon_ok = EnumDisplayDevicesW(cur_pcwstr, 0, &mut mon, 0);
                if mon_ok.as_bool() {
                    let s = widestr_to_string(&mon.DeviceString);
                    // Generic "Generic PnP Monitor" is almost useless; blank it
                    // out so the frontend falls back to Primary/Secondary.
                    if s.trim().is_empty() || s.eq_ignore_ascii_case("Generic PnP Monitor") {
                        String::new()
                    } else {
                        s
                    }
                } else {
                    String::new()
                }
            };

            monitors.push(MonitorInfo {
                device_name,
                friendly_name,
                is_primary,
                current,
                available_modes: all_modes,
                refresh_rates_at_current,
                resolutions,
            });
        }
    }

    // Sort: primary first, then by device name for stable order.
    monitors.sort_by(|a, b| {
        b.is_primary
            .cmp(&a.is_primary)
            .then_with(|| a.device_name.cmp(&b.device_name))
    });

    Ok(monitors)
}

#[cfg(not(windows))]
#[tauri::command]
pub fn list_monitors() -> Result<Vec<MonitorInfo>, String> {
    Ok(vec![])
}

#[cfg(windows)]
#[tauri::command]
pub fn set_display_mode(
    device_name: String,
    width: u32,
    height: u32,
    refresh_hz: u32,
) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        ChangeDisplaySettingsExW, EnumDisplaySettingsExW, CDS_UPDATEREGISTRY, DEVMODEW,
        DISP_CHANGE_SUCCESSFUL, DM_DISPLAYFREQUENCY, DM_PELSHEIGHT, DM_PELSWIDTH,
        ENUM_CURRENT_SETTINGS, ENUM_DISPLAY_SETTINGS_FLAGS,
    };

    let wide_name: Vec<u16> = device_name.encode_utf16().chain(std::iter::once(0)).collect();
    let name_pcwstr = PCWSTR::from_raw(wide_name.as_ptr());

    unsafe {
        let mut dm: DEVMODEW = std::mem::zeroed();
        dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;

        // Start from current to preserve fields we don't touch
        let _ = EnumDisplaySettingsExW(
            name_pcwstr,
            ENUM_CURRENT_SETTINGS,
            &mut dm,
            ENUM_DISPLAY_SETTINGS_FLAGS(0),
        );

        dm.dmPelsWidth = width;
        dm.dmPelsHeight = height;
        dm.dmDisplayFrequency = refresh_hz;
        dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY;

        let rc = ChangeDisplaySettingsExW(name_pcwstr, Some(&dm), None, CDS_UPDATEREGISTRY, None);
        if rc != DISP_CHANGE_SUCCESSFUL {
            return Err(format!("ChangeDisplaySettingsEx failed: code {}", rc.0));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn set_display_mode(
    _device_name: String,
    _width: u32,
    _height: u32,
    _refresh_hz: u32,
) -> Result<(), String> {
    Err("Display mode switching is only supported on Windows".to_string())
}

#[cfg(windows)]
#[tauri::command]
pub fn list_gpu_adapters() -> Result<Vec<GpuAdapterInfo>, String> {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, DXGI_ADAPTER_DESC1,
        DXGI_ADAPTER_FLAG_SOFTWARE,
    };

    let mut out: Vec<GpuAdapterInfo> = Vec::new();

    unsafe {
        let factory: IDXGIFactory1 = match CreateDXGIFactory1::<IDXGIFactory1>() {
            Ok(f) => f,
            Err(e) => return Err(format!("CreateDXGIFactory1 failed: {e:?}")),
        };

        let mut i: u32 = 0;
        loop {
            let adapter: IDXGIAdapter1 = match factory.EnumAdapters1(i) {
                Ok(a) => a,
                Err(_) => break,
            };
            i += 1;

            let desc: DXGI_ADAPTER_DESC1 = match adapter.GetDesc1() {
                Ok(d) => d,
                Err(_) => continue,
            };

            // Skip Microsoft Basic Render (software WARP) adapter
            if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                continue;
            }

            let dedicated = desc.DedicatedVideoMemory as u64;
            let shared = desc.SharedSystemMemory as u64;
            let is_integrated = dedicated < (1u64 << 30) && shared > dedicated.saturating_mul(2);
            let name = {
                let len = desc
                    .Description
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(desc.Description.len());
                String::from_utf16_lossy(&desc.Description[..len])
                    .trim()
                    .to_string()
            };

            out.push(GpuAdapterInfo {
                name,
                vendor_id: desc.VendorId,
                device_id: desc.DeviceId,
                dedicated_vram_bytes: dedicated,
                shared_memory_bytes: shared,
                is_integrated,
                // We'll mark the primary below based on the largest-footprint rule
                is_primary: false,
                luid_high: desc.AdapterLuid.HighPart,
                luid_low: desc.AdapterLuid.LowPart,
            });

            // Drop the adapter ref
            drop(adapter);
        }
    }

    // Mark the adapter that our telemetry picks as "primary" so the UI can
    // highlight it (same scoring as performance_telemetry.cpp).
    if !out.is_empty() {
        let mut best_idx = 0;
        let mut best_score: u64 = 0;
        for (idx, a) in out.iter().enumerate() {
            let score = a.dedicated_vram_bytes + a.shared_memory_bytes / 2;
            if score > best_score {
                best_score = score;
                best_idx = idx;
            }
        }
        out[best_idx].is_primary = true;
    }

    Ok(out)
}

#[cfg(not(windows))]
#[tauri::command]
pub fn list_gpu_adapters() -> Result<Vec<GpuAdapterInfo>, String> {
    Ok(vec![])
}

/// Open the Windows "Graphics settings" page (per-app GPU preference picker).
/// This is the standard way to steer an app onto the dGPU vs iGPU on hybrid
/// laptops — actual GPU switching is otherwise owned by the driver's MUX.
#[cfg(windows)]
#[tauri::command]
pub fn open_graphics_settings() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("cmd")
        .args(["/c", "start", "", "ms-settings:display-advancedgraphics"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| format!("Failed to open graphics settings: {e}"))?;
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn open_graphics_settings() -> Result<(), String> {
    Err("Graphics settings URI only available on Windows".to_string())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn widestr_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len]).trim().to_string()
}
