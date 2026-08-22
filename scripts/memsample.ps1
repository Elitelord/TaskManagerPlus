<#
  memsample.ps1 — tracks where TaskManager+'s memory actually goes.

  Why this exists: "the app uses 900 MB" is useless on its own, because the
  footprint is split across seven processes owned by two completely different
  problems. Measured on a 23 h session:

      taskmanagerplus.exe (Rust core)  ~350 MB   <- AI backends never torn down
      msedgewebview2 gpu-process        187 MB   \
      msedgewebview2 renderer           183 MB    |
      msedgewebview2 browser             43 MB    |- the webview, ~440 MB total
      msedgewebview2 utility x2          26 MB    |
      msedgewebview2 crashpad-handler     3 MB   /

  Summing them hides which half moved. This samples the whole tree, split by
  process type, so a change can be attributed to the side that caused it.

  Two things it captures that Task Manager won't:

    * Private vs working set. Private > WorkingSet means commit has been
      trimmed to the pagefile — dead retained memory rather than a live cache.
      (A cache touched by the 1 Hz telemetry poll would be resident.)

    * The AI/GPU module list. The Vulkan ICD, shader compiler, ggml, ONNX
      Runtime and DirectML stay mapped long after "model freed (idle unload)"
      appears in the log. If a teardown fix works, these leave this list.
      That is the pass/fail signal, not the MB number alone.

  Requires PowerShell 7 (pwsh). Under Windows PowerShell 5.1 the tree walk
  silently yields zero rows — which for a measurement tool is worse than
  failing, so there is a hard version check below.

  Usage:
     pwsh -NoProfile -File scripts\memsample.ps1
     pwsh -NoProfile -File scripts\memsample.ps1 -Minutes 240 -IntervalSec 60
     pwsh -NoProfile -File scripts\memsample.ps1 -NoAiRun      # cold baseline

  Output: %TEMP%\tmp-memsample\memsample-<time>.csv  (plus a live console table)
#>

param(
    # Double, not int, so short smoke runs (-Minutes 0.5) aren't silently
    # truncated to zero and exit having sampled nothing.
    [double]$Minutes = 30,
    [int]$IntervalSec = 30,
    # Baseline runs (step 1A) should never touch an AI feature; pass -NoAiRun to
    # tag the CSV so cold-baseline and post-AI samples aren't compared by mistake.
    [switch]$NoAiRun
)

if ($PSVersionTable.PSVersion.Major -lt 6) {
    # ASCII only in this message on purpose: 5.1 decodes this UTF-8 file as
    # ANSI, and an em dash ends up as a byte that terminates the string literal
    # early, so a fancy error would die as a parse error instead of printing.
    Write-Error "memsample.ps1 needs PowerShell 7+. Run it with 'pwsh', not 'powershell'. Under 5.1 it samples nothing and still reports success."
    exit 1
}

$ErrorActionPreference = 'SilentlyContinue'

$outDir = Join-Path $env:TEMP 'tmp-memsample'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$tag = if ($NoAiRun) { 'coldbaseline' } else { 'normal' }
$csv = Join-Path $outDir ("memsample-{0}-{1}.csv" -f $tag, (Get-Date -Format 'yyyyMMdd-HHmmss'))

# DLLs whose presence proves a backend is still resident. Sizes are the
# observed image sizes on an AMD 890M box; other GPUs swap the ICD name.
$aiModules = @(
    'amdvlk64.dll', 'amdxc64.dll', 'nvoglv64.dll', 'igvk64.dll',   # Vulkan ICDs
    'ggml-vulkan.dll', 'llama.dll', 'dxcompiler.dll',
    'onnxruntime.dll', 'DirectML.dll', 'vulkan-1.dll'
)

