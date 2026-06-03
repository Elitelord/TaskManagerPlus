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

    // Dev: copy native DLL under a *new* filename so rebuilds succeed while an old
    // dev session still has `taskmanager_native.dll` mapped (Windows error 32).
    // `native_dll.path` (one line, filename only) tells the Rust loader which file
    // to use. Also try updating the canonical name when nothing holds the lock.
    let target_dir = std::env::var("OUT_DIR").unwrap_or_default();
    if !target_dir.is_empty() {
        let dll_src = release_dir.join("taskmanager_native.dll");
        if dll_src.exists() {
            if let Some(target_profile_dir) = Path::new(&target_dir)
                .ancestors()
                .find(|p| p.file_name().map_or(false, |f| f == "debug" || f == "release"))
            {
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let versioned_name = format!("taskmanager_native.{stamp}.dll");
                let versioned_dest = target_profile_dir.join(&versioned_name);

                if let Err(e) = std::fs::copy(&dll_src, &versioned_dest) {
                    eprintln!(
                        "cargo:warning=Could not copy native DLL to {}: {e}",
                        versioned_dest.display()
                    );
                } else {
                    let sidecar = target_profile_dir.join("native_dll.path");
                    if let Err(e) = std::fs::write(&sidecar, &versioned_name) {
                        eprintln!(
                            "cargo:warning=Could not write {}: {e}",
                            sidecar.display()
                        );
                    }
                    println!("cargo:rerun-if-changed={}", sidecar.display());
                }

                // Best-effort update of the legacy name (production / first run).
                let legacy_dest = target_profile_dir.join("taskmanager_native.dll");
                if let Err(e) = std::fs::copy(&dll_src, &legacy_dest) {
                    if e.raw_os_error() == Some(32) {
                        eprintln!(
                            "cargo:warning=Skipped locked {} — using {} from native_dll.path. \
                             Restart the app to pick up the new DLL.",
                            legacy_dest.display(),
                            versioned_name
                        );
                    }
                }

                // MCP sidecar — same locked-file pattern as the native DLL.
                let mcp_src = Path::new("target/release/tmp_mcp.exe");
                if mcp_src.exists() {
                    let mcp_versioned = format!("tmp_mcp.{stamp}.exe");
                    let mcp_versioned_dest = target_profile_dir.join(&mcp_versioned);
                    if std::fs::copy(mcp_src, &mcp_versioned_dest).is_ok() {
                        let _ = std::fs::write(
                            target_profile_dir.join("tmp_mcp.path"),
                            &mcp_versioned,
                        );
                    }
                    let mcp_legacy = target_profile_dir.join("tmp_mcp.exe");
                    if let Err(e) = std::fs::copy(mcp_src, &mcp_legacy) {
                        if e.raw_os_error() == Some(32) {
                            eprintln!(
                                "cargo:warning=Skipped locked {} — using {} from tmp_mcp.path. \
                                 Stop orphaned tmp_mcp processes: \
                                 Stop-Process -Name tmp_mcp -Force -ErrorAction SilentlyContinue",
                                mcp_legacy.display(),
                                mcp_versioned
                            );
                        }
                    }
                }
            }
        }
    }

    // Rebuild if C++ sources change
    println!("cargo:rerun-if-changed=../native/src");
    println!("cargo:rerun-if-changed=../native/include");
    println!("cargo:rerun-if-changed=../native/CMakeLists.txt");

    tauri_build::build();
}
