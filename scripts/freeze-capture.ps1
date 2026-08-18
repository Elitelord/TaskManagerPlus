<#
  freeze-capture.ps1 — records system state continuously so an intermittent
  freeze can be diagnosed after the fact.

  Why this exists: the freeze (Explorer + all Chromium apps hang, native Task
  Manager stays responsive) cannot be diagnosed from a healthy snapshot. This
  logger runs at High priority so it survives CPU starvation, and samples the
  handful of signals that discriminate between the plausible causes:

    * "Responding" per GUI app  -> identifies the freeze and WHO hangs first
    * thread wait reasons       -> WHY they're blocked (file I/O? executive?)
    * disk latency / queue      -> storage stall
    * available RAM / pool      -> memory or kernel-pool exhaustion
    * CPU + top consumers       -> starvation
    * loop lag                  -> if THIS logger stalls, the stall is
                                   system-wide (kernel), not app-level

  Usage (no admin needed):
      powershell -ExecutionPolicy Bypass -File scripts\freeze-capture.ps1

  Leave it running. When a freeze happens, note the time. Output:
      %TEMP%\tmp-freeze\timeline.csv   — one line every 2s
      %TEMP%\tmp-freeze\hang-*.txt     — deep snapshot auto-captured on a hang
#>

$ErrorActionPreference = 'SilentlyContinue'
$outDir = Join-Path $env:TEMP 'tmp-freeze'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$timeline = Join-Path $outDir 'timeline.csv'

# Survive CPU starvation so we still get samples during the freeze.
try { (Get-Process -Id $PID).PriorityClass = 'High' } catch {}

# Apps whose responsiveness defines the symptom. Deliberately mixes engines so
# the log discriminates between causes:
#   Chromium/WebView2 : chrome, slack, claude, taskmanagerplus, msedgewebview2,
#                       code, discord, searchhost/searchapp (taskbar search)
#   D3D but NOT Chromium : windowsterminal  (freezes => GPU stack, not Chromium)
#   Win32/GDI + shell    : explorer, notepad (freeze => shell/filesystem, not GPU)
$watch = @('explorer','chrome','slack','claude','taskmanagerplus','msedgewebview2',
           'code','discord','searchhost','searchapp','startmenuexperiencehost',
           'windowsterminal','notepad','dwm')

if (-not (Test-Path $timeline)) {
    'time,loopLagMs,cpuPct,availMB,pagedPoolMB,nonPagedPoolMB,diskReadMs,diskWriteMs,diskQueue,diskIdlePct,gpuMaxPct,handles,hungApps' |
        Out-File $timeline -Encoding utf8
}

function Get-Sample {
    $c = Get-Counter -Counter `
        '\Processor Information(_Total)\% Processor Utility',
        '\Memory\Available MBytes',
        '\Memory\Pool Paged Bytes',
        '\Memory\Pool Nonpaged Bytes',
        '\PhysicalDisk(_Total)\Avg. Disk sec/Read',
        '\PhysicalDisk(_Total)\Avg. Disk sec/Write',
        '\PhysicalDisk(_Total)\Current Disk Queue Length',
        '\PhysicalDisk(_Total)\% Idle Time' -ErrorAction SilentlyContinue
    $v = @{}
    foreach ($s in $c.CounterSamples) { $v[($s.Path -split '\\')[-1]] = $s.CookedValue }

    # GPU engine utilization — a *stuck* GPU reads LOW, not high, so we log it
    # to distinguish "GPU busy" from "GPU wedged" during a freeze.
    $g = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples
    $v['gpuMaxPct'] = if ($g) { ($g | Measure-Object CookedValue -Maximum).Maximum } else { -1 }
    $v
}

Write-Host "freeze-capture running (High priority). Logging to $timeline"
Write-Host "Leave this window open. Ctrl+C to stop."

$lastHangDump = [datetime]::MinValue
$sw = [System.Diagnostics.Stopwatch]::StartNew()

while ($true) {
    $expected = 2000
    $sw.Restart()

    $v = Get-Sample
    $procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }
    $hung = @($procs | Where-Object { -not $_.Responding -and $watch -contains $_.Name.ToLower() })
    $hungNames = if ($hung.Count) { ($hung | ForEach-Object { "$($_.Name):$($_.Id)" }) -join ' ' } else { '' }

    $handles = (Get-Process | Measure-Object HandleCount -Sum).Sum
    $lag = [math]::Round($sw.ElapsedMilliseconds, 0)

    # F-format (not N) — N inserts thousands separators, which would corrupt the CSV.
    '{0},{1},{2:F1},{3:F0},{4:F0},{5:F0},{6:F2},{7:F2},{8:F1},{9:F1},{10:F1},{11},{12}' -f `
        (Get-Date -Format 'HH:mm:ss'),
        $lag,
        $v['% processor utility'],
        $v['available mbytes'],
        ($v['pool paged bytes']/1MB),
        ($v['pool nonpaged bytes']/1MB),
        ($v['avg. disk sec/read']*1000),
        ($v['avg. disk sec/write']*1000),
        $v['current disk queue length'],
        $v['% idle time'],
        $v['gpuMaxPct'],
        $handles,
        $hungNames | Out-File $timeline -Append -Encoding utf8

    # A hang is happening -> capture a deep snapshot (rate-limited to 1/min).
    if ($hung.Count -and ((Get-Date) - $lastHangDump).TotalSeconds -gt 60) {
        $lastHangDump = Get-Date
        $f = Join-Path $outDir ("hang-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
        "=== HANG DETECTED $(Get-Date) ===" | Out-File $f
        "hung apps: $hungNames" | Out-File $f -Append

        "`n--- thread wait reasons of hung processes (WHY they're blocked) ---" | Out-File $f -Append
        foreach ($p in $hung) {
            "`n[$($p.Name) pid=$($p.Id)]" | Out-File $f -Append
            $p.Threads | Group-Object ThreadState, WaitReason |
                Sort-Object Count -Descending | Select-Object -First 6 Count, Name |
                Format-Table -AutoSize | Out-String | Out-File $f -Append
        }

        "`n--- top 12 by CPU ---" | Out-File $f -Append
        Get-Process | Sort-Object CPU -Descending | Select-Object -First 12 Name, Id, CPU, `
            @{n='PrivMB';e={[math]::Round($_.PrivateMemorySize64/1MB)}}, HandleCount, Responding |
            Format-Table -AutoSize | Out-String | Out-File $f -Append

        "`n--- disk + memory at hang ---" | Out-File $f -Append
        ($v.GetEnumerator() | Sort-Object Name | ForEach-Object { "{0,-34} {1:N2}" -f $_.Key, $_.Value }) |
            Out-File $f -Append

        "`n--- ALL non-responding GUI apps ---" | Out-File $f -Append
        $procs | Where-Object { -not $_.Responding } | Select-Object Name, Id |
            Format-Table -AutoSize | Out-String | Out-File $f -Append

        Write-Host "[$(Get-Date -Format HH:mm:ss)] HANG captured -> $f" -ForegroundColor Yellow
    }

    $sleep = $expected - $sw.ElapsedMilliseconds
    if ($sleep -gt 0) { Start-Sleep -Milliseconds $sleep }
}
