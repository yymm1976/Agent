[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$lines = Get-Content 'c:\Users\杨铭\Desktop\Agent\routedev\src\tools\builtin\spawn-agent.ts' -Encoding UTF8
for ($i = 230; $i -lt 310; $i++) {
    '{0,4}: {1}' -f ($i+1), $lines[$i]
}
