# YuChao status: ports, pids, health probe, recent log lines
[CmdletBinding()]
param(
    [int]$Port = 8031,
    [int]$DevPort = 5178
)

$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logDir = Join-Path $root ".logs"

function Show-One([string]$name, [int]$port) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    $pidFile = Join-Path $logDir "$name.pid"
    $savedPid = if (Test-Path $pidFile) { (Get-Content $pidFile | Select-Object -First 1).Trim() } else { "-" }
    if ($conns) {
        $owner = ($conns | Select-Object -First 1).OwningProcess
        Write-Host ("[{0}] RUNNING  port {1}  pid {2} (pidfile {3})" -f $name, $port, $owner, $savedPid) -ForegroundColor Green
    } else {
        Write-Host ("[{0}] stopped  port {1}  (pidfile {2})" -f $name, $port, $savedPid) -ForegroundColor DarkGray
    }
}

Show-One "backend" $Port
Show-One "frontend" $DevPort

try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 5
    Write-Host "[healthz] $($r.StatusCode) $($r.Content)"
    $s = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/v1/data/status" -UseBasicParsing -TimeoutSec 15
    Write-Host "[data/status] $($s.StatusCode) OK ($($s.Content.Length) bytes)"
} catch {
    Write-Host "[healthz] unreachable: $($_.Exception.Message)" -ForegroundColor Yellow
}

foreach ($name in @("backend.err.log", "backend.out.log")) {
    $f = Join-Path $logDir $name
    if ((Test-Path $f) -and (Get-Item $f).Length -gt 0) {
        Write-Host ""
        Write-Host "---- $name (last 12 lines) ----"
        Get-Content $f -Tail 12 -Encoding UTF8
    }
}
