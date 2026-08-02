# scripts/setup-dev-env.ps1
# Phase 40 Task 0：将项目目录加入 Windows Defender 排除列表
# 需要以管理员身份运行
# 用法：powershell -ExecutionPolicy Bypass -File scripts/setup-dev-env.ps1

$ErrorActionPreference = 'Stop'

# 获取项目根目录（脚本所在目录的父目录）
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Resolve-Path (Join-Path $ScriptDir '..')).Path

Write-Host ''
Write-Host '===================================================' -ForegroundColor Cyan
Write-Host '  RouteDev 开发环境配置（Windows Defender 排除）' -ForegroundColor Cyan
Write-Host '===================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host "  项目根目录: $ProjectRoot" -ForegroundColor Gray
Write-Host ''

# ============================================================
# 检测管理员权限
# ============================================================
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host '[X] 需要管理员权限才能修改 Windows Defender 排除列表。' -ForegroundColor Red
    Write-Host ''
    Write-Host '请以管理员身份运行此脚本：' -ForegroundColor Yellow
    Write-Host '  1. 右键点击 PowerShell，选择「以管理员身份运行」' -ForegroundColor Yellow
    Write-Host "  2. 执行: powershell -ExecutionPolicy Bypass -File `"$ScriptDir\setup-dev-env.ps1`"" -ForegroundColor Yellow
    Write-Host ''
    exit 1
}

Write-Host '[OK] 已检测到管理员权限' -ForegroundColor Green
Write-Host ''

# ============================================================
# 构建排除路径列表
# ============================================================
$exclusionPaths = @(
    $ProjectRoot
    (Join-Path $ProjectRoot 'node_modules')
)

# 排除常见构建输出目录模式 release-v*
$releasePattern = Join-Path $ProjectRoot 'release-v*'
$exclusionPaths += $releasePattern

# ============================================================
# 添加排除路径
# ============================================================
Write-Host '-> 添加 Windows Defender 排除路径：' -ForegroundColor Cyan
foreach ($p in $exclusionPaths) {
    Write-Host "  - $p" -ForegroundColor Gray
    try {
        Add-MpPreference -ExclusionPath $p
        Write-Host '    [OK] 已添加' -ForegroundColor Green
    } catch {
        Write-Host "    [!] 已存在或添加失败: $_" -ForegroundColor Yellow
    }
}

Write-Host ''
Write-Host '===================================================' -ForegroundColor Cyan
Write-Host '  [OK] Windows Defender 排除配置完成' -ForegroundColor Green
Write-Host ''
Write-Host '  提示：' -ForegroundColor Cyan
Write-Host '  - 项目目录和 node_modules 已排除扫描' -ForegroundColor Gray
Write-Host '  - release-v* 构建输出目录已排除扫描' -ForegroundColor Gray
Write-Host '  - 这将避免构建时 app.asar 被 Defender 锁定' -ForegroundColor Gray
Write-Host '===================================================' -ForegroundColor Cyan
Write-Host ''
