//! Bluetooth device inventory and basic control.
//!
//! Scope — read-only enumeration of paired devices + Unpair. The Windows
//! Bluetooth APIs here are the classic Win32 surface (`BluetoothAPIs.lib`).
//!
//! On *Connect* and *Disconnect*: the legacy `BluetoothSetServiceState` API is
//! effectively a no-op for modern audio (A2DP/HFP), BLE peripherals, and most
//! HID — the audio bus driver and BthLEEnum stack hold their own session
//! state above this layer, and either return ERROR_INVALID_PARAMETER or
//! silently succeed without dropping the connection. Implementing real
//! connect/disconnect needs the WinRT stack (`AudioPlaybackConnection`,
//! `BluetoothDevice` + GATT) with per-profile branching. Until that arrives,
//! the UI routes those buttons to `ms-settings:bluetooth` instead of lying
//! about the result. Unpair stays inline because `BluetoothRemoveDevice` is
//! a registry-level removal that works regardless of session state.
//!
//! Design note — no background polling:
//!   All functions in this module are invoked *only* in response to an explicit
//!   user action on the Bluetooth page (mount, refresh button, device-row
//!   action). They are never wired into the 1-second `usePerformanceData` loop.
//!   `get_bluetooth_snapshot` calls `BluetoothFindFirstDevice` with
//!   `fIssueInquiry = FALSE`, which reads from the stack cache rather than
//!   issuing a live radio scan — typical cost is <100 ms.

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct BluetoothRadio {
    pub name: String,
    pub address: String,         // "XX:XX:XX:XX:XX:XX"
    pub manufacturer_id: u16,
    pub class_of_device: u32,
    pub subversion: u16,
    pub discoverable: bool,      // accepting inquiries
    pub connectable: bool,       // accepting incoming connections
}

#[derive(Serialize, Clone, Debug)]
pub struct BluetoothDeviceSnapshot {
    pub address: String,
    pub name: String,
    pub class_of_device: u32,
    pub major_class: String,       // "Audio", "Peripheral", "Phone", ...
    pub minor_class: String,       // "Headphones", "Keyboard", ...
    pub connected: bool,
    pub authenticated: bool,       // paired
    pub remembered: bool,
    pub last_seen_unix: i64,       // 0 if never seen
    pub last_used_unix: i64,       // 0 if never used
}

