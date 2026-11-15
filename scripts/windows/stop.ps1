# Stop YuChao (backend uvicorn + optional vite dev server)
[CmdletBinding()]
param(
    [int]$Port = 8031,
    [int]$DevPort = 5178
)

$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logDir = Join-Path $root ".logs"

function Kill-Tree([int]$processId) {
    taskkill /PID $processId /T /F | Out-Null
}

function Stop-ByPidFile([string]$name) {
    $f = Join-Path $logDir "$name.pid"
    if (Test-Path $f) {
        $processId = (Get-Content $f | Select-Object -First 1).Trim()
        if ($processId -match '^\d+$') {
            $proc = Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue
            if ($proc) {
                Write-Host "[$name] stopping pid $processId"
                Kill-Tree ([int]$processId)
            }
        }
        Remove-Item $f -Force -ErrorAction SilentlyContinue
    }
}

function Stop-ByPort([string]$name, [int]$port) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        $processId = $c.OwningProcess
        if ($processId -and $processId -ne 0) {
            Write-Host "[$name] killing listener on port $port (pid $processId)"
            Kill-Tree ([int]$processId)
        }
    }
}

Stop-ByPidFile "frontend"
Stop-ByPidFile "backend"
Stop-ByPort "frontend" $DevPort
Stop-ByPort "backend" $Port

Write-Host "YuChao stopped."
