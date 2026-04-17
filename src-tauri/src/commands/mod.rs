pub mod disk;
pub mod display;
pub mod gpu;
pub mod npu;
pub mod network;
pub mod oem;
pub mod performance;
pub mod power;
pub mod processes;
pub mod status;
pub mod storage;
pub mod system;
pub mod task;
pub mod thermal_delegate;
#[cfg(windows)]
pub mod thermal_delegate_win;
pub mod windows_system;
