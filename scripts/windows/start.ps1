# YuChao Windows launcher (PowerShell 5.1+)
#   .\scripts\windows\start.ps1            # production: backend 8031 serves frontend/dist
#   .\scripts\windows\start.ps1 -Dev       # dev: backend 8031 + vite hot-reload 5178 (open 5178)
#   .\scripts\windows\start.ps1 -RebuildDb # drop nothing, just re-run schema bootstrap (idempotent)
#
# Logs: .logs\backend.out.log / .logs\backend.err.log (and frontend.*.log in -Dev)
# Stop: .\scripts\windows\stop.ps1   Status: .\scripts\windows\status.ps1
[CmdletBinding()]
param(
    [switch]$Dev,
    [int]$Port = 8031,
    [int]$DevPort = 5178,
    [switch]$NoBuild,
    [switch]$RebuildDb
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$venvPy  = Join-Path $root ".venv\Scripts\python.exe"
$logDir  = Join-Path $root ".logs"
$dataDir = Join-Path $root "data"
$dbPath  = Join-Path $dataDir "stock_research.duckdb"
$distIdx = Join-Path $root "frontend\dist\index.html"
$distDir = Join-Path $root "frontend\dist"

New-Item -ItemType Directory -Force -Path $logDir, $dataDir | Out-Null

function Test-Port([int]$p) {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    return [bool]$c
}

function Wait-Port([int]$p, [int]$seconds) {
    for ($i = 0; $i -lt $seconds * 2; $i++) {
        if (Test-Port $p) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Tail([string]$file, [int]$n = 15) {
    if (Test-Path $file) { Get-Content $file -Tail $n -Encoding UTF8 }
}

if (-not (Test-Path $venvPy)) {
    Write-Host "[backend] .venv not found. Run:" -ForegroundColor Red
    Write-Host "  python -m venv .venv" -ForegroundColor Yellow
    Write-Host "  .\.venv\Scripts\python.exe -m pip install -e `".[dev]`"" -ForegroundColor Yellow
    exit 1
}

# ---- 1. database skeleton -------------------------------------------------
if ($RebuildDb -or -not (Test-Path $dbPath)) {
    Write-Host "[db] bootstrapping $dbPath"
    & $venvPy (Join-Path $root "scripts\bootstrap_db.py")
    if ($LASTEXITCODE -ne 0) { Write-Host "[db] bootstrap failed" -ForegroundColor Red; exit 1 }
}
else {
    Write-Host "[db] using existing $dbPath"
}

# ---- 2. frontend dist ----------------------------------------------------
if (-not $NoBuild -and -not (Test-Path $distIdx)) {
    Write-Host "[frontend] dist missing, building (npm run build)..."
    Push-Location (Join-Path $root "frontend")
    try {
        if (-not (Test-Path "node_modules")) { & npm.cmd install --no-audit --no-fund }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { Write-Host "[frontend] build failed" -ForegroundColor Red; exit 1 }
    }
    finally { Pop-Location }
}

# ---- 3. backend ----------------------------------------------------------
if (Test-Port $Port) {
    Write-Host "[backend] port $Port already listening - assumed running (use stop.ps1 to restart)" -ForegroundColor Yellow
}
else {
    Write-Host "[backend] starting -> http://127.0.0.1:$Port  (log .logs\backend.out.log)"
    $env:PYTHONUNBUFFERED = "1"
    $env:PYTHONIOENCODING = "utf-8"
    $env:YUCHAO_DUCKDB_PATH = $dbPath
    $p = Start-Process -FilePath $venvPy `
        -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                        "--port", "$Port", "--log-level", "info") `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logDir "backend.out.log") `
        -RedirectStandardError  (Join-Path $logDir "backend.err.log")
    $p.Id | Set-Content (Join-Path $logDir "backend.pid")

    if (-not (Wait-Port $Port 120)) {
        Write-Host "[backend] FAILED to listen in 120s, last log lines:" -ForegroundColor Red
        Tail (Join-Path $logDir "backend.err.log") 20
        Tail (Join-Path $logDir "backend.out.log") 20
        exit 1
    }
    Write-Host "[backend] ready (pid $($p.Id))" -ForegroundColor Green
}

# ---- 4. optional dev server ---------------------------------------------
if ($Dev) {
    if (Test-Port $DevPort) {
        Write-Host "[frontend] port $DevPort already listening - assumed running" -ForegroundColor Yellow
    }
    else {
        Write-Host "[frontend] starting vite -> http://localhost:$DevPort"
        $env:YUCHAO_API = "http://127.0.0.1:$Port"
        $f = Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "dev", "--", "--port", "$DevPort") `
            -WorkingDirectory (Join-Path $root "frontend") -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $logDir "frontend.out.log") `
            -RedirectStandardError  (Join-Path $logDir "frontend.err.log")
        $f.Id | Set-Content (Join-Path $logDir "frontend.pid")
        if (Wait-Port $DevPort 60) {
            Write-Host "[frontend] ready (pid $($f.Id))" -ForegroundColor Green
        } else {
            Write-Host "[frontend] vite did not listen in 60s, see .logs\frontend.err.log" -ForegroundColor Red
        }
    }
}

Write-Host ""
if ($Dev) {
    Write-Host "YuChao is up:" -ForegroundColor Green
    Write-Host "  dev UI (hot reload) : http://localhost:$DevPort"
    Write-Host "  API / prod UI       : http://127.0.0.1:$Port      (docs: /docs)"
} else {
    Write-Host "YuChao is up: http://localhost:$Port   (API docs: http://127.0.0.1:$Port/docs)" -ForegroundColor Green
}
Write-Host "Stop: .\scripts\windows\stop.ps1    Status: .\scripts\windows\status.ps1"
