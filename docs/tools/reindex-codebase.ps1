# Reindex RouteDev for codebase-memory-mcp (+ optional codegraph).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File docs/tools/reindex-codebase.ps1
$ErrorActionPreference = "Stop"
$bin = Join-Path $env:LOCALAPPDATA "Programs\codebase-memory-mcp\codebase-memory-mcp.exe"
$repo = Join-Path $env:USERPROFILE "Desktop\Agent\routedev"
$junc = "C:\tmp\routedev-idx"
if (-not (Test-Path $bin)) { throw "codebase-memory-mcp not found: $bin" }
if (-not (Test-Path $repo)) { throw "routedev not found: $repo" }
if (-not (Test-Path $junc)) {
  cmd /c "mklink /J `"$junc`" `"$repo`"" | Out-Host
}
Write-Host "Indexing via junction $junc -> $repo"
$payload = '{\"repo_path\":\"C:/tmp/routedev-idx\",\"mode\":\"fast\"}'
& $bin cli index_repository $payload
Write-Host "list_projects:"
& $bin cli list_projects '{}'
Write-Host "Optional: codegraph index (run inside routedev)"
$cg = Join-Path $env:LOCALAPPDATA "codegraph\current\bin\codegraph.cmd"
if (Test-Path $cg) {
  Push-Location $repo
  try {
    if (-not (Test-Path ".codegraph")) { & $cg init }
    & $cg index
    & $cg status
  } finally { Pop-Location }
}