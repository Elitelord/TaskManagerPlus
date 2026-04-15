// Per-OEM battery charge limit support.
//
// Each implementation uses the vendor's own WMI interface, invoked through
// PowerShell so we don't have to bring in COM/WMI Rust bindings or ship a
// kernel driver. Operations are best-effort: if the vendor namespace / method
// isn't available, we return an unsupported status and the UI hides the
// control.
//
// Method IDs and namespaces are consolidated from open-source references:
//   Lenovo Legion Toolkit (github.com/BartoszCichecki/LenovoLegionToolkit)
//   G-Helper                (github.com/seerge/g-helper)
//   framework_tool          (github.com/FrameworkComputer/framework-system)
//   Dell Command | Configure documentation
//   HP BIOS Configuration Utility documentation

use serde::Serialize;
use std::process::Command;
use std::sync::OnceLock;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
pub struct OemInfo {
    pub manufacturer: String,
    pub model: String,
    /// Which OEM backend we matched (stable identifier, e.g. "lenovo_legion").
    pub vendor: String,
    pub supports_charge_limit: bool,
    /// When enforcement is supported but the vendor only exposes discrete
    /// options instead of an arbitrary %, list them here. Empty = slider.
    pub charge_limit_presets: Vec<u8>,
    /// Inclusive % bounds for arbitrary sliders. Ignored if presets set.
    pub charge_limit_min: u8,
    pub charge_limit_max: u8,
    /// Human-readable note shown under the control in the UI.
    pub note: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ChargeLimitStatus {
    pub supported: bool,
    pub enabled: bool,
    pub limit_percent: Option<u8>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// PowerShell helper
// ---------------------------------------------------------------------------

fn run_powershell(script: &str) -> Result<String, String> {
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|e| format!("powershell launch failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let lower = stderr.to_lowercase();
        if lower.contains("access denied")
            || lower.contains("0x80041003")
            || lower.contains("0x80070005")
        {
            return Err(
                "Access denied — this vendor's WMI interface requires administrator privileges. \
                 Please restart TaskManagerPlus as administrator to use charge limit controls."
                    .to_string(),
            );
        }
        return Err(format!(
            "powershell exited {}: {}",
            out.status,
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Returns true if the given WMI namespace + class exists on this machine.
fn wmi_class_exists(namespace: &str, class: &str) -> bool {
    let script = format!(
        "try {{ $null = Get-CimClass -Namespace '{namespace}' -ClassName '{class}' -ErrorAction Stop; Write-Output 'YES' }} catch {{ Write-Output 'NO' }}"
    );
    run_powershell(&script)
        .map(|s| s.trim() == "YES")
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// OEM detection
// ---------------------------------------------------------------------------

static OEM_INFO: OnceLock<OemInfo> = OnceLock::new();

fn detect_manufacturer_model() -> (String, String) {
    let out = run_powershell(
        "$cs = Get-CimInstance Win32_ComputerSystem; Write-Output \"$($cs.Manufacturer)|$($cs.Model)\"",
    )
    .unwrap_or_default();
    let mut parts = out.splitn(2, '|');
    let mfg = parts.next().unwrap_or("").trim().to_string();
    let model = parts.next().unwrap_or("").trim().to_string();
    (mfg, model)
}

fn classify_oem(manufacturer: &str, model: &str) -> OemInfo {
    let mfg = manufacturer.to_ascii_lowercase();
    let model_lc = model.to_ascii_lowercase();

    // --- Lenovo ---
    if mfg.contains("lenovo") {
        // Legion family uses GAMEZONE_DATA; ThinkPad / IdeaPad uses UTILITY_DATA.
        let is_legion = model_lc.contains("legion") || model_lc.contains("loq");
        if is_legion && wmi_class_exists("root\\WMI", "LENOVO_GAMEZONE_DATA") {
            return OemInfo {
                manufacturer: manufacturer.into(),
                model: model.into(),
                vendor: "lenovo_legion".into(),
                supports_charge_limit: true,
                charge_limit_presets: vec![],
                charge_limit_min: 60,
                charge_limit_max: 100,
                note: "Uses Lenovo Vantage / Legion Toolkit interface.".into(),
            };
        }
        if wmi_class_exists("root\\WMI", "Lenovo_ChargeThresholdSetting") {
            return OemInfo {
                manufacturer: manufacturer.into(),
                model: model.into(),
                vendor: "lenovo_thinkpad".into(),
                supports_charge_limit: true,
                charge_limit_presets: vec![],
                charge_limit_min: 55,
                charge_limit_max: 100,
                note: "Uses ThinkPad / IdeaPad battery threshold interface.".into(),
            };
        }
    }

    // --- ASUS ---
    if mfg.contains("asus") {
        if wmi_class_exists("root\\WMI", "AsusAtkWmi_WMNB") {
            return OemInfo {
                manufacturer: manufacturer.into(),
                model: model.into(),
                vendor: "asus".into(),
                supports_charge_limit: true,
                charge_limit_presets: vec![],
                charge_limit_min: 60,
                charge_limit_max: 100,
                note: "Uses ASUS ATK WMI (method 0x00120057).".into(),
            };
        }
    }

    // --- Dell ---
    if mfg.contains("dell") {
        if wmi_class_exists("root\\DCIM\\SYSMAN", "DCIM_BIOSService")
            || wmi_class_exists("root\\DCIM\\SYSMAN", "DCIM_BIOSEnumeration")
        {
            return OemInfo {
                manufacturer: manufacturer.into(),
                model: model.into(),
                vendor: "dell".into(),
                supports_charge_limit: true,
                // Dell uses a start-stop pair; expose common stop thresholds as presets.
                charge_limit_presets: vec![60, 70, 80, 90, 100],
                charge_limit_min: 50,
                charge_limit_max: 100,
                note: "Uses Dell Command | Configure BIOS interface.".into(),
            };
        }
    }

    // --- HP ---
    if mfg.contains("hp") || mfg.contains("hewlett") {
        if wmi_class_exists("root\\HP\\InstrumentedBIOS", "HP_BIOSSetting") {
            return OemInfo {
                manufacturer: manufacturer.into(),
                model: model.into(),
                vendor: "hp".into(),
                supports_charge_limit: true,
                // HP "Battery Health Manager" is modes, not %.
                charge_limit_presets: vec![80, 100], // 80 = "Maximize lifespan", 100 = "Let HP decide / Standard"
                charge_limit_min: 80,
                charge_limit_max: 100,
                note: "HP Battery Health Manager (modes: Maximize / Standard).".into(),
            };
        }
    }

    // --- MSI ---
    if mfg.contains("micro-star") || mfg.contains("msi") {
        if wmi_class_exists("root\\WMI", "MSI_WMI") || wmi_class_exists("root\\WMI", "MSI_CENTER") {
            return OemInfo {
                manufacturer: manufacturer.into(),
                model: model.into(),
                vendor: "msi".into(),
                supports_charge_limit: true,
                charge_limit_presets: vec![50, 70, 80, 100],
                charge_limit_min: 50,
                charge_limit_max: 100,
                note: "MSI Center Battery Master presets.".into(),
            };
        }
    }

    // --- Samsung ---
    if mfg.contains("samsung") {
        if wmi_class_exists("root\\WMI", "SamsungPowerIntegration") {
            return OemInfo {
                manufacturer: manufacturer.into(),
                model: model.into(),
                vendor: "samsung".into(),
                supports_charge_limit: true,
                // Samsung "Battery Life Extender" is on (80%) / off (100%).
                charge_limit_presets: vec![80, 100],
                charge_limit_min: 80,
                charge_limit_max: 100,
                note: "Samsung Battery Life Extender (80% cap or off).".into(),
            };
        }
    }

    // --- Framework ---
    if mfg.contains("framework") {
        // framework_tool must be on PATH. We shell out to it.
        if Command::new("framework_tool").arg("--help").output().is_ok() {
            return OemInfo {
                manufacturer: manufacturer.into(),
                model: model.into(),
                vendor: "framework".into(),
                supports_charge_limit: true,
                charge_limit_presets: vec![],
                charge_limit_min: 60,
                charge_limit_max: 100,
                note: "Uses the open-source framework_tool CLI.".into(),
            };
        }
    }

    // --- Acer ---
    if mfg.contains("acer") {
        if wmi_class_exists("root\\WMI", "AcerGamingWMI") {
            return OemInfo {
                manufacturer: manufacturer.into(),
                model: model.into(),
                vendor: "acer".into(),
                supports_charge_limit: true,
                charge_limit_presets: vec![80, 100],
                charge_limit_min: 80,
                charge_limit_max: 100,
                note: "Acer PredatorSense Battery Limiter (80% cap or off).".into(),
            };
        }
    }

    // Fallback: unknown / unsupported
    OemInfo {
        manufacturer: manufacturer.into(),
        model: model.into(),
        vendor: "unknown".into(),
        supports_charge_limit: false,
        charge_limit_presets: vec![],
        charge_limit_min: 0,
        charge_limit_max: 0,
        note: "No supported vendor interface detected on this system.".into(),
    }
}

fn oem_info_cached() -> &'static OemInfo {
    OEM_INFO.get_or_init(|| {
        let (mfg, model) = detect_manufacturer_model();
        classify_oem(&mfg, &model)
    })
}

// ---------------------------------------------------------------------------
// Vendor-specific charge-limit get/set
// ---------------------------------------------------------------------------

fn lenovo_legion_get() -> ChargeLimitStatus {
    // `Get-LenovoChargeLimit`-style: read `rapidChargeMode` and `chargeThreshold` from LENOVO_GAMEZONE_DATA.
    let script = "try {
        $d = Get-CimInstance -Namespace root\\WMI -ClassName LENOVO_GAMEZONE_DATA
        $r = Invoke-CimMethod -InputObject $d -MethodName GetChargeThreshold
        Write-Output $r.Data
    } catch { Write-Output 'ERR:' + $_.Exception.Message }";
    match run_powershell(script) {
        Ok(s) if s.starts_with("ERR:") => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(s[4..].into()) },
        Ok(s) => {
            let v = s.trim().parse::<u8>().ok();
            ChargeLimitStatus { supported: true, enabled: v.map(|x| x < 100).unwrap_or(false), limit_percent: v, error: None }
        }
        Err(e) => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(e) },
    }
}

fn lenovo_legion_set(pct: u8) -> Result<(), String> {
    let script = format!(
        "$d = Get-CimInstance -Namespace root\\WMI -ClassName LENOVO_GAMEZONE_DATA
         $null = Invoke-CimMethod -InputObject $d -MethodName SetChargeThreshold -Arguments @{{ Data = [uint32]{pct} }}"
    );
    run_powershell(&script).map(|_| ())
}

fn lenovo_thinkpad_get() -> ChargeLimitStatus {
    let script = "try {
        $s = Get-CimInstance -Namespace root\\WMI -ClassName Lenovo_ChargeThresholdSetting -ErrorAction Stop
        # CurrentSetting is like '1,80' -> battery 1, stop at 80
        $parts = ($s | Select-Object -First 1).CurrentSetting -split ','
        Write-Output $parts[1]
    } catch { Write-Output 'ERR:' + $_.Exception.Message }";
    match run_powershell(script) {
        Ok(s) if s.starts_with("ERR:") => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(s[4..].into()) },
        Ok(s) => {
            let v = s.trim().parse::<u8>().ok();
            ChargeLimitStatus { supported: true, enabled: v.map(|x| x < 100).unwrap_or(false), limit_percent: v, error: None }
        }
        Err(e) => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(e) },
    }
}

