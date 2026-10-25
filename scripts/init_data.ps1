# 从命令行执行数据初始化 (等价于网页上的按钮)
#
#   powershell -ExecutionPolicy Bypass -File scripts/init_data.ps1            # 全量 (最近两年)
#   powershell -ExecutionPolicy Bypass -File scripts/init_data.ps1 -Mode incremental
#   powershell -ExecutionPolicy Bypass -File scripts/init_data.ps1 -Mode targeted -Dates 2026-09-14,2026-09-15,2026-09-16

param(
    [ValidateSet("full", "incremental", "targeted")]
    [string]$Mode = "full",
    [string]$Dates = "",
    [string]$Python = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not $Python) {
    $candidate = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
    $Python = if (Test-Path $candidate) { $candidate } else { "python" }
}

$env:PYTHONIOENCODING = "utf-8"
$runId = "cli-$([DateTime]::Now.ToString('yyyyMMdd-HHmmss'))"

$args = @("-m", "app.cli.sync", "--mode", $Mode, "--run-id", $runId)
if ($Dates) { $args += @("--dates", $Dates) }

Write-Host "开始同步 (mode=$Mode, run_id=$runId) …" -ForegroundColor Green
& $Python @args
