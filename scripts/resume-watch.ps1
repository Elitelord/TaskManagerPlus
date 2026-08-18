<#
  resume-watch.ps1 — ambushes the post-resume freeze.

  Established: waking from hibernate reliably triggers a freeze ~1-3 min later in
  GPU-accelerated Chromium/Electron apps (Chrome, VS Code, Slack, Discord,
  Claude) while Firefox / Explorer / PowerShell / Task Manager stay fine, with
  ALL system resources normal. Recovers on its own after a few minutes.

  Why a special script: Process.Responding does NOT detect this — Chromium's
  browser process keeps pumping window messages while the renderer is wedged. So
  instead we watch the thing that actually reflects the stall: the per-process
  CPU + thread wait states of Chromium's GPU / renderer processes, sampled
  intensively for several minutes after every resume.

  Run it and forget it:
     powershell -ExecutionPolicy Bypass -File scripts\resume-watch.ps1
  Output: %TEMP%\tmp-freeze\resume-<time>.txt  (one file per resume event)
#>

$ErrorActionPreference = 'SilentlyContinue'
$outDir = Join-Path $env:TEMP 'tmp-freeze'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
try { (Get-Process -Id $PID).PriorityClass = 'High' } catch {}

$chromiumNames = @('chrome','msedgewebview2','slack','discord','code','claude','taskmanagerplus','spotify','ticktick')

function Dump-State([string]$file, [string]$label) {
    "`n================ $label  $(Get-Date -Format 'HH:mm:ss') ================" | Out-File $file -Append
    # Per-process CPU delta is the tell: a wedged renderer sits at 0% while the
    # window still 'responds'. Also capture thread wait reasons.
    $ps = Get-Process | Where-Object { $chromiumNames -contains $_.Name.ToLower() }
    "-- chromium/electron processes: $($ps.Count) --" | Out-File $file -Append
    $ps | Sort-Object -Property @{e={$_.PrivateMemorySize64}} -Descending | Select-Object -First 18 `
        Name, Id, @{n='CPUs';e={[math]::Round($_.CPU,1)}}, `
        @{n='PrivMB';e={[math]::Round($_.PrivateMemorySize64/1MB)}}, `
        @{n='Thr';e={$_.Threads.Count}}, HandleCount, Responding |
        Format-Table -AutoSize | Out-String -Width 200 | Out-File $file -Append

    "-- thread wait reasons (top) for biggest chromium procs --" | Out-File $file -Append
    foreach ($p in ($ps | Sort-Object -Property @{e={$_.Threads.Count}} -Descending | Select-Object -First 4)) {
        "[$($p.Name) pid=$($p.Id) threads=$($p.Threads.Count)]" | Out-File $file -Append
        $p.Threads | Group-Object ThreadState, WaitReason | Sort-Object Count -Descending |
            Select-Object -First 5 Count, Name | Format-Table -AutoSize | Out-String | Out-File $file -Append
    }

    "-- non-chromium controls (should stay healthy) --" | Out-File $file -Append
    Get-Process -Name firefox,explorer,taskmgr,powershell,dwm | Select-Object -First 8 `
        Name, Id, @{n='CPUs';e={[math]::Round($_.CPU,1)}}, Responding |
        Format-Table -AutoSize | Out-String | Out-File $file -Append

    $c = Get-Counter '\Memory\Available MBytes','\Processor Information(_Total)\% Processor Utility',
                     '\PhysicalDisk(_Total)\Avg. Disk sec/Read','\GPU Engine(*)\Utilization Percentage'
    $avail = ($c.CounterSamples | Where-Object { $_.Path -like '*available*' }).CookedValue
    $cpu   = ($c.CounterSamples | Where-Object { $_.Path -like '*utility*' }).CookedValue
    $disk  = ($c.CounterSamples | Where-Object { $_.Path -like '*sec/read*' }).CookedValue
    $gpu   = ($c.CounterSamples | Where-Object { $_.Path -like '*gpu engine*' } | Measure-Object CookedValue -Maximum).Maximum
    "-- system: availMB={0:F0} cpu={1:F1}% diskRead={2:F2}ms gpuMax={3:F1}% --" -f $avail,$cpu,$disk,$gpu |
        Out-File $file -Append
}

Write-Host "resume-watch running (High priority). Waiting for a resume..."
$sw = [System.Diagnostics.Stopwatch]::StartNew()

while ($true) {
    $sw.Restart()
    Start-Sleep -Seconds 10
    # A sleep that took far longer than asked == the machine was suspended.
    $slept = $sw.Elapsed.TotalSeconds
    if ($slept -gt 45) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $f = Join-Path $outDir "resume-$stamp.txt"
        "RESUME DETECTED at $(Get-Date). Machine was suspended ~$([math]::Round($slept)) s." | Out-File $f
        # Log what kind of resume it was.
        Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=(Get-Date).AddMinutes(-3); Id=27,42,107,506,507} |
            Sort-Object TimeCreated | ForEach-Object { "  [{0:HH:mm:ss}] id={1} {2}" -f $_.TimeCreated, $_.Id, (($_.Message -split "`n")[0]) } |
            Out-File $f -Append
        Write-Host "[$(Get-Date -Format HH:mm:ss)] RESUME (~$([math]::Round($slept))s) -> capturing 6 min into $f" -ForegroundColor Yellow

        # Intensive capture across the window where the freeze appears.
        Dump-State $f 'T+0s (immediately after resume)'
        foreach ($wait in 20,20,20,30,30,30,60,60,60,60) {
            Start-Sleep -Seconds $wait
            Dump-State $f "T+$([math]::Round((Get-Date).Subtract([datetime]::ParseExact($stamp,'yyyyMMdd-HHmmss',$null)).TotalSeconds))s"
        }
        "`n=== capture window complete ===" | Out-File $f -Append
        Write-Host "[$(Get-Date -Format HH:mm:ss)] capture complete -> $f" -ForegroundColor Green
    }
}