fn lenovo_thinkpad_set(pct: u8) -> Result<(), String> {
    let script = format!(
        "$m = Get-CimInstance -Namespace root\\WMI -ClassName Lenovo_SetBiosSetting
         $null = Invoke-CimMethod -InputObject $m -MethodName SetBiosSetting -Arguments @{{ parameter = 'ChargeThreshold,1,{pct};' }}"
    );
    run_powershell(&script).map(|_| ())
}

fn asus_get() -> ChargeLimitStatus {
    // ASUS AsusAtkWmi_WMNB exposes DSTS (query) / DEVS (set). Parameter
    // names differ by model (arg0/arg1, IIA0/IIA1, Device_ID/Value, ...),
    // so we discover them from the class schema — the same trick G-Helper
    // uses in C#.
    let script = "try {
        $cls = Get-CimClass -Namespace root\\WMI -ClassName AsusAtkWmi_WMNB -ErrorAction Stop
        $inst = Get-CimInstance -Namespace root\\WMI -ClassName AsusAtkWmi_WMNB -ErrorAction Stop
        $method = $cls.CimClassMethods['DSTS']
        $inNames = @($method.Parameters | Where-Object { $_.Qualifiers['In'] } | Select-Object -ExpandProperty Name)
        $a = @{}
        $a[$inNames[0]] = [uint32]0x00120057
        $r = Invoke-CimMethod -InputObject $inst -MethodName DSTS -Arguments $a
        $val = 0
        foreach ($p in $r.PSObject.Properties) {
            if ($p.Name -ne 'PSComputerName' -and $p.Value -is [uint32]) { $val = $p.Value; break }
        }
        Write-Output ($val -band 0xFF)
    } catch { Write-Output ('ERR:' + $_.Exception.Message) }";
    match run_powershell(script) {
        Ok(s) if s.starts_with("ERR:") => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(s[4..].into()) },
        Ok(s) => {
            let v = s.trim().parse::<u8>().ok();
            ChargeLimitStatus { supported: true, enabled: v.map(|x| x < 100).unwrap_or(false), limit_percent: v, error: None }
        }
        Err(e) => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(e) },
    }
}

