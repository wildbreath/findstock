# 在桌面创建 / 更新 "一键启动" 快捷方式
#
#   powershell -ExecutionPolicy Bypass -File scripts/install_shortcut.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/install_shortcut.ps1 -Remove
#
# 快捷方式指向项目根目录下的 启动系统.bat, 双击即可启动系统并自动打开浏览器。

param(
    [string]$Name = "沪深A股筛选系统",
    [switch]$Remove
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $projectRoot "启动系统.bat"
$icon = Join-Path $projectRoot "assets\findstock.ico"
$desktop = [Environment]::GetFolderPath("Desktop")
$linkPath = Join-Path $desktop "$Name.lnk"

if ($Remove) {
    if (Test-Path -LiteralPath $linkPath) {
        Remove-Item -LiteralPath $linkPath -Force
        Write-Host "已删除快捷方式: $linkPath" -ForegroundColor Yellow
    } else {
        Write-Host "未找到快捷方式: $linkPath" -ForegroundColor Yellow
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $launcher)) {
    Write-Error "找不到启动文件: $launcher"
    exit 1
}

if (-not (Test-Path -LiteralPath $icon)) {
    Write-Host "图标不存在, 正在生成…" -ForegroundColor Cyan
    $python = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
    if (-not (Test-Path -LiteralPath $python)) { $python = "python" }
    Push-Location $projectRoot
    try { & $python -X utf8 -m scripts.make_icon } finally { Pop-Location }
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = "一键启动沪深A股自动筛选系统"
$shortcut.WindowStyle = 1
if (Test-Path -LiteralPath $icon) { $shortcut.IconLocation = "$icon,0" }
$shortcut.Save()

Write-Host "已创建桌面快捷方式: $linkPath" -ForegroundColor Green
Write-Host "双击即可启动系统 (服务就绪后会自动打开浏览器)。" -ForegroundColor Green
