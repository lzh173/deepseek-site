#requires -Version 7.0
<#
.SYNOPSIS
    把 start-ray.ps1 注册成 Windows 计划任务，实现开机自启。

.DESCRIPTION
    默认：当前用户登录时启动（推荐，不需要管理员权限，数据目录权限天然正确）。
    可选：-AtStartup 以 SYSTEM 身份开机即启（需要管理员 PowerShell，且要确认
          node.exe 与 data 目录对 SYSTEM 可读写）。

.EXAMPLE
    pwsh -File deploy\windows\install-task.ps1

.EXAMPLE
    # 以管理员身份运行
    pwsh -File deploy\windows\install-task.ps1 -AtStartup

.EXAMPLE
    pwsh -File deploy\windows\install-task.ps1 -Uninstall
#>

param(
    [switch]$AtStartup,
    [switch]$Uninstall,
    [string]$TaskName = 'Ray'
)

$ErrorActionPreference = 'Stop'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "[ray] 已移除计划任务 $TaskName"
    }
    else {
        Write-Host "[ray] 计划任务 $TaskName 不存在"
    }
    return
}

$script = Join-Path $PSScriptRoot 'start-ray.ps1'
if (-not (Test-Path $script)) {
    throw "找不到启动脚本：$script"
}

$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
if (-not $pwsh) {
    throw '找不到 pwsh（PowerShell 7）。请先安装 https://aka.ms/powershell'
}

$action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

if ($AtStartup) {
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
}
else {
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
}

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "[ray] 已注册计划任务：$TaskName"
Write-Host "      启动时机：$(if ($AtStartup) { '开机' } else { '当前用户登录' })"
Write-Host "      立即启动：Start-ScheduledTask -TaskName $TaskName"
Write-Host "      卸载：    pwsh -File deploy\windows\install-task.ps1 -Uninstall"
