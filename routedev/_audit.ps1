$ErrorActionPreference = 'Continue'
Set-Location "c:\Users\杨铭\Desktop\Agent\routedev"

# 收集所有 src/*.ts 源文件（不含 test）
$srcFiles = Get-ChildItem -Path src -Recurse -Filter "*.ts" |
  Where-Object { $_.FullName -notmatch "\\tests\\" -and $_.FullName -notmatch "\\.test\." } |
  Select-Object -ExpandProperty FullName

Write-Host ("Total src/*.ts: " + $srcFiles.Count)

# 收集所有非测试文件中的 import 引用
$rgOutput = rg -t ts -N -o "from\s+'(\.\.?/[^']+)'" src desktop scripts 2>$null
if (-not $rgOutput) { $rgOutput = @() }
$imports = @()
foreach ($line in $rgOutput) {
  if ($line -match "from\s+'(\.\.?/[^']+)'") {
    $imports += $Matches[1]
  }
}
$imports = $imports | Sort-Object -Unique
Write-Host ("Unique import paths: " + $imports.Count)
$imports | Out-File -FilePath _import-paths.txt -Encoding utf8

# 对每个 src 文件，检查它有没有被 import（基于 src 相对路径）
$unreferenced = @()
foreach ($f in $srcFiles) {
  $idx = $f.IndexOf('\src\')
  if ($idx -lt 0) { continue }
  $rel = $f.Substring($idx + 1) -replace '\\', '/'
  $relNoExt = $rel -replace '\.ts$', ''
  $found = $false
  foreach ($imp in $imports) {
    $impNoExt = $imp -replace '\.js$', ''
    if ($impNoExt.EndsWith("/" + $relNoExt) -or $impNoExt -eq "./" + $relNoExt -or $impNoExt -eq $relNoExt) {
      $found = $true
      break
    }
  }
  if (-not $found) {
    $unreferenced += $rel
  }
}

$unreferenced | Sort-Object | Out-File -FilePath _unreferenced-src.txt -Encoding utf8
Write-Host ("Unreferenced src files: " + $unreferenced.Count)
Get-Content _unreferenced-src.txt
