use libloading::{Library, Symbol};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

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
    pub page_faults: u64,
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
// A Mutex protects concurrent access from multiple Tauri command threads.

fn find_dll_path() -> PathBuf {
    let candidates = [
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("taskmanager_native.dll"))),
        Some(PathBuf::from(
            "../native/build/Release/taskmanager_native.dll",
        )),
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

static DLL: OnceLock<Result<Mutex<Library>, String>> = OnceLock::new();

fn get_dll() -> Result<&'static Mutex<Library>, String> {
    let result = DLL.get_or_init(|| {
        let path = find_dll_path();
        match unsafe { Library::new(&path) } {
            Ok(lib) => Ok(Mutex::new(lib)),
            Err(e) => Err(format!("DLL load failed ({}): {e}", path.display())),
        }
    });
    result.as_ref().map_err(|e| e.clone())
}

// Helper to load a list from DLL using the count-then-fill pattern
fn load_list<T: Copy + Default>(func_name: &[u8]) -> Result<Vec<T>, String> {
    let dll_mutex = get_dll()?;
    let lib = dll_mutex.lock().map_err(|e| format!("DLL lock failed: {e}"))?;

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

    Ok(buffer
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
                page_faults: raw.page_faults,
            }
        })
        .collect())
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
    let lib = dll_mutex.lock().map_err(|e| format!("DLL lock failed: {e}"))?;

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
    let lib = dll_mutex.lock().map_err(|e| format!("DLL lock failed: {e}"))?;

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
    let lib = dll_mutex.lock().map_err(|e| format!("DLL lock failed: {e}"))?;

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
impl Default for RawProcessStatusInfo {
    fn default() -> Self { unsafe { std::mem::zeroed() } }
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
    pub total_ram_bytes: u64,
    pub used_ram_bytes: u64,
    pub available_ram_bytes: u64,
    pub committed_bytes: u64,
    pub commit_limit_bytes: u64,
    pub cached_bytes: u64,
    pub paged_pool_bytes: u64,
    pub non_paged_pool_bytes: u64,
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
    pub gpu_temperature: f64,
    pub battery_percent: f64,
    pub is_charging: i32,
    pub power_draw_watts: f64,
    pub charge_rate_watts: f64,
    pub battery_time_remaining: i32,
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
    pub total_ram_bytes: u64,
    pub used_ram_bytes: u64,
    pub available_ram_bytes: u64,
    pub committed_bytes: u64,
    pub commit_limit_bytes: u64,
    pub cached_bytes: u64,
    pub paged_pool_bytes: u64,
    pub non_paged_pool_bytes: u64,
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
    pub gpu_temperature: f64,
    pub battery_percent: f64,
    pub is_charging: bool,
    pub power_draw_watts: f64,
    pub charge_rate_watts: f64,
    pub battery_time_remaining: i32,
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
    let lib = dll_mutex.lock().map_err(|e| format!("DLL lock failed: {e}"))?;

    unsafe {
        let func: Symbol<unsafe extern "C" fn(*mut RawPerformanceSnapshot) -> i32> = lib
            .get(b"get_performance_snapshot")
            .map_err(|e| format!("Symbol not found: {e}"))?;

        let mut info: RawPerformanceSnapshot = std::mem::zeroed();
        let result = func(&mut info);
        if result != 0 {
            return Err("get_performance_snapshot failed".to_string());
        }

        Ok(PerformanceSnapshot {
            cpu_usage_percent: info.cpu_usage_percent,
            core_count: info.core_count,
            thread_count: info.thread_count,
            cpu_frequency_mhz: info.cpu_frequency_mhz,
            cpu_max_frequency_mhz: info.cpu_max_frequency_mhz,
            cpu_base_frequency_mhz: info.cpu_base_frequency_mhz,
            total_ram_bytes: info.total_ram_bytes,
            used_ram_bytes: info.used_ram_bytes,
            available_ram_bytes: info.available_ram_bytes,
            committed_bytes: info.committed_bytes,
            commit_limit_bytes: info.commit_limit_bytes,
            cached_bytes: info.cached_bytes,
            paged_pool_bytes: info.paged_pool_bytes,
            non_paged_pool_bytes: info.non_paged_pool_bytes,
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
            gpu_temperature: info.gpu_temperature,
            battery_percent: info.battery_percent,
            is_charging: info.is_charging != 0,
            power_draw_watts: info.power_draw_watts,
            charge_rate_watts: info.charge_rate_watts,
            battery_time_remaining: info.battery_time_remaining,
            process_count: info.process_count,
            handle_count: info.handle_count,
            thread_total_count: info.thread_total_count,
        })
    }
}