fn asus_set(pct: u8) -> Result<(), String> {
    // DEVS device-id 0x00120057, value = pct. Report the return value so we
    // can tell the user when the firmware refuses. Then read back and verify.
    let script = format!(
        "try {{
            $cls = Get-CimClass -Namespace root\\WMI -ClassName AsusAtkWmi_WMNB -ErrorAction Stop
            $inst = Get-CimInstance -Namespace root\\WMI -ClassName AsusAtkWmi_WMNB -ErrorAction Stop
            $setM = $cls.CimClassMethods['DEVS']
            $setIn = @($setM.Parameters | Where-Object {{ $_.Qualifiers['In'] }} | Select-Object -ExpandProperty Name)
            $sa = @{{}}
            $sa[$setIn[0]] = [uint32]0x00120057
            $sa[$setIn[1]] = [uint32]{pct}
            $rv = Invoke-CimMethod -InputObject $inst -MethodName DEVS -Arguments $sa
            $ret = 0
            foreach ($p in $rv.PSObject.Properties) {{
                if ($p.Name -ne 'PSComputerName' -and $p.Value -is [uint32]) {{ $ret = $p.Value; break }}
            }}
            Start-Sleep -Milliseconds 200
            $getM = $cls.CimClassMethods['DSTS']
            $getIn = @($getM.Parameters | Where-Object {{ $_.Qualifiers['In'] }} | Select-Object -ExpandProperty Name)
            $ga = @{{}}
            $ga[$getIn[0]] = [uint32]0x00120057
            $gv = Invoke-CimMethod -InputObject $inst -MethodName DSTS -Arguments $ga
            $cur = 0
            foreach ($p in $gv.PSObject.Properties) {{
                if ($p.Name -ne 'PSComputerName' -and $p.Value -is [uint32]) {{ $cur = $p.Value; break }}
            }}
            Write-Output ('OK:' + $ret + ':' + ($cur -band 0xFF))
        }} catch {{ Write-Output ('ERR:' + $_.Exception.Message) }}"
    );
    let out = run_powershell(&script)?;
    if let Some(rest) = out.strip_prefix("OK:") {
        let parts: Vec<&str> = rest.split(':').collect();
        if parts.len() == 2 {
            let readback = parts[1].trim().parse::<u8>().unwrap_or(0);
            if readback == pct {
                return Ok(());
            }
            // Firmware accepted the call but refused to persist the value —
            // common on ZenBook / Vivobook / older BIOSes where this device
            // ID isn't wired up.
            return Err(format!(
                "This ASUS model's firmware did not accept the charge limit \
                 (requested {pct}%, still reporting {readback}%). \
                 Your model may not support setting an arbitrary threshold."
            ));
        }
    }
    if let Some(msg) = out.strip_prefix("ERR:") {
        return Err(msg.trim().to_string());
    }
    Err(format!("Unexpected response from ASUS WMI: {out}"))
}

