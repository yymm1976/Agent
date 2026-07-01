$files = @(
    "多Agent协作流程框架调研报告-2026更新版.md",
    "实用型Coding-Agent的功能体系解构与自研项目构建指南.md",
    "开源项目调研报告-Phase53借鉴素材-2026-06-27.md",
    "Agent工具交互展示方案研究报告.md",
    "交叉验证报告-2026-06-28.md",
    "RouteDev-全量代码审查报告-2026-06-27.md",
    "RouteDev全量代码审查报告.md",
    "多Agent协作流程框架调研报告.md"
)

$base = 'C:\Users\杨铭\Desktop\Agent\报告\'

foreach ($f in $files) {
    $path = Join-Path $base $f
    if (Test-Path $path) {
        Write-Host "=== FILE: $f ==="
        $content = Get-Content -Path $path -Raw -Encoding UTF8
        Write-Host $content
        Write-Host "`n"
    } else {
        Write-Host "=== FILE: $f - NOT FOUND ==="
    }
}
