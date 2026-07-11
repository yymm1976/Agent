$src = Join-Path (Get-Location) "Agent工具开发综合报告.md"
$dst = "C:\Users\杨铭\Desktop\Agent\报告\Agent工具开发综合报告.md"
Copy-Item $src $dst -Force
Write-Host "Copied to $dst"