fn dell_get() -> ChargeLimitStatus {
    // Dell BIOS attribute "PrimaryBattChargeCfg" with value like "Custom:60-80" or "Standard"
    let script = "try {
        $e = Get-CimInstance -Namespace root\\DCIM\\SYSMAN -ClassName DCIM_BIOSEnumeration -Filter \"AttributeName='PrimaryBattChargeCfg'\" -ErrorAction Stop
        Write-Output $e.CurrentValue[0]
    } catch { Write-Output 'ERR:' + $_.Exception.Message }";
    match run_powershell(script) {
        Ok(s) if s.starts_with("ERR:") => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(s[4..].into()) },
        Ok(s) => {
            // Parse "Custom:55-80" -> 80, or "Standard" -> 100.
            let s = s.trim();
            let pct = if let Some(rest) = s.strip_prefix("Custom:") {
                rest.split('-').nth(1).and_then(|v| v.parse::<u8>().ok())
            } else if s.eq_ignore_ascii_case("Standard") || s.eq_ignore_ascii_case("Adaptive") {
                Some(100)
            } else if s.eq_ignore_ascii_case("PrimAcUse") || s.eq_ignore_ascii_case("Express") {
                Some(100)
            } else {
                None
            };
            ChargeLimitStatus { supported: true, enabled: pct.map(|x| x < 100).unwrap_or(false), limit_percent: pct, error: None }
        }
        Err(e) => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(e) },
    }
}

