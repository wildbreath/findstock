# 启动 Web 服务 (前端 + API)
#
#   powershell -ExecutionPolicy Bypass -File scripts/run_server.ps1

param(
    [string]$Python = "",
    [Alias("Host")]
    [string]$ListenHost = "127.0.0.1",
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not $Python) {
    $candidate = Join-Path $projectRoot ".venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $candidate) {
        $Python = $candidate
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        $Python = "python"
    } else {
        $Python = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
    }
}

$env:PYTHONIOENCODING = "utf-8"
Write-Host "启动沪深A股自动筛选系统: http://${ListenHost}:${Port}" -ForegroundColor Green

& $Python (Join-Path $PSScriptRoot "launcher.py") --host $ListenHost --port $Port --no-browser
exit $LASTEXITCODE
