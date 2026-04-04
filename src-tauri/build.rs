use std::path::Path;
use std::process::Command;

fn main() {
    // Build the C++ DLL via CMake
    let native_dir = Path::new("../native");
    let build_dir = native_dir.join("build");

    std::fs::create_dir_all(&build_dir).ok();

    // Try to find Visual Studio - prefer newer versions
    let generators = [
        "Visual Studio 17 2022",
        "Visual Studio 16 2019",
    ];

    let mut cmake_ok = false;
    for generator in &generators {
        let status = Command::new("cmake")
            .args([
                "-S",
                native_dir.to_str().unwrap(),
                "-B",
                build_dir.to_str().unwrap(),
                "-G",
                generator,
                "-A",
                "x64",
            ])
            .status();

        if let Ok(s) = status {
            if s.success() {
                cmake_ok = true;
                break;
            }
        }
    }

    // Fallback to default generator
    if !cmake_ok {
        let status = Command::new("cmake")
            .args([
                "-S",
                native_dir.to_str().unwrap(),
                "-B",
                build_dir.to_str().unwrap(),
            ])
            .status()
            .expect("CMake configure failed - is CMake installed?");
        assert!(status.success(), "CMake configure failed");
    }

    let build_status = Command::new("cmake")
        .args([
            "--build",
            build_dir.to_str().unwrap(),
            "--config",
            "Release",
        ])
        .status()
        .expect("CMake build failed");
    assert!(build_status.success(), "CMake build failed");

    // Tell Cargo where to find the DLL
    let release_dir = build_dir.join("Release");
    println!(
        "cargo:rustc-link-search=native={}",
        release_dir.display()
    );

    // Copy DLL next to the executable for dev mode
    let target_dir = std::env::var("OUT_DIR").unwrap_or_default();
    if !target_dir.is_empty() {
        let dll_src = release_dir.join("taskmanager_native.dll");
        if dll_src.exists() {
            // Walk up from OUT_DIR to find the target debug/release dir
            if let Some(target_profile_dir) = Path::new(&target_dir)
                .ancestors()
                .find(|p| p.file_name().map_or(false, |f| f == "debug" || f == "release"))
            {
                let _ = std::fs::copy(&dll_src, target_profile_dir.join("taskmanager_native.dll"));
            }
        }
    }

    // Rebuild if C++ sources change
    println!("cargo:rerun-if-changed=../native/src");
    println!("cargo:rerun-if-changed=../native/include");
    println!("cargo:rerun-if-changed=../native/CMakeLists.txt");

    tauri_build::build();
}