fn dell_set(pct: u8) -> Result<(), String> {
    // Custom mode requires a start and stop. We pick start = stop - 10 (clamped to 50).
    let start = pct.saturating_sub(10).max(50);
    let new_value = if pct >= 100 { "Standard".to_string() } else { format!("Custom:{start}-{pct}") };
    let script = format!(
        "$svc = Get-CimInstance -Namespace root\\DCIM\\SYSMAN -ClassName DCIM_BIOSService
         $null = Invoke-CimMethod -InputObject $svc -MethodName SetBIOSAttributes -Arguments @{{ AttributeName = @('PrimaryBattChargeCfg'); AttributeValue = @('{new_value}') }}"
    );
    run_powershell(&script).map(|_| ())
}

fn hp_get() -> ChargeLimitStatus {
    // HP_BIOSSetting where Name='Battery Health Manager' -> values "Let HP manage my battery charging" (standard) / "Maximize my battery health" (~80% cap)
    let script = "try {
        $s = Get-CimInstance -Namespace root\\HP\\InstrumentedBIOS -ClassName HP_BIOSSetting -Filter \"Name='Battery Health Manager'\" -ErrorAction Stop
        Write-Output $s.CurrentValue
    } catch { Write-Output 'ERR:' + $_.Exception.Message }";
    match run_powershell(script) {
        Ok(s) if s.starts_with("ERR:") => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(s[4..].into()) },
        Ok(s) => {
            let pct = if s.to_lowercase().contains("maximize") { Some(80) } else { Some(100) };
            ChargeLimitStatus { supported: true, enabled: pct == Some(80), limit_percent: pct, error: None }
        }
        Err(e) => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(e) },
    }
}

fn hp_set(pct: u8) -> Result<(), String> {
    let value = if pct <= 80 { "Maximize my battery health" } else { "Let HP manage my battery charging" };
    let script = format!(
        "$iface = Get-CimInstance -Namespace root\\HP\\InstrumentedBIOS -ClassName HP_BIOSSettingInterface
         $null = Invoke-CimMethod -InputObject $iface -MethodName SetBIOSSetting -Arguments @{{ Name = 'Battery Health Manager'; Value = '{value}' }}"
    );
    run_powershell(&script).map(|_| ())
}

fn msi_get() -> ChargeLimitStatus {
    // MSI exposes a BatteryMaster method on MSI_WMI.
    let script = "try {
        $m = Get-CimInstance -Namespace root\\WMI -ClassName MSI_WMI -ErrorAction Stop
        $r = Invoke-CimMethod -InputObject $m -MethodName GetBatteryMasterValue
        Write-Output $r.Data
    } catch { Write-Output 'ERR:' + $_.Exception.Message }";
    match run_powershell(script) {
        Ok(s) if s.starts_with("ERR:") => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(s[4..].into()) },
        Ok(s) => {
            // MSI Battery Master encodes mode: 0xE4 = best for battery (50%), 0xD0 = balanced (70%), 0xBE = best for mobility (80%), 0x80 = 100%.
            let raw = s.trim().parse::<u32>().ok();
            let pct = raw.and_then(|v| match v & 0xFF {
                0xE4 => Some(50),
                0xD0 => Some(70),
                0xBE => Some(80),
                0x80 => Some(100),
                other if other >= 0x80 => Some((0x80 + (0xFF - other as u16)) as u8),
                _ => None,
            });
            ChargeLimitStatus { supported: true, enabled: pct.map(|x| x < 100).unwrap_or(false), limit_percent: pct, error: None }
        }
        Err(e) => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(e) },
    }
}