#[derive(Serialize, Clone, Debug)]
pub struct BluetoothSnapshot {
    /// `false` only if the platform is non-Windows.
    pub supported: bool,
    /// True iff at least one radio exists on the machine.
    pub radio_present: bool,
    pub radios: Vec<BluetoothRadio>,
    pub devices: Vec<BluetoothDeviceSnapshot>,
    /// Populated when enumeration failed or returned nothing useful; UI shows
    /// this instead of an empty table so the user knows what's going on.
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Read-only enumeration of Bluetooth radios + paired/remembered devices.
/// Called once on page mount and on explicit user refresh — never polled.
#[cfg(windows)]
#[tauri::command]
pub async fn get_bluetooth_snapshot() -> Result<BluetoothSnapshot, String> {
    tauri::async_runtime::spawn_blocking(win::enumerate)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn get_bluetooth_snapshot() -> Result<BluetoothSnapshot, String> {
    Ok(BluetoothSnapshot {
        supported: false,
        radio_present: false,
        radios: vec![],
        devices: vec![],
        error: Some("Bluetooth is only supported on Windows".to_string()),
    })
}

/// Unpair a device. Destructive — the device must be re-paired to use again.
/// UI must confirm with the user before calling.
#[cfg(windows)]
#[tauri::command]
pub async fn bluetooth_remove_device(address: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || win::remove(&address))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn bluetooth_remove_device(_address: String) -> Result<(), String> {
    Err("Bluetooth is only supported on Windows".to_string())
}

/// Opens `ms-settings:bluetooth`. Escape hatch for radio on/off until the
/// Phase 2 WinRT integration lands — mirrors `open_graphics_settings`.
#[cfg(windows)]
#[tauri::command]
pub fn open_bluetooth_settings() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("cmd")
        .args(["/c", "start", "", "ms-settings:bluetooth"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| format!("Failed to open bluetooth settings: {e}"))?;
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn open_bluetooth_settings() -> Result<(), String> {
    Err("Bluetooth settings URI only available on Windows".to_string())
}

// ---------------------------------------------------------------------------
// Windows implementation
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod win {
    use super::*;
    use windows::Win32::Devices::Bluetooth::{
        BluetoothFindDeviceClose, BluetoothFindFirstDevice, BluetoothFindFirstRadio,
        BluetoothFindNextDevice, BluetoothFindNextRadio, BluetoothFindRadioClose,
        BluetoothGetRadioInfo, BluetoothIsConnectable, BluetoothIsDiscoverable,
        BluetoothRemoveDevice, BLUETOOTH_ADDRESS, BLUETOOTH_DEVICE_INFO,
        BLUETOOTH_DEVICE_SEARCH_PARAMS, BLUETOOTH_FIND_RADIO_PARAMS, BLUETOOTH_RADIO_INFO,
    };
    use windows::Win32::Foundation::{CloseHandle, HANDLE};

    /// Full snapshot. Never panics — returns an `error` field on hard failure.
    pub fn enumerate() -> Result<BluetoothSnapshot, String> {
        let mut snap = BluetoothSnapshot {
            supported: true,
            radio_present: false,
            radios: Vec::new(),
            devices: Vec::new(),
            error: None,
        };

        // --- Radios ---------------------------------------------------------
        let radio_handles = match collect_radios() {
            Ok(h) => h,
            Err(e) => {
                // ERROR_NO_MORE_ITEMS (no radios) is normal — surface as empty, not error.
                if e == "no-radios" {
                    return Ok(snap);
                }
                snap.error = Some(format!("radio enumeration failed: {e}"));
                return Ok(snap);
            }
        };
        snap.radio_present = !radio_handles.is_empty();

        for &h in &radio_handles {
            match radio_info(h) {
                Ok(r) => snap.radios.push(r),
                Err(e) => log::warn!("BluetoothGetRadioInfo failed: {e}"),
            }
        }

        // --- Devices (paired / remembered only; no live inquiry) -----------
        // Note: we enumerate against the FIRST radio. On multi-radio machines
        // (rare) we'd iterate, but BluetoothAPIs returns device rows scoped to
        // the whole stack anyway, so one call is sufficient.
        if let Some(&h) = radio_handles.first() {
            match enumerate_devices(h) {
                Ok(devs) => snap.devices = devs,
                Err(e) => {
                    snap.error = Some(format!("device enumeration failed: {e}"));
                }
            }
        }

        // Close all radio handles.
        for h in radio_handles {
            unsafe { let _ = CloseHandle(h); }
        }

        Ok(snap)
    }

    /// Unpair the device. `BluetoothRemoveDevice` takes a BLUETOOTH_ADDRESS
    /// pointer and operates across the whole stack (no radio handle needed).
    pub fn remove(address_str: &str) -> Result<(), String> {
        let address = parse_address(address_str)?;
        let rc = unsafe { BluetoothRemoveDevice(&address) };
        if rc != 0 {
            return Err(format!("BluetoothRemoveDevice failed: Win32 error {rc}"));
        }
        Ok(())
    }

    // ---- helpers ----------------------------------------------------------

    fn collect_radios() -> Result<Vec<HANDLE>, String> {
        let mut handles = Vec::new();
        unsafe {
            let params = BLUETOOTH_FIND_RADIO_PARAMS {
                dwSize: std::mem::size_of::<BLUETOOTH_FIND_RADIO_PARAMS>() as u32,
            };
            let mut first_radio: HANDLE = HANDLE::default();
            let find = match BluetoothFindFirstRadio(&params, &mut first_radio) {
                Ok(h) => h,
                Err(_) => return Err("no-radios".to_string()),
            };
            handles.push(first_radio);
            loop {
                let mut next: HANDLE = HANDLE::default();
                if BluetoothFindNextRadio(find, &mut next).is_err() {
                    break;
                }
                handles.push(next);
            }
            let _ = BluetoothFindRadioClose(find);
        }
        Ok(handles)
    }

    fn radio_info(handle: HANDLE) -> Result<BluetoothRadio, String> {
        unsafe {
            let mut info = BLUETOOTH_RADIO_INFO {
                dwSize: std::mem::size_of::<BLUETOOTH_RADIO_INFO>() as u32,
                ..std::mem::zeroed()
            };
            let rc = BluetoothGetRadioInfo(handle, &mut info);
            if rc != 0 {
                return Err(format!("win32 error {rc}"));
            }
            Ok(BluetoothRadio {
                name: widestr_to_string(&info.szName),
                address: format_address(&info.address),
                manufacturer_id: info.manufacturer,
                class_of_device: info.ulClassofDevice,
                subversion: info.lmpSubversion,
                discoverable: BluetoothIsDiscoverable(handle).as_bool(),
                connectable: BluetoothIsConnectable(handle).as_bool(),
            })
        }
    }

    fn enumerate_devices(radio: HANDLE) -> Result<Vec<BluetoothDeviceSnapshot>, String> {
        let mut out = Vec::new();
        unsafe {
            // IMPORTANT: fIssueInquiry = FALSE — no live radio scan.
            // We want paired + remembered + connected devices only, from cache.
            let search = BLUETOOTH_DEVICE_SEARCH_PARAMS {
                dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32,
                fReturnAuthenticated: true.into(),
                fReturnRemembered: true.into(),
                fReturnUnknown: false.into(),
                fReturnConnected: true.into(),
                fIssueInquiry: false.into(),
                cTimeoutMultiplier: 0,
                hRadio: radio,
            };

            let mut info = empty_device_info();
            let find = match BluetoothFindFirstDevice(&search, &mut info) {
                Ok(h) => h,
                Err(_) => return Ok(out), // No devices is a normal empty-list case.
            };
            out.push(device_from_info(&info));

            loop {
                let mut next = empty_device_info();
                if BluetoothFindNextDevice(find, &mut next).is_err() {
                    break;
                }
                out.push(device_from_info(&next));
            }
            let _ = BluetoothFindDeviceClose(find);
        }
        Ok(out)
    }

    fn device_from_info(info: &BLUETOOTH_DEVICE_INFO) -> BluetoothDeviceSnapshot {
        let (major, minor) = classify_device(info.ulClassofDevice);
        BluetoothDeviceSnapshot {
            address: format_address(&info.Address),
            name: widestr_to_string(&info.szName),
            class_of_device: info.ulClassofDevice,
            major_class: major.to_string(),
            minor_class: minor.to_string(),
            connected: info.fConnected.as_bool(),
            authenticated: info.fAuthenticated.as_bool(),
            remembered: info.fRemembered.as_bool(),
            last_seen_unix: systemtime_to_unix(&info.stLastSeen),
            last_used_unix: systemtime_to_unix(&info.stLastUsed),
        }
    }

    fn empty_device_info() -> BLUETOOTH_DEVICE_INFO {
        unsafe {
            let mut info: BLUETOOTH_DEVICE_INFO = std::mem::zeroed();
            info.dwSize = std::mem::size_of::<BLUETOOTH_DEVICE_INFO>() as u32;
            info
        }
    }

    /// Bluetooth Class of Device — major/minor decode per Assigned Numbers spec.
    /// Only the common buckets; unrecognized values fall back to numeric codes.
    fn classify_device(cod: u32) -> (&'static str, &'static str) {
        let major = (cod >> 8) & 0x1F;
        let minor = (cod >> 2) & 0x3F;
        let major_name = match major {
            0x01 => "Computer",
            0x02 => "Phone",
            0x03 => "Network",
            0x04 => "Audio/Video",
            0x05 => "Peripheral",
            0x06 => "Imaging",
            0x07 => "Wearable",
            0x08 => "Toy",
            0x09 => "Health",
            _ => "Other",
        };
        let minor_name = match (major, minor) {
            (0x04, 0x01) => "Headset",
            (0x04, 0x02) => "Hands-free",
            (0x04, 0x04) => "Microphone",
            (0x04, 0x05) => "Speaker",
            (0x04, 0x06) => "Headphones",
            (0x04, 0x0B) => "Video display",
            (0x05, m) if m & 0x10 != 0 => "Keyboard",
            (0x05, m) if m & 0x20 != 0 => "Pointing device",
            (0x01, 0x03) => "Laptop",
            (0x02, 0x03) => "Smartphone",
            _ => "",
        };
        (major_name, minor_name)
    }

    fn parse_address(s: &str) -> Result<BLUETOOTH_ADDRESS, String> {
        let clean: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
        if clean.len() != 12 {
            return Err(format!("invalid BT address: {s}"));
        }
        let mut bytes = [0u8; 6];
        for i in 0..6 {
            bytes[5 - i] = u8::from_str_radix(&clean[i * 2..i * 2 + 2], 16)
                .map_err(|_| format!("invalid hex in BT address: {s}"))?;
        }
        let mut addr: BLUETOOTH_ADDRESS = unsafe { std::mem::zeroed() };
        addr.Anonymous.rgBytes = bytes;
        Ok(addr)
    }

    fn format_address(a: &BLUETOOTH_ADDRESS) -> String {
        let b = unsafe { a.Anonymous.rgBytes };
        format!(
            "{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
            b[5], b[4], b[3], b[2], b[1], b[0]
        )
    }

    fn widestr_to_string(buf: &[u16]) -> String {
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..len]).trim().to_string()
    }

    fn systemtime_to_unix(st: &windows::Win32::Foundation::SYSTEMTIME) -> i64 {
        // Guard the "never" sentinel (all-zero SYSTEMTIME).
        if st.wYear == 0 { return 0; }
        // Cheap conversion — day accuracy is plenty for "last seen 3d ago" UIs.
        // Full SYSTEMTIME → FILETIME conversion is available via SystemTimeToFileTime
        // if we need second-level precision later.
        use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
        let date = NaiveDate::from_ymd_opt(st.wYear as i32, st.wMonth as u32, st.wDay as u32);
        let time = NaiveTime::from_hms_opt(st.wHour as u32, st.wMinute as u32, st.wSecond as u32);
        match (date, time) {
            (Some(d), Some(t)) => NaiveDateTime::new(d, t).and_utc().timestamp(),
            _ => 0,
        }
    }
}
