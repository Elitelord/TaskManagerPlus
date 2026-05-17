# Walk Program Files directories enumerating .exe basenames.
#
# Output: scripts/ml/data/walked_processes.txt — one lowercased basename per
# line, deduplicated, sorted.
#
# We intentionally walk only the top two levels of each program dir to avoid
# pulling in tens of thousands of helper / installer / uninstaller exes that
# add noise without changing what the model sees in practice. Most apps put
# their primary exe in their first or second directory.
#
# Reads only — produces no side effects beyond the output file.

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path "$PSScriptRoot\..\.."
$outDir = Join-Path $repoRoot 'scripts\ml\data'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$outFile = Join-Path $outDir 'walked_processes.txt'

# Roots to walk. WindowsApps is intentionally excluded — packaged-app exes
# carry hashes and version suffixes that bloat the dataset without adding
# signal. Same for $env:LOCALAPPDATA\Programs (varies per user).
$roots = @(
    "$env:ProgramFiles",
    "${env:ProgramFiles(x86)}",
    "$env:LOCALAPPDATA\Programs"
) | Where-Object { $_ -and (Test-Path $_) }

Write-Host "Walking roots:"
$roots | ForEach-Object { Write-Host "  $_" }

$names = New-Object System.Collections.Generic.HashSet[string]

foreach ($root in $roots) {
    # First-level dirs under each root.
    Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $appDir = $_.FullName

        # Top of app dir.
        Get-ChildItem -Path $appDir -Filter '*.exe' -File -ErrorAction SilentlyContinue | ForEach-Object {
            [void]$names.Add($_.Name.ToLowerInvariant())
        }

        # One level deeper (catches `bin/`, `App/`, `current/`, etc.).
        Get-ChildItem -Path $appDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            Get-ChildItem -Path $_.FullName -Filter '*.exe' -File -ErrorAction SilentlyContinue | ForEach-Object {
                [void]$names.Add($_.Name.ToLowerInvariant())
            }
        }
    }
}

$sorted = $names | Sort-Object
Set-Content -Path $outFile -Value $sorted -Encoding utf8
Write-Host ""
Write-Host "Wrote $($sorted.Count) unique exe basenames to:"
Write-Host "  $outFile"
