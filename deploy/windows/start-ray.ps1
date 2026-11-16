#requires -Version 7.0
<#
.SYNOPSIS
    以「非 Docker」方式在本机运行 Ray（BFF + 静态站点）。

.DESCRIPTION
    1. 切到 server/ 目录
    2. 确保 data/ 与 logs/ 存在
    3. 前台运行 node，崩溃后 5 秒自动重启
    4. 输出按启动时间落盘到 logs/ray-<时间戳>.log

    首次使用前先完成：
        pnpm install
        pnpm build
        copy server\.env.example server\.env   # 然后编辑

.EXAMPLE
    pwsh -File deploy\windows\start-ray.ps1
#>

$ErrorActionPreference = 'Stop'

# 脚本在 deploy\windows\ 下，仓库根是上两级
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$serverDir = Join-Path $repoRoot 'server'
$logDir = Join-Path $repoRoot 'logs'

if (-not (Test-Path $serverDir)) {
    throw "找不到 server 目录：$serverDir"
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $repoRoot 'data') | Out-Null

Set-Location $serverDir

Write-Host "[ray] 工作目录：$serverDir"
Write-Host "[ray] 日志目录：$logDir"

while ($true) {
    $logFile = Join-Path $logDir ("ray-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Write-Host "[ray] 启动于 $(Get-Date -Format 's')，日志 -> $logFile"

    try {
        # Node >= 24：类型剥离默认开启，这里保留 flag 以兼容 22/23
        node --env-file-if-exists=.env --experimental-strip-types src/index.ts *>> $logFile
        $code = $LASTEXITCODE
    }
    catch {
        $_ | Out-String | Add-Content $logFile
        $code = 1
    }

    Write-Warning "[ray] 进程退出（code=$code），5 秒后重启"
    Start-Sleep -Seconds 5
}