function Get-AppTree {
    # Walk children of the main process so we only count OUR webview processes —
    # the machine is usually full of unrelated msedgewebview2 instances (Widgets,
    # Teams, Outlook), and counting those was the original measurement trap.
    $main = Get-Process -Name 'taskmanagerplus' | Sort-Object StartTime | Select-Object -First 1
    if (-not $main) { return $null }

    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
    $tree = New-Object System.Collections.ArrayList
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($main.Id)
    while ($queue.Count -gt 0) {
        $cur = $queue.Dequeue()
        $proc = $all | Where-Object { $_.ProcessId -eq $cur }
        if ($proc) { [void]$tree.Add($proc) }
        foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $cur })) { $queue.Enqueue($c.ProcessId) }
    }
    return $tree
}

"# TaskManager+ memory sample  started=$(Get-Date -Format 'o')  tag=$tag" | Out-File $csv -Encoding utf8
"ts,pid,name,type,privateMB,workingSetMB,handles,threads,aiModulesMapped" | Out-File $csv -Append -Encoding utf8

$deadline = (Get-Date).AddMinutes($Minutes)
Write-Host "Sampling every ${IntervalSec}s until $($deadline.ToString('HH:mm:ss'))  ->  $csv`n"

while ((Get-Date) -lt $deadline) {
    $tree = Get-AppTree
    if (-not $tree) {
        Write-Host "taskmanagerplus.exe not running - waiting..."
        Start-Sleep -Seconds $IntervalSec
        continue
    }

    $ts = Get-Date -Format 'HH:mm:ss'
    $rows = @()
    foreach ($t in $tree) {
        $p = Get-Process -Id $t.ProcessId
        if (-not $p) { continue }

        # WebView2 tags its role in the command line; the Rust core has none.
        $type = 'main'
        if ($t.CommandLine -match '--type=([a-zA-Z-]+)') { $type = $Matches[1] }

        # Only the Rust core loads the AI/GPU stack, so skip the scan for
        # webview children — enumerating modules is the slow part of a sample.
        $mapped = ''
        if ($t.Name -like 'taskmanagerplus*') {
            $names = $p.Modules | ForEach-Object { $_.ModuleName }
            $mapped = ($aiModules | Where-Object { $names -contains $_ }) -join ' '
        }

        $rows += [PSCustomObject]@{
            ts           = $ts
            pid          = $p.Id
            name         = $t.Name
            type         = $type
            privateMB    = [math]::Round($p.PrivateMemorySize64 / 1MB, 1)
            workingSetMB = [math]::Round($p.WorkingSet64 / 1MB, 1)
            handles      = $p.HandleCount
            threads      = $p.Threads.Count
            ai           = $mapped
        }
    }

    foreach ($r in $rows) {
        "{0},{1},{2},{3},{4},{5},{6},{7},{8}" -f `
            $r.ts, $r.pid, $r.name, $r.type, $r.privateMB, $r.workingSetMB, $r.handles, $r.threads, $r.ai |
            Out-File $csv -Append -Encoding utf8
    }

    $rust = ($rows | Where-Object { $_.name -like 'taskmanagerplus*' } | Measure-Object privateMB -Sum).Sum
    $wv   = ($rows | Where-Object { $_.name -like 'msedgewebview2*' } | Measure-Object privateMB -Sum).Sum
    $ai   = ($rows | Where-Object { $_.ai } | Select-Object -First 1).ai
    $aiCount = if ($ai) { ($ai -split ' ').Count } else { 0 }

    Write-Host ("{0}  rust={1,6:N0} MB   webview={2,6:N0} MB   total={3,6:N0} MB   procs={4}  aiDlls={5}" -f `
        $ts, $rust, $wv, ($rust + $wv), $rows.Count, $aiCount)

    Start-Sleep -Seconds $IntervalSec
}

Write-Host "`nDone. $csv"
Write-Host "Compare a -NoAiRun cold baseline against a post-AI run: if the Rust core"
Write-Host "returns to baseline after an idle unload AND the aiDlls column empties,"
Write-Host "backend teardown is working."
