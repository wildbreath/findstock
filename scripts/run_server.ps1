# 启动 Web 服务 (前端 + API)
#
#   powershell -ExecutionPolicy Bypass -File scripts/run_server.ps1

param(
    [string]$Python = "",
    [string]$Host = "127.0.0.1",
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not $Python) {
    $candidate = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
    $Python = if (Test-Path $candidate) { $candidate } else { "python" }
}

$env:PYTHONIOENCODING = "utf-8"
Write-Host "启动沪深A股自动筛选系统: http://${Host}:${Port}" -ForegroundColor Green

& $Python -m uvicorn --factory app.main:create_app --host $Host --port $Port