fn msi_set(pct: u8) -> Result<(), String> {
    let code: u32 = match pct {
        p if p <= 50 => 0xE4,
        p if p <= 70 => 0xD0,
        p if p <= 80 => 0xBE,
        _ => 0x80,
    };
    let script = format!(
        "$m = Get-CimInstance -Namespace root\\WMI -ClassName MSI_WMI
         $null = Invoke-CimMethod -InputObject $m -MethodName SetBatteryMasterValue -Arguments @{{ Data = [uint32]0x{code:X} }}"
    );
    run_powershell(&script).map(|_| ())
}

fn samsung_get() -> ChargeLimitStatus {
    let script = "try {
        $m = Get-CimInstance -Namespace root\\WMI -ClassName SamsungPowerIntegration -ErrorAction Stop
        Write-Output $m.BatteryLifeExtender
    } catch { Write-Output 'ERR:' + $_.Exception.Message }";
    match run_powershell(script) {
        Ok(s) if s.starts_with("ERR:") => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(s[4..].into()) },
        Ok(s) => {
            let on = s.trim() == "1" || s.trim().eq_ignore_ascii_case("true");
            let pct = if on { Some(80) } else { Some(100) };
            ChargeLimitStatus { supported: true, enabled: on, limit_percent: pct, error: None }
        }
        Err(e) => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(e) },
    }
}

fn samsung_set(pct: u8) -> Result<(), String> {
    let on = pct <= 80;
    let val = if on { 1 } else { 0 };
    let script = format!(
        "$m = Get-CimInstance -Namespace root\\WMI -ClassName SamsungPowerIntegration
         $null = Invoke-CimMethod -InputObject $m -MethodName SetBatteryLifeExtender -Arguments @{{ Data = [uint32]{val} }}"
    );
    run_powershell(&script).map(|_| ())
}

fn framework_get() -> ChargeLimitStatus {
    // `framework_tool --charge-limit` prints something like "Charge limit: 80%"
    let out = Command::new("framework_tool")
        .arg("--charge-limit")
        .output()
        .map_err(|e| e.to_string());
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout);
            let pct = s.split(|c: char| !c.is_ascii_digit())
                .filter(|t| !t.is_empty())
                .next()
                .and_then(|v| v.parse::<u8>().ok());
            ChargeLimitStatus { supported: true, enabled: pct.map(|x| x < 100).unwrap_or(false), limit_percent: pct, error: None }
        }
        Ok(o) => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(String::from_utf8_lossy(&o.stderr).into_owned()) },
        Err(e) => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(e) },
    }
}

fn framework_set(pct: u8) -> Result<(), String> {
    let out = Command::new("framework_tool")
        .args(["--charge-limit", &pct.to_string()])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

fn acer_get() -> ChargeLimitStatus {
    let script = "try {
        $m = Get-CimInstance -Namespace root\\WMI -ClassName AcerGamingWMI -ErrorAction Stop
        $r = Invoke-CimMethod -InputObject $m -MethodName GetBatteryLimiter
        Write-Output $r.Data
    } catch { Write-Output 'ERR:' + $_.Exception.Message }";
    match run_powershell(script) {
        Ok(s) if s.starts_with("ERR:") => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(s[4..].into()) },
        Ok(s) => {
            let on = s.trim() == "1";
            let pct = if on { Some(80) } else { Some(100) };
            ChargeLimitStatus { supported: true, enabled: on, limit_percent: pct, error: None }
        }
        Err(e) => ChargeLimitStatus { supported: true, enabled: false, limit_percent: None, error: Some(e) },
    }
}

