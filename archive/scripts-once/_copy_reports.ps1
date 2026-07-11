[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$src = Join-Path $PSScriptRoot '报告'
$dst = 'C:\Users\杨铭\Desktop\Agent\报告'
if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
$files = Get-ChildItem -Path $src -Filter '*.md'
foreach ($f in $files) {
    Copy-Item -Path $f.FullName -Destination $dst -Force
    Write-Host "Copied: $($f.Name)"
}
Write-Host "Total: $($files.Count) files copied to $dst"
