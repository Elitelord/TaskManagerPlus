//! USB device inventory via SetupAPI.
//!
//! Called once on Devices-page mount and on explicit user refresh — never
//! polled. SetupAPI enumeration of present USB devices is fast (typically
//! <50 ms even on machines with many peripherals) but still runs inside
//! `spawn_blocking` so we never touch the Tauri main thread.

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct UsbDeviceInfo {
    /// Friendly name if the driver provided one, otherwise the device description.
    pub name: String,
    /// Manufacturer string (SPDRP_MFG).
    pub manufacturer: String,
    /// Windows device-class name — "HIDClass", "AudioEndpoint", "USB", "Net",
    /// "DiskDrive", "Image", "Ports", "Printer", "WPD", etc. The frontend
    /// maps this to a user-facing category.
    pub class: String,
    /// Raw description (SPDRP_DEVICEDESC) — often more specific than `class`.
    pub description: String,
    /// Vendor ID parsed from the hardware ID string, or 0 if unavailable.
    pub vendor_id: u16,
    /// Product ID parsed from the hardware ID string, or 0 if unavailable.
    pub product_id: u16,
    /// `USB\VID_xxxx&PID_yyyy&...` — kept as a stable row key.
    pub hardware_id: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct UsbSnapshot {
    pub supported: bool,
    pub devices: Vec<UsbDeviceInfo>,
    pub error: Option<String>,
}

#[cfg(windows)]
#[tauri::command]
pub async fn get_usb_devices() -> Result<UsbSnapshot, String> {
    tauri::async_runtime::spawn_blocking(win::enumerate)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn get_usb_devices() -> Result<UsbSnapshot, String> {
    Ok(UsbSnapshot {
        supported: false,
        devices: vec![],
        error: Some("USB is only supported on Windows".to_string()),
    })
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows::core::PCWSTR;
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW,
        SetupDiGetDeviceRegistryPropertyW, DIGCF_ALLCLASSES, DIGCF_PRESENT, SPDRP_CLASS,
        SPDRP_DEVICEDESC, SPDRP_FRIENDLYNAME, SPDRP_HARDWAREID, SPDRP_MFG, SP_DEVINFO_DATA,
    };
    use windows::Win32::Foundation::HWND;

    pub fn enumerate() -> Result<UsbSnapshot, String> {
        let mut snap = UsbSnapshot {
            supported: true,
            devices: Vec::new(),
            error: None,
        };

        // Filter to the "USB" enumerator — this excludes HID-child nodes and
        // other virtual devices whose parent is USB but aren't interesting in
        // a device list. DIGCF_PRESENT omits disconnected devices.
        let enumerator: Vec<u16> = "USB".encode_utf16().chain(std::iter::once(0)).collect();

        unsafe {
            let hdev = match SetupDiGetClassDevsW(
                None,
                PCWSTR::from_raw(enumerator.as_ptr()),
                HWND::default(),
                DIGCF_PRESENT | DIGCF_ALLCLASSES,
            ) {
                Ok(h) => h,
                Err(e) => {
                    snap.error = Some(format!("SetupDiGetClassDevs failed: {e:?}"));
                    return Ok(snap);
                }
            };

            let mut index: u32 = 0;
            loop {
                let mut data = SP_DEVINFO_DATA {
                    cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
                    ..std::mem::zeroed()
                };
                if SetupDiEnumDeviceInfo(hdev, index, &mut data).is_err() {
                    break;
                }
                index += 1;

                let description = read_string_property(hdev, &data, SPDRP_DEVICEDESC);
                let manufacturer = read_string_property(hdev, &data, SPDRP_MFG);
                let class = read_string_property(hdev, &data, SPDRP_CLASS);
                let friendly = read_string_property(hdev, &data, SPDRP_FRIENDLYNAME);
                let hardware_id = read_multi_string_first(hdev, &data, SPDRP_HARDWAREID);

                // Skip root hubs / host controllers — not useful in a user-facing list.
                let lower_desc = description.to_lowercase();
                if lower_desc.contains("root hub") || lower_desc.contains("host controller") {
                    continue;
                }

                let (vid, pid) = parse_vid_pid(&hardware_id);
                let name = if !friendly.trim().is_empty() { friendly } else { description.clone() };

                snap.devices.push(UsbDeviceInfo {
                    name,
                    manufacturer,
                    class,
                    description,
                    vendor_id: vid,
                    product_id: pid,
                    hardware_id,
                });
            }

            let _ = SetupDiDestroyDeviceInfoList(hdev);
        }

        // Stable sort: class, then name.
        snap.devices.sort_by(|a, b| {
            a.class
                .to_lowercase()
                .cmp(&b.class.to_lowercase())
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(snap)
    }

    /// Read a REG_SZ property into a stack buffer. Returns "" on any failure —
    /// missing properties on USB devices are routine (e.g. no FriendlyName).
    fn read_string_property(
        hdev: windows::Win32::Devices::DeviceAndDriverInstallation::HDEVINFO,
        data: &SP_DEVINFO_DATA,
        prop: windows::Win32::Devices::DeviceAndDriverInstallation::SETUP_DI_REGISTRY_PROPERTY,
    ) -> String {
        let mut buf = [0u8; 2048];
        let mut required: u32 = 0;
        let mut data_copy = *data;
        unsafe {
            let ok = SetupDiGetDeviceRegistryPropertyW(
                hdev,
                &mut data_copy,
                prop,
                None,
                Some(&mut buf),
                Some(&mut required),
            );
            if ok.is_err() {
                return String::new();
            }
            // Reinterpret the byte buffer as UTF-16.
            let used = (required as usize).min(buf.len());
            let wide_len = used / 2;
            let wide = std::slice::from_raw_parts(buf.as_ptr() as *const u16, wide_len);
            let end = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
            String::from_utf16_lossy(&wide[..end]).trim().to_string()
        }
    }

    /// REG_MULTI_SZ first-entry helper — SPDRP_HARDWAREID returns a list of
    /// strings; the first one is the most-specific identifier.
    fn read_multi_string_first(
        hdev: windows::Win32::Devices::DeviceAndDriverInstallation::HDEVINFO,
        data: &SP_DEVINFO_DATA,
        prop: windows::Win32::Devices::DeviceAndDriverInstallation::SETUP_DI_REGISTRY_PROPERTY,
    ) -> String {
        let s = read_string_property(hdev, data, prop);
        // read_string_property already trims at the first NUL, so for a
        // REG_MULTI_SZ we get the first string — exactly what we want.
        s
    }

    /// Parses "USB\VID_046D&PID_C52B&..." into (0x046D, 0xC52B).
    fn parse_vid_pid(hwid: &str) -> (u16, u16) {
        let upper = hwid.to_uppercase();
        let vid = find_hex_after(&upper, "VID_");
        let pid = find_hex_after(&upper, "PID_");
        (vid.unwrap_or(0), pid.unwrap_or(0))
    }

    fn find_hex_after(s: &str, tag: &str) -> Option<u16> {
        let idx = s.find(tag)? + tag.len();
        let rest = &s[idx..];
        let hex: String = rest.chars().take(4).collect();
        u16::from_str_radix(&hex, 16).ok()
    }
}
