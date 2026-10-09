param([string]$OutputFile)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputFile) { $OutputFile = Join-Path $taskRoot 'outputs\installer\system0-patch-review-save.cmd' }
$OutputFile = [System.IO.Path]::GetFullPath($OutputFile)
$taskBytes = [System.IO.File]::ReadAllBytes((Join-Path $taskRoot 'public\app.js'))
$taskSha = [System.Security.Cryptography.SHA256]::Create()
try { $taskHash = [BitConverter]::ToString($taskSha.ComputeHash($taskBytes)).Replace('-', '') }
finally { $taskSha.Dispose() }

$taskScript = @'
$ErrorActionPreference = 'Stop'
$pending = $null
try {
    $app = Join-Path $env:LOCALAPPDATA 'Programs\system0'
    foreach ($file in @('package.json', 'server.mjs', 'launch.mjs', 'runtime\node.exe', 'public\app.js')) {
        if (-not (Test-Path -LiteralPath (Join-Path $app $file) -PathType Leaf)) {
            throw 'system0 설치를 찾을 수 없습니다. 0.1.4 설치판이 있는 컴퓨터에서 실행해 주세요.'
        }
    }
    $package = [System.IO.File]::ReadAllText((Join-Path $app 'package.json')) | ConvertFrom-Json
    if ($package.name -ne 'system0' -or $package.version -ne '0.1.4') {
        throw '이 패치는 system0 0.1.4 설치판에서만 사용할 수 있습니다.'
    }
    & (Join-Path $app 'runtime\node.exe') (Join-Path $app 'launch.mjs') --check-stopped
    if ($LASTEXITCODE -ne 0) {
        throw 'system0가 실행 중이거나 실행 상태를 확인하지 못했습니다. 실행 창에서 Ctrl+C로 종료한 뒤 다시 실행해 주세요.'
    }
    $bytes = [Convert]::FromBase64String('__APP_PAYLOAD__')
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '') }
    finally { $sha.Dispose() }
    if ($hash -ne '__APP_SHA256__') { throw '패치 내용이 손상되었습니다. 패치 파일을 다시 받아 주세요.' }
    $target = Join-Path $app 'public\app.js'
    $pending = $target + '.patch-' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [System.IO.File]::WriteAllBytes($pending, $bytes)
    [System.IO.File]::Replace($pending, $target, [NullString]::Value)
    $pending = $null
    Write-Host '패치 적용 완료. system0를 다시 실행해 주세요.'
    exit 0
}
catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
finally { if ($pending -and (Test-Path -LiteralPath $pending)) { Remove-Item -LiteralPath $pending -Force } }
'@
$taskScript = $taskScript.Replace('__APP_PAYLOAD__', [Convert]::ToBase64String($taskBytes)).Replace('__APP_SHA256__', $taskHash)
$taskEncoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($taskScript))
$taskBatch = @'
@echo off
setlocal
chcp 65001 >nul
title system0 patch
set "SYSTEM0_PATCH_FILE=%~f0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$raw=[IO.File]::ReadAllText($env:SYSTEM0_PATCH_FILE); $parts=$raw -split '(?m)^:SYSTEM0_PAYLOAD\r?$',2; & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1].Trim()))))"
set "SYSTEM0_PATCH_EXIT=%ERRORLEVEL%"
if not "%SYSTEM0_PATCH_NO_PAUSE%"=="1" pause
exit /b %SYSTEM0_PATCH_EXIT%
:SYSTEM0_PAYLOAD
__POWERSHELL_PAYLOAD__
'@
$taskBatch = $taskBatch.Replace('__POWERSHELL_PAYLOAD__', $taskEncoded) -replace '\r?\n', "`r`n"
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($OutputFile)) | Out-Null
[System.IO.File]::WriteAllText($OutputFile, $taskBatch + "`r`n", [System.Text.Encoding]::ASCII)
Get-Item -LiteralPath $OutputFile | Select-Object FullName, Length