fn acer_set(pct: u8) -> Result<(), String> {
    let on = pct <= 80;
    let val = if on { 1 } else { 0 };
    let script = format!(
        "$m = Get-CimInstance -Namespace root\\WMI -ClassName AcerGamingWMI
         $null = Invoke-CimMethod -InputObject $m -MethodName SetBatteryLimiter -Arguments @{{ Data = [uint32]{val} }}"
    );
    run_powershell(&script).map(|_| ())
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

fn get_status_dispatch(vendor: &str) -> ChargeLimitStatus {
    match vendor {
        "lenovo_legion"   => lenovo_legion_get(),
        "lenovo_thinkpad" => lenovo_thinkpad_get(),
        "asus"            => asus_get(),
        "dell"            => dell_get(),
        "hp"              => hp_get(),
        "msi"             => msi_get(),
        "samsung"         => samsung_get(),
        "framework"       => framework_get(),
        "acer"            => acer_get(),
        _ => ChargeLimitStatus { supported: false, enabled: false, limit_percent: None, error: None },
    }
}

fn set_limit_dispatch(vendor: &str, pct: u8) -> Result<(), String> {
    match vendor {
        "lenovo_legion"   => lenovo_legion_set(pct),
        "lenovo_thinkpad" => lenovo_thinkpad_set(pct),
        "asus"            => asus_set(pct),
        "dell"            => dell_set(pct),
        "hp"              => hp_set(pct),
        "msi"             => msi_set(pct),
        "samsung"         => samsung_set(pct),
        "framework"       => framework_set(pct),
        "acer"            => acer_set(pct),
        _ => Err("Unsupported vendor".into()),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_oem_info() -> Result<OemInfo, String> {
    Ok(oem_info_cached().clone())
}

#[tauri::command]
pub fn get_charge_limit() -> Result<ChargeLimitStatus, String> {
    let info = oem_info_cached();
    if !info.supports_charge_limit {
        return Ok(ChargeLimitStatus {
            supported: false,
            enabled: false,
            limit_percent: None,
            error: None,
        });
    }
    // Catch any panic from the vendor-specific path and turn it into a
    // friendly "not supported" status so the UI never sees a raw error.
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        get_status_dispatch(&info.vendor)
    }));
    Ok(match res {
        Ok(mut status) => {
            if let Some(raw) = status.error.take() {
                status.error = Some(friendly_error(&info.vendor, &raw));
            }
            status
        }
        Err(_) => ChargeLimitStatus {
            supported: true,
            enabled: false,
            limit_percent: None,
            error: Some(unsupported_msg(&info.vendor)),
        },
    })
}

#[tauri::command]
pub fn set_charge_limit(percent: u8) -> Result<(), String> {
    let info = oem_info_cached();
    if !info.supports_charge_limit {
        return Err(unsupported_msg(&info.vendor));
    }
    let pct = percent.clamp(info.charge_limit_min, info.charge_limit_max);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        set_limit_dispatch(&info.vendor, pct)
    }));
    match res {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(friendly_error(&info.vendor, &e)),
        Err(_) => Err(unsupported_msg(&info.vendor)),
    }
}

fn unsupported_msg(_vendor: &str) -> String {
    "Charge limit is not supported on this device.".into()
}

fn friendly_error(vendor: &str, raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("access denied")
        || lower.contains("0x80041003")
        || lower.contains("0x80070005")
    {
        return "Access denied — please restart TaskManagerPlus as administrator.".into();
    }
    if lower.contains("not supported")
        || lower.contains("cannot find")
        || lower.contains("not find")
        || lower.contains("invalid")
        || lower.contains("0x8004100c")
        || lower.contains("did not accept")
    {
        return format!(
            "Charge limit is not supported on this {} model.",
            if vendor.is_empty() { "OEM" } else { vendor }
        );
    }
    "Charge limit could not be applied on this device.".into()
}

/// True if the current process is running with an elevated token.
#[tauri::command]
pub fn is_elevated() -> bool {
    is_process_elevated()
}

/// Relaunch the current executable with UAC elevation, then exit.
/// The caller should treat a successful return as "app is closing".
#[tauri::command]
pub fn relaunch_as_admin(app: tauri::AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;
    let exe_str = exe.to_string_lossy().to_string();

    // Use PowerShell Start-Process -Verb RunAs to trigger UAC.
    let script = format!(
        "Start-Process -FilePath '{}' -Verb RunAs",
        exe_str.replace('\'', "''")
    );
    let status = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .status()
        .map_err(|e| format!("powershell launch failed: {e}"))?;
    if !status.success() {
        return Err("User declined elevation or launch failed".into());
    }

    // Give the new process a moment to come up, then exit.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        app.exit(0);
    });
    Ok(())
}

#[cfg(windows)]
fn is_process_elevated() -> bool {
    use std::mem;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token: HANDLE = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut size = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
}

#[cfg(not(windows))]
fn is_process_elevated() -> bool {
    false
}
