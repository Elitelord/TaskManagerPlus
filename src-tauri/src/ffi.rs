use libloading::{Library, Symbol};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

// C-compatible structs matching the C++ DLL
#[repr(C)]
#[derive(Clone, Copy)]
pub struct RawProcessMemoryInfo {
    pub pid: u32,
    pub name: [u16; 260],
    pub display_name: [u16; 260],
    pub icon_base64: [u8; 16384],
    pub private_bytes: u64,
    pub working_set: u64,
    pub shared_bytes: u64,
    pub private_working_set: u64,
    pub page_faults: u64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RawProcessPowerInfo {
    pub pid: u32,
    pub battery_percent: f64,
    pub energy_uj: u64,
    pub cpu_percent: f64,
    pub power_watts: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RawProcessDiskInfo {
    pub pid: u32,
    pub read_bytes_per_sec: f64,
    pub write_bytes_per_sec: f64,
    pub total_read_bytes: u64,
    pub total_write_bytes: u64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RawProcessNetworkInfo {
    pub pid: u32,
    pub send_bytes_per_sec: f64,
    pub recv_bytes_per_sec: f64,
    pub total_sent: u64,
    pub total_received: u64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RawProcessGpuInfo {
    pub pid: u32,
    pub gpu_usage_percent: f64,
    pub gpu_memory_bytes: u64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RawProcessNpuInfo {
    pub pid: u32,
    pub npu_usage_percent: f64,
    pub npu_dedicated_bytes: u64,
    pub npu_shared_bytes: u64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RawProcessStatusInfo {
    pub pid: u32,
    pub status: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RawSystemInfo {
    pub total_ram_mb: u64,
    pub used_ram_mb: u64,
    pub cpu_usage_percent: f64,
    pub battery_percent: f64,
    pub is_charging: i32,
    pub process_count: u32,
    pub total_disk_read_per_sec: f64,
    pub total_disk_write_per_sec: f64,
    pub total_net_send_per_sec: f64,
    pub total_net_recv_per_sec: f64,
    pub gpu_usage_percent: f64,
    pub power_draw_watts: f64,
    pub charge_rate_watts: f64,
}

// Serializable types for the frontend
#[derive(Serialize, Clone, Debug)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub display_name: String,
    pub icon_base64: String,
    pub private_mb: f64,
    pub shared_mb: f64,
    pub working_set_mb: f64,
    pub private_working_set_mb: f64,
    pub page_faults: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_type: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProcessPowerInfo {
    pub pid: u32,
    pub battery_percent: f64,
    pub energy_uj: u64,
    pub cpu_percent: f64,
    pub power_watts: f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProcessDiskInfo {
    pub pid: u32,
    pub read_bytes_per_sec: f64,
    pub write_bytes_per_sec: f64,
    pub total_read_bytes: u64,
    pub total_write_bytes: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProcessNetworkInfo {
    pub pid: u32,
    pub send_bytes_per_sec: f64,
    pub recv_bytes_per_sec: f64,
    pub total_sent: u64,
    pub total_received: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProcessGpuInfo {
    pub pid: u32,
    pub gpu_usage_percent: f64,
    pub gpu_memory_bytes: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProcessNpuInfo {
    pub pid: u32,
    pub npu_usage_percent: f64,
    pub npu_dedicated_bytes: u64,
    pub npu_shared_bytes: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProcessStatusInfo {
    pub pid: u32,
    pub status: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct SystemInfo {
    pub total_ram_mb: u64,
    pub used_ram_mb: u64,
    pub cpu_usage_percent: f64,
    pub battery_percent: f64,
    pub is_charging: bool,
    pub process_count: u32,
    pub total_disk_read_per_sec: f64,
    pub total_disk_write_per_sec: f64,
    pub total_net_send_per_sec: f64,
    pub total_net_recv_per_sec: f64,
    pub gpu_usage_percent: f64,
    pub power_draw_watts: f64,
    pub charge_rate_watts: f64,
}

// --- Cached DLL handle ---
// We load the DLL once and keep it alive for the lifetime of the process.
// An RwLock allows concurrent DLL calls — Symbol only borrows &Library,
// so multiple read-locks can run in parallel (e.g. process polling
// isn't blocked while a slow folder scan is running).

fn find_dll_path() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));

    let candidates = [
        // Next to the executable (production — flattened resource)
        exe_dir.as_ref().map(|d| d.join("taskmanager_native.dll")),
        // Tauri bundled resources directory (_up_/)
        exe_dir.as_ref().map(|d| d.join("_up_").join("taskmanager_native.dll")),
        // Legacy nested resource path
        exe_dir.as_ref().map(|d| {
            d.join("_up_")
                .join("native")
                .join("build")
                .join("Release")
                .join("taskmanager_native.dll")
        }),
        // Dev mode — relative to project root
        Some(PathBuf::from(
            "../native/build/Release/taskmanager_native.dll",
        )),
        // Current directory fallback
        Some(PathBuf::from("taskmanager_native.dll")),
    ];

    for candidate in &candidates {
        if let Some(path) = candidate {
            if path.exists() {
                return path.clone();
            }
        }
    }

    PathBuf::from("taskmanager_native.dll")
}

static DLL: OnceLock<Result<RwLock<Library>, String>> = OnceLock::new();

fn get_dll() -> Result<&'static RwLock<Library>, String> {
    let result = DLL.get_or_init(|| {
        let path = find_dll_path();
        match unsafe { Library::new(&path) } {
            Ok(lib) => Ok(RwLock::new(lib)),
            Err(e) => Err(format!("DLL load failed ({}): {e}", path.display())),
        }
    });
    result.as_ref().map_err(|e| e.clone())
}

// Helper to load a list from DLL using the count-then-fill pattern
fn load_list<T: Copy + Default>(func_name: &[u8]) -> Result<Vec<T>, String> {
    let dll_mutex = get_dll()?;
    let lib = dll_mutex.read().map_err(|e| format!("DLL lock failed: {e}"))?;

    unsafe {
        let func: Symbol<unsafe extern "C" fn(*mut T, i32) -> i32> = lib
            .get(func_name)
            .map_err(|e| {
                format!(
                    "Symbol '{}' not found: {e}",
                    String::from_utf8_lossy(func_name)
                )
            })?;

        let count = func(std::ptr::null_mut(), 0);
        if count <= 0 {
            return Ok(vec![]);
        }
        let count = count as usize;

        let mut buffer: Vec<T> = vec![T::default(); count];
        let actual = func(buffer.as_mut_ptr(), count as i32) as usize;
        buffer.truncate(actual);

        Ok(buffer)
    }
}

pub fn load_process_list() -> Result<Vec<ProcessInfo>, String> {
    let buffer: Vec<RawProcessMemoryInfo> = load_list(b"get_process_memory_list")?;

    // Convert raw data first
    let mut processes: Vec<ProcessInfo> = buffer
        .into_iter()
        .map(|raw| {
            let name_len = raw.name.iter().position(|&c| c == 0).unwrap_or(260);
            let display_name_len = raw.display_name.iter().position(|&c| c == 0).unwrap_or(260);
            let icon_len = raw.icon_base64.iter().position(|&c| c == 0).unwrap_or(16384);
            ProcessInfo {
                pid: raw.pid,
                name: String::from_utf16_lossy(&raw.name[..name_len]),
                display_name: String::from_utf16_lossy(&raw.display_name[..display_name_len]),
                icon_base64: String::from_utf8_lossy(&raw.icon_base64[..icon_len]).to_string(),
                private_mb: raw.private_bytes as f64 / 1_048_576.0,
                shared_mb: raw.shared_bytes as f64 / 1_048_576.0,
                working_set_mb: raw.working_set as f64 / 1_048_576.0,
                private_working_set_mb: raw.private_working_set as f64 / 1_048_576.0,
                page_faults: raw.page_faults,
                process_type: None,
            }
        })
        .collect();

    // Classify multi-process applications (Chrome tabs, VS Code extension host, etc.)
    // We set process_type but DON'T change display_name — the frontend uses display_name
    // for grouping, so all Chrome processes stay bundled under "Google Chrome".
    let pids: Vec<u32> = processes.iter().map(|p| p.pid).collect();
    let exe_names: Vec<String> = processes.iter().map(|p| p.name.clone()).collect();
    let classifications = crate::process_classifier::classify_processes(&pids, &exe_names);

    for proc in &mut processes {
        if let Some(classification) = classifications.get(&proc.pid) {
            proc.process_type = classification.process_type.clone();
        }
    }

    Ok(processes)
}

pub fn load_power_list() -> Result<Vec<ProcessPowerInfo>, String> {
    let buffer: Vec<RawProcessPowerInfo> = load_list(b"get_process_power_list")?;

    Ok(buffer
        .into_iter()
        .map(|raw| ProcessPowerInfo {
            pid: raw.pid,
            battery_percent: raw.battery_percent,
            energy_uj: raw.energy_uj,
            cpu_percent: raw.cpu_percent,
            power_watts: raw.power_watts,
        })
        .collect())
}

pub fn load_disk_list() -> Result<Vec<ProcessDiskInfo>, String> {
    let buffer: Vec<RawProcessDiskInfo> = load_list(b"get_process_disk_list")?;

    Ok(buffer
        .into_iter()
        .map(|raw| ProcessDiskInfo {
            pid: raw.pid,
            read_bytes_per_sec: raw.read_bytes_per_sec,
            write_bytes_per_sec: raw.write_bytes_per_sec,
            total_read_bytes: raw.total_read_bytes,
            total_write_bytes: raw.total_write_bytes,
        })
        .collect())
}

pub fn load_network_list() -> Result<Vec<ProcessNetworkInfo>, String> {
    let buffer: Vec<RawProcessNetworkInfo> = load_list(b"get_process_network_list")?;

    Ok(buffer
        .into_iter()
        .map(|raw| ProcessNetworkInfo {
            pid: raw.pid,
            send_bytes_per_sec: raw.send_bytes_per_sec,
            recv_bytes_per_sec: raw.recv_bytes_per_sec,
            total_sent: raw.total_sent,
            total_received: raw.total_received,
        })
        .collect())
}

pub fn load_gpu_list() -> Result<Vec<ProcessGpuInfo>, String> {
    let buffer: Vec<RawProcessGpuInfo> = load_list(b"get_process_gpu_list")?;

    Ok(buffer
        .into_iter()
        .map(|raw| ProcessGpuInfo {
            pid: raw.pid,
            gpu_usage_percent: raw.gpu_usage_percent,
            gpu_memory_bytes: raw.gpu_memory_bytes,
        })
        .collect())
}

pub fn load_npu_list() -> Result<Vec<ProcessNpuInfo>, String> {
    let buffer: Vec<RawProcessNpuInfo> = load_list(b"get_process_npu_list")?;

    Ok(buffer
        .into_iter()
        .map(|raw| ProcessNpuInfo {
            pid: raw.pid,
            npu_usage_percent: raw.npu_usage_percent,
            npu_dedicated_bytes: raw.npu_dedicated_bytes,
            npu_shared_bytes: raw.npu_shared_bytes,
        })
        .collect())
}

pub fn load_status_list() -> Result<Vec<ProcessStatusInfo>, String> {
    let buffer: Vec<RawProcessStatusInfo> = load_list(b"get_process_status_list")?;

    Ok(buffer
        .into_iter()
        .map(|raw| ProcessStatusInfo {
            pid: raw.pid,
            status: match raw.status {
                1 => "running".to_string(),
                2 => "suspended".to_string(),
                _ => "unknown".to_string(),
            },
        })
        .collect())
}

pub fn kill_process(pid: u32) -> Result<(), String> {
    let dll_mutex = get_dll()?;
    let lib = dll_mutex.read().map_err(|e| format!("DLL lock failed: {e}"))?;

    unsafe {
        let func: Symbol<unsafe extern "C" fn(u32) -> i32> = lib
            .get(b"terminate_process")
            .map_err(|e| format!("Symbol not found: {e}"))?;

        let result = func(pid);
        if result == 0 {
            Ok(())
        } else {
            Err(format!(
                "Failed to terminate process {pid}. Access denied or process not found."
            ))
        }
    }
}

pub fn set_priority(pid: u32, priority_class: i32) -> Result<(), String> {
    let dll_mutex = get_dll()?;
    let lib = dll_mutex.read().map_err(|e| format!("DLL lock failed: {e}"))?;

    unsafe {
        let func: Symbol<unsafe extern "C" fn(u32, i32) -> i32> = lib
            .get(b"set_process_priority")
            .map_err(|e| format!("Symbol not found: {e}"))?;

        let result = func(pid, priority_class);
        if result == 0 {
            Ok(())
        } else {
            Err(format!(
                "Failed to set priority for process {pid}. Access denied or process not found."
            ))
        }
    }
}

pub fn load_system_info() -> Result<SystemInfo, String> {
    let dll_mutex = get_dll()?;
    let lib = dll_mutex.read().map_err(|e| format!("DLL lock failed: {e}"))?;

    unsafe {
        let func: Symbol<unsafe extern "C" fn(*mut RawSystemInfo) -> i32> = lib
            .get(b"get_system_info")
            .map_err(|e| format!("Symbol not found: {e}"))?;

        let mut info: RawSystemInfo = std::mem::zeroed();
        let result = func(&mut info);
        if result != 0 {
            return Err("get_system_info failed".to_string());
        }

        Ok(SystemInfo {
            total_ram_mb: info.total_ram_mb,
            used_ram_mb: info.used_ram_mb,
            cpu_usage_percent: info.cpu_usage_percent,
            battery_percent: info.battery_percent,
            is_charging: info.is_charging != 0,
            process_count: info.process_count,
            total_disk_read_per_sec: info.total_disk_read_per_sec,
            total_disk_write_per_sec: info.total_disk_write_per_sec,
            total_net_send_per_sec: info.total_net_send_per_sec,
            total_net_recv_per_sec: info.total_net_recv_per_sec,
            gpu_usage_percent: info.gpu_usage_percent,
            power_draw_watts: info.power_draw_watts,
            charge_rate_watts: info.charge_rate_watts,
        })
    }
}

// Implement Default for raw FFI types
impl Default for RawProcessMemoryInfo {
    fn default() -> Self { unsafe { std::mem::zeroed() } }
}
impl Default for RawProcessPowerInfo {
    fn default() -> Self { unsafe { std::mem::zeroed() } }
}
impl Default for RawProcessDiskInfo {
    fn default() -> Self { unsafe { std::mem::zeroed() } }
}
impl Default for RawProcessNetworkInfo {
    fn default() -> Self { unsafe { std::mem::zeroed() } }
}
impl Default for RawProcessGpuInfo {
    fn default() -> Self { unsafe { std::mem::zeroed() } }
}
impl Default for RawProcessNpuInfo {
    fn default() -> Self { unsafe { std::mem::zeroed() } }
}
impl Default for RawProcessStatusInfo {
    fn default() -> Self { unsafe { std::mem::zeroed() } }
}

// ---------------- Storage ----------------
#[repr(C)]
#[derive(Clone, Copy)]
pub struct RawStorageVolumeInfo {
    pub letter: u16,
    pub label: [u16; 64],
    pub filesystem: [u16; 16],
    pub media_kind: i32,
    pub is_system: i32,
    pub is_readonly: i32,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub read_bytes_per_sec: f64,
    pub write_bytes_per_sec: f64,
    pub active_percent: f64,
    pub queue_length: f64,
}
impl Default for RawStorageVolumeInfo { fn default() -> Self { unsafe { std::mem::zeroed() } } }

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RawStorageFolderInfo {
    pub path: [u16; 520],
    pub display_name: [u16; 128],
    pub size_bytes: u64,
    pub file_count: i64,
}
impl Default for RawStorageFolderInfo { fn default() -> Self { unsafe { std::mem::zeroed() } } }

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RawInstalledAppInfo {
    pub name: [u16; 256],
    pub publisher: [u16; 128],
    pub version: [u16; 64],
    pub install_date: [u16; 16],
    pub size_bytes: u64,
    pub install_location: [u16; 520],
}
impl Default for RawInstalledAppInfo { fn default() -> Self { unsafe { std::mem::zeroed() } } }

#[derive(Serialize, Clone, Debug)]
pub struct StorageVolumeInfo {
    pub letter: String,
    pub label: String,
    pub filesystem: String,
    pub media_kind: String,     // "hdd" | "ssd" | "nvme" | "usb" | "network" | "optical" | "virtual" | "unknown"
    pub is_system: bool,
    pub is_readonly: bool,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub read_bytes_per_sec: f64,
    pub write_bytes_per_sec: f64,
    pub active_percent: f64,
    pub queue_length: f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct StorageFolderInfo {
    pub path: String,
    pub display_name: String,
    pub size_bytes: u64,
    pub file_count: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct InstalledAppInfo {
    pub name: String,
    pub publisher: String,
    pub version: String,
    pub install_date: String,
    pub size_bytes: u64,
    pub install_location: String,
}

fn wstr_lossy(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

fn media_kind_to_str(k: i32) -> &'static str {
    match k {
        1 => "hdd", 2 => "ssd", 3 => "nvme", 4 => "usb",
        5 => "network", 6 => "optical", 7 => "virtual", _ => "unknown",
    }
}

pub fn load_storage_volumes() -> Result<Vec<StorageVolumeInfo>, String> {
    let buffer: Vec<RawStorageVolumeInfo> = load_list(b"get_storage_volume_list")?;
    Ok(buffer.into_iter().map(|r| StorageVolumeInfo {
        letter: char::from_u32(r.letter as u32).map(|c| c.to_string()).unwrap_or_default(),
        label: wstr_lossy(&r.label),
        filesystem: wstr_lossy(&r.filesystem),
        media_kind: media_kind_to_str(r.media_kind).to_string(),
        is_system: r.is_system != 0,
        is_readonly: r.is_readonly != 0,
        total_bytes: r.total_bytes,
        free_bytes: r.free_bytes,
        read_bytes_per_sec: r.read_bytes_per_sec,
        write_bytes_per_sec: r.write_bytes_per_sec,
        active_percent: r.active_percent,
        queue_length: r.queue_length,
    }).collect())
}

pub fn load_top_folders(root: &str, max: i32) -> Result<Vec<StorageFolderInfo>, String> {
    let dll_mutex = get_dll()?;
    let lib = dll_mutex.read().map_err(|e| format!("DLL lock failed: {e}"))?;
    unsafe {
        let func: Symbol<unsafe extern "C" fn(*const u16, *mut RawStorageFolderInfo, i32) -> i32> =
            lib.get(b"get_storage_top_folders")
               .map_err(|e| format!("Symbol not found: {e}"))?;
        let mut wide: Vec<u16> = root.encode_utf16().collect();
        wide.push(0);
        let mut buf: Vec<RawStorageFolderInfo> = vec![RawStorageFolderInfo::default(); max as usize];
        let actual = func(wide.as_ptr(), buf.as_mut_ptr(), max) as usize;
        buf.truncate(actual);
        Ok(buf.into_iter().map(|r| StorageFolderInfo {
            path: wstr_lossy(&r.path),
            display_name: wstr_lossy(&r.display_name),
            size_bytes: r.size_bytes,
            file_count: r.file_count,
        }).collect())
    }
}

pub fn load_installed_apps() -> Result<Vec<InstalledAppInfo>, String> {
    let buffer: Vec<RawInstalledAppInfo> = load_list(b"get_installed_apps")?;
    Ok(buffer.into_iter().map(|r| InstalledAppInfo {
        name: wstr_lossy(&r.name),
        publisher: wstr_lossy(&r.publisher),
        version: wstr_lossy(&r.version),
        install_date: wstr_lossy(&r.install_date),
        size_bytes: r.size_bytes,
        install_location: wstr_lossy(&r.install_location),
    }).collect())
}

pub fn load_recycle_bin_size() -> Result<u64, String> {
    let dll_mutex = get_dll()?;
    let lib = dll_mutex.read().map_err(|e| format!("DLL lock failed: {e}"))?;
    unsafe {
        let func: Symbol<unsafe extern "C" fn() -> u64> = lib
            .get(b"get_recycle_bin_size")
            .map_err(|e| format!("Symbol not found: {e}"))?;
        Ok(func())
    }
}

pub fn empty_recycle_bin() -> Result<(), String> {
    let dll_mutex = get_dll()?;
    let lib = dll_mutex.read().map_err(|e| format!("DLL lock failed: {e}"))?;
    unsafe {
        let func: Symbol<unsafe extern "C" fn() -> i32> = lib
            .get(b"empty_recycle_bin")
            .map_err(|e| format!("Symbol not found: {e}"))?;
        if func() == 0 { Ok(()) } else { Err("Failed to empty recycle bin".into()) }
    }
}

// ---------------- Smart Organizer ----------------
#[repr(C)]
#[derive(Clone, Copy)]
pub struct RawFileTypeStat {
    pub folder_path: [u16; 520],
    pub category: [u16; 32],
    pub total_bytes: u64,
    pub file_count: i64,
    pub oldest_modified_ts: i64,
    pub newest_modified_ts: i64,
}
impl Default for RawFileTypeStat { fn default() -> Self { unsafe { std::mem::zeroed() } } }

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RawDetectedProject {
    pub path: [u16; 520],
    pub project_type: [u16; 32],
    pub display_name: [u16; 128],
    pub size_bytes: u64,
    pub file_count: i64,
}
impl Default for RawDetectedProject { fn default() -> Self { unsafe { std::mem::zeroed() } } }

#[derive(Serialize, Clone, Debug)]
pub struct FileTypeStat {
    pub folder_path: String,
    pub category: String,
    pub total_bytes: u64,
    pub file_count: i64,
    pub oldest_modified_ts: i64,
    pub newest_modified_ts: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct DetectedProject {
    pub path: String,
    pub project_type: String,
    pub display_name: String,
    pub size_bytes: u64,
    pub file_count: i64,
}

pub fn load_file_type_stats(folder: &str) -> Result<Vec<FileTypeStat>, String> {
    let dll_mutex = get_dll()?;
    let lib = dll_mutex.read().map_err(|e| format!("DLL lock failed: {e}"))?;
    unsafe {
        let func: Symbol<unsafe extern "C" fn(*const u16, *mut RawFileTypeStat, i32) -> i32> =
            lib.get(b"scan_folder_file_types")
               .map_err(|e| format!("Symbol not found: {e}"))?;
        let mut wide: Vec<u16> = folder.encode_utf16().collect();
        wide.push(0);
        // 16 is enough — there are 10 categories total; leave headroom for future additions.
        let max = 16i32;
        let mut buf: Vec<RawFileTypeStat> = vec![RawFileTypeStat::default(); max as usize];
        let actual = func(wide.as_ptr(), buf.as_mut_ptr(), max) as usize;
        buf.truncate(actual);
        Ok(buf.into_iter().map(|r| FileTypeStat {
            folder_path: wstr_lossy(&r.folder_path),
            category: wstr_lossy(&r.category),
            total_bytes: r.total_bytes,
            file_count: r.file_count,
            oldest_modified_ts: r.oldest_modified_ts,
            newest_modified_ts: r.newest_modified_ts,
        }).collect())
    }
}

pub fn load_detected_projects(root: &str) -> Result<Vec<DetectedProject>, String> {
    let dll_mutex = get_dll()?;
    let lib = dll_mutex.read().map_err(|e| format!("DLL lock failed: {e}"))?;
    unsafe {
        let func: Symbol<unsafe extern "C" fn(*const u16, *mut RawDetectedProject, i32) -> i32> =
            lib.get(b"detect_projects")
               .map_err(|e| format!("Symbol not found: {e}"))?;
        let mut wide: Vec<u16> = root.encode_utf16().collect();
        wide.push(0);
        let max = 128i32;
        let mut buf: Vec<RawDetectedProject> = vec![RawDetectedProject::default(); max as usize];
        let actual = func(wide.as_ptr(), buf.as_mut_ptr(), max) as usize;
        buf.truncate(actual);
        Ok(buf.into_iter().map(|r| DetectedProject {
            path: wstr_lossy(&r.path),
            project_type: wstr_lossy(&r.project_type),
            display_name: wstr_lossy(&r.display_name),
            size_bytes: r.size_bytes,
            file_count: r.file_count,
        }).collect())
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RawCoreCpuInfo {
    pub core_index: u32,
    pub usage_percent: f64,
    pub is_performance_core: i32,
}
impl Default for RawCoreCpuInfo {
    fn default() -> Self { unsafe { std::mem::zeroed() } }
}

#[derive(Serialize, Clone, Debug)]
pub struct CoreCpuInfo {
    pub core_index: u32,
    pub usage_percent: f64,
    pub is_performance_core: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RawPerformanceSnapshot {
    pub cpu_usage_percent: f64,
    pub core_count: u32,
    pub thread_count: u32,
    pub cpu_frequency_mhz: f64,
    pub cpu_max_frequency_mhz: f64,
    pub cpu_base_frequency_mhz: f64,
    pub cpu_name: [u8; 128],
    pub total_ram_bytes: u64,
    pub used_ram_bytes: u64,
    pub available_ram_bytes: u64,
    pub committed_bytes: u64,
    pub commit_limit_bytes: u64,
    pub cached_bytes: u64,
    pub paged_pool_bytes: u64,
    pub non_paged_pool_bytes: u64,
    pub cache_idle_bytes: u64,
    pub cache_active_bytes: u64,
    pub cache_launch_bytes: u64,
    pub modified_pages_bytes: u64,
    pub disk_read_per_sec: f64,
    pub disk_write_per_sec: f64,
    pub disk_active_percent: f64,
    pub disk_queue_length: u64,
    pub net_send_per_sec: f64,
    pub net_recv_per_sec: f64,
    pub net_link_speed_bps: f64,
    pub gpu_usage_percent: f64,
    pub gpu_memory_total: u64,
    pub gpu_memory_used: u64,
    pub gpu_shared_memory_total: u64,
    pub gpu_shared_memory_used: u64,
    pub gpu_is_integrated: i32,
    pub gpu_name: [u8; 128],
    pub gpu_temperature: f64,
    pub fan_rpm: i32,
    pub npu_present: i32,
    pub npu_usage_percent: f64,
    pub npu_dedicated_total_bytes: u64,
    pub npu_dedicated_used_bytes: u64,
    pub npu_shared_total_bytes: u64,
    pub npu_shared_used_bytes: u64,
    pub npu_name: [u8; 128],
    pub npu_hardware_id: [u8; 48],
    pub battery_percent: f64,
    pub is_charging: i32,
    pub power_draw_watts: f64,
    pub network_power_watts: f64,
    pub charge_rate_watts: f64,
    pub battery_time_remaining: i32,
    pub battery_design_capacity_mwh: u32,
    pub battery_full_charge_capacity_mwh: u32,
    pub battery_cycle_count: u32,
    pub battery_voltage: f64,
    pub process_count: u32,
    pub handle_count: u32,
    pub thread_total_count: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct PerformanceSnapshot {
    pub cpu_usage_percent: f64,
    pub core_count: u32,
    pub thread_count: u32,
    pub cpu_frequency_mhz: f64,
    pub cpu_max_frequency_mhz: f64,
    pub cpu_base_frequency_mhz: f64,
    pub cpu_name: String,
    pub total_ram_bytes: u64,
    pub used_ram_bytes: u64,
    pub available_ram_bytes: u64,
    pub committed_bytes: u64,
    pub commit_limit_bytes: u64,
    pub cached_bytes: u64,
    pub paged_pool_bytes: u64,
    pub non_paged_pool_bytes: u64,
    pub cache_idle_bytes: u64,
    pub cache_active_bytes: u64,
    pub cache_launch_bytes: u64,
    pub modified_pages_bytes: u64,
    pub disk_read_per_sec: f64,
    pub disk_write_per_sec: f64,
    pub disk_active_percent: f64,
    pub disk_queue_length: u64,
    pub net_send_per_sec: f64,
    pub net_recv_per_sec: f64,
    pub net_link_speed_bps: f64,
    pub gpu_usage_percent: f64,
    pub gpu_memory_total: u64,
    pub gpu_memory_used: u64,
    pub gpu_shared_memory_total: u64,
    pub gpu_shared_memory_used: u64,
    pub gpu_is_integrated: bool,
    pub gpu_name: String,
    pub gpu_temperature: f64,
    pub fan_rpm: i32,
    pub npu_present: bool,
    pub npu_usage_percent: f64,
    pub npu_dedicated_total_bytes: u64,
    pub npu_dedicated_used_bytes: u64,
    pub npu_shared_total_bytes: u64,
    pub npu_shared_used_bytes: u64,
    pub npu_name: String,
    pub npu_hardware_id: String,
    pub battery_percent: f64,
    pub is_charging: bool,
    pub power_draw_watts: f64,
    pub network_power_watts: f64,
    pub charge_rate_watts: f64,
    pub battery_time_remaining: i32,
    pub battery_design_capacity_mwh: u32,
    pub battery_full_charge_capacity_mwh: u32,
    pub battery_cycle_count: u32,
    pub battery_voltage: f64,
    pub process_count: u32,
    pub handle_count: u32,
    pub thread_total_count: u32,
}

pub fn load_per_core_cpu() -> Result<Vec<CoreCpuInfo>, String> {
    let buffer: Vec<RawCoreCpuInfo> = load_list(b"get_per_core_cpu")?;
    Ok(buffer.into_iter().map(|raw| CoreCpuInfo {
        core_index: raw.core_index,
        usage_percent: raw.usage_percent,
        is_performance_core: raw.is_performance_core,
    }).collect())
}

pub fn load_performance_snapshot() -> Result<PerformanceSnapshot, String> {
    let dll_mutex = get_dll()?;
    let lib = dll_mutex.read().map_err(|e| format!("DLL lock failed: {e}"))?;

    unsafe {
        let func: Symbol<unsafe extern "C" fn(*mut RawPerformanceSnapshot) -> i32> = lib
            .get(b"get_performance_snapshot")
            .map_err(|e| format!("Symbol not found: {e}"))?;

        let mut info: RawPerformanceSnapshot = std::mem::zeroed();
        let result = func(&mut info);
        if result != 0 {
            return Err("get_performance_snapshot failed".to_string());
        }

        let cpu_name = {
            let nul = info.cpu_name.iter().position(|&b| b == 0).unwrap_or(info.cpu_name.len());
            String::from_utf8_lossy(&info.cpu_name[..nul]).into_owned()
        };

        Ok(PerformanceSnapshot {
            cpu_usage_percent: info.cpu_usage_percent,
            core_count: info.core_count,
            thread_count: info.thread_count,
            cpu_frequency_mhz: info.cpu_frequency_mhz,
            cpu_max_frequency_mhz: info.cpu_max_frequency_mhz,
            cpu_base_frequency_mhz: info.cpu_base_frequency_mhz,
            cpu_name,
            total_ram_bytes: info.total_ram_bytes,
            used_ram_bytes: info.used_ram_bytes,
            available_ram_bytes: info.available_ram_bytes,
            committed_bytes: info.committed_bytes,
            commit_limit_bytes: info.commit_limit_bytes,
            cached_bytes: info.cached_bytes,
            paged_pool_bytes: info.paged_pool_bytes,
            non_paged_pool_bytes: info.non_paged_pool_bytes,
            cache_idle_bytes: info.cache_idle_bytes,
            cache_active_bytes: info.cache_active_bytes,
            cache_launch_bytes: info.cache_launch_bytes,
            modified_pages_bytes: info.modified_pages_bytes,
            disk_read_per_sec: info.disk_read_per_sec,
            disk_write_per_sec: info.disk_write_per_sec,
            disk_active_percent: info.disk_active_percent,
            disk_queue_length: info.disk_queue_length,
            net_send_per_sec: info.net_send_per_sec,
            net_recv_per_sec: info.net_recv_per_sec,
            net_link_speed_bps: info.net_link_speed_bps,
            gpu_usage_percent: info.gpu_usage_percent,
            gpu_memory_total: info.gpu_memory_total,
            gpu_memory_used: info.gpu_memory_used,
            gpu_shared_memory_total: info.gpu_shared_memory_total,
            gpu_shared_memory_used: info.gpu_shared_memory_used,
            gpu_is_integrated: info.gpu_is_integrated != 0,
            gpu_name: {
                // Convert null-terminated UTF-8 byte array to String
                let nul = info.gpu_name.iter().position(|&b| b == 0).unwrap_or(info.gpu_name.len());
                String::from_utf8_lossy(&info.gpu_name[..nul]).into_owned()
            },
            gpu_temperature: info.gpu_temperature,
            fan_rpm: info.fan_rpm,
            npu_present: info.npu_present != 0,
            npu_usage_percent: info.npu_usage_percent,
            npu_dedicated_total_bytes: info.npu_dedicated_total_bytes,
            npu_dedicated_used_bytes: info.npu_dedicated_used_bytes,
            npu_shared_total_bytes: info.npu_shared_total_bytes,
            npu_shared_used_bytes: info.npu_shared_used_bytes,
            npu_name: {
                let nul = info.npu_name.iter().position(|&b| b == 0).unwrap_or(info.npu_name.len());
                String::from_utf8_lossy(&info.npu_name[..nul]).into_owned()
            },
            npu_hardware_id: {
                let nul = info
                    .npu_hardware_id
                    .iter()
                    .position(|&b| b == 0)
                    .unwrap_or(info.npu_hardware_id.len());
                String::from_utf8_lossy(&info.npu_hardware_id[..nul]).into_owned()
            },
            battery_percent: info.battery_percent,
            is_charging: info.is_charging != 0,
            power_draw_watts: info.power_draw_watts,
            network_power_watts: info.network_power_watts,
            charge_rate_watts: info.charge_rate_watts,
            battery_time_remaining: info.battery_time_remaining,
            battery_design_capacity_mwh: info.battery_design_capacity_mwh,
            battery_full_charge_capacity_mwh: info.battery_full_charge_capacity_mwh,
            battery_cycle_count: info.battery_cycle_count,
            battery_voltage: info.battery_voltage,
            process_count: info.process_count,
            handle_count: info.handle_count,
            thread_total_count: info.thread_total_count,
        })
    }
}
