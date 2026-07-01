# CDP 诊断脚本：连接到 Electron 渲染进程，检查 JS 执行状态
$ErrorActionPreference = 'Stop'

$pages = (Invoke-WebRequest -Uri "http://localhost:9222/json" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
$page = $pages | Where-Object { $_.url -like "*index.html*" } | Select-Object -First 1
if (-not $page) { Write-Host "No renderer page found"; exit 1 }
$wsUrl = $page.webSocketDebuggerUrl
Write-Host "Target: $($page.url)"
Write-Host "WS: $wsUrl"

$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = New-Object System.Threading.CancellationTokenSource(30000)
$uri = [Uri]$wsUrl
$connectTask = $ws.ConnectAsync($uri, $ct.Token)
while (-not $connectTask.IsCompleted) { Start-Sleep -Milliseconds 50 }
if ($connectTask.IsFaulted) { Write-Host "Connect failed: $($connectTask.Exception)"; exit 1 }
Write-Host "WebSocket connected: $($ws.State)"

function Send-Cdp($ws, $ct, $json) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $null = $ws.SendAsync($bytes, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct.Token)
}

function Recv-Cdp($ws, $ct, $timeoutMs = 3000) {
  $buf = New-Object byte[] 262144
  $result = $ws.ReceiveAsync($buf, $ct.Token)
  if ($result.Wait($timeoutMs)) {
    return [System.Text.Encoding]::UTF8.GetString($buf, 0, $result.Result.Count)
  }
  return $null
}

# 1. 启用 Runtime + Log
Send-Cdp $ws $ct '{"id":1,"method":"Runtime.enable","params":{}}'
Send-Cdp $ws $ct '{"id":2,"method":"Log.enable","params":{}}'
Send-Cdp $ws $ct '{"id":3,"method":"Page.enable","params":{}}'

Write-Host "`n=== 收集初始化事件 (3s) ==="
$endTime = (Get-Date).AddSeconds(3)
$ctxCount = 0
while ((Get-Date) -lt $endTime) {
  $msg = Recv-Cdp $ws $ct 500
  if ($msg) {
    if ($msg.Length -gt 300) { $msg = $msg.Substring(0,300) + "..." }
    Write-Host "INIT: $msg"
    if ($msg -match 'executionContextCreated') { $ctxCount++ }
  }
}
Write-Host "ExecutionContext count: $ctxCount"

# 2. 检查 #root 内容
$expr = 'try { var r = document.getElementById("root"); JSON.stringify({hasRoot: !!r, rootChildren: r?.children?.length || 0, rootHTML: (r?.innerHTML?.slice(0,800) || "EMPTY"), bodyChildCount: document.body.children.length, scripts: document.scripts.length, loadedScripts: Array.from(document.scripts).map(s=>s.src).join("|")}) } catch(e) { "EVAL_ERROR: " + e.message + " | " + e.stack }'
$exprJson = $expr | ConvertTo-Json -Compress
$cmd = "{`"id`":10,`"method`":`"Runtime.evaluate`",`"params`":{`"expression`":$exprJson,`"returnByValue`":true}}"
Send-Cdp $ws $ct $cmd

Write-Host "`n=== 等待 evaluate 响应 (5s) ==="
$endTime = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $endTime) {
  $msg = Recv-Cdp $ws $ct 1000
  if ($msg) {
    Write-Host "EVAL: $msg"
    if ($msg -match '"id":10') { break }
  }
}

# 3. 检查 JS 错误（通过 Log.entryAdded 或 Runtime.exceptionThrown）
Write-Host "`n=== 检查页面加载错误 ==="
$expr2 = 'try { performance.getEntriesByType("resource").map(e=>e.name).filter(n=>n.includes(".js")||n.includes(".css")).join("\\n") } catch(e) { "ERR:"+e.message }'
$expr2Json = $expr2 | ConvertTo-Json -Compress
$cmd2 = "{`"id`":11,`"method`":`"Runtime.evaluate`",`"params`":{`"expression`":$expr2Json,`"returnByValue`":true}}"
Send-Cdp $ws $ct $cmd2
$endTime = (Get-Date).AddSeconds(3)
while ((Get-Date) -lt $endTime) {
  $msg = Recv-Cdp $ws $ct 1000
  if ($msg) {
    Write-Host "RES: $msg"
    if ($msg -match '"id":11') { break }
  }
}

$ws.Dispose()
Write-Host "`n=== Done ==="
