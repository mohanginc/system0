param([string]$OutputFile)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputFile) { $OutputFile = Join-Path $taskRoot 'outputs\installer\system0-patch-invoices.cmd' }
$OutputFile = [System.IO.Path]::GetFullPath($OutputFile)
$taskFiles = @('server.mjs', 'lib/database.mjs', 'lib/naming.mjs', 'lib/llm.mjs', 'lib/shipping.mjs',
    'lib/naver.mjs', 'lib/shipping-preview.mjs', 'lib/invoices.mjs', 'prompts/product-names.md',
    'node_modules/bcryptjs/index.js', 'node_modules/bcryptjs/package.json', 'node_modules/bcryptjs/LICENSE')
$taskCryptoPackages = @('officecrypto-tool', 'cfb', 'adler-32', 'crc-32', 'crypto-js', 'xml2js', 'sax', 'xmlbuilder')
foreach ($taskPackageName in $taskCryptoPackages) {
    $taskPackageRoot = Join-Path $taskRoot ('node_modules\' + $taskPackageName)
    if (Test-Path -LiteralPath (Join-Path $taskPackageRoot 'node_modules')) { throw '암호화 의존성의 중첩 버전을 확인해 주세요.' }
    $taskPackageInfo = Get-Content -LiteralPath (Join-Path $taskPackageRoot 'package.json') -Raw | ConvertFrom-Json
    foreach ($taskDependency in $taskPackageInfo.dependencies.PSObject.Properties.Name) {
        if ($taskDependency -and $taskDependency -notin $taskCryptoPackages) { throw ('추가 암호화 의존성을 확인해 주세요: ' + $taskDependency) }
    }
    $taskRuntimePattern = switch ($taskPackageName) {
        'officecrypto-tool' { '^(index\.js|src/.+\.js)$' }
        'cfb' { '^cfb\.js$' }
        'adler-32' { '^adler32\.js$' }
        'crc-32' { '^crc32\.js$' }
        'crypto-js' { '^(?!crypto-js\.js$)[^/]+\.js$' }
        'xml2js' { '^lib/(?!xml2js\.bc\.js$).+\.js$' }
        default { '^lib/.+\.js$' }
    }
    $taskFiles += Get-ChildItem -LiteralPath $taskPackageRoot -Recurse -File | Where-Object {
        $relative = $_.FullName.Substring($taskPackageRoot.Length + 1).Replace('\', '/')
        $relative -match '^(package\.json|LICENSE(?:\.md)?)$' -or $relative -match $taskRuntimePattern
    } | ForEach-Object { $_.FullName.Substring($taskRoot.Length + 1).Replace('\', '/') }
}
$taskFiles += Get-ChildItem -LiteralPath (Join-Path $taskRoot 'public') -Recurse -File |
    Where-Object { $_.Extension -in @('.html', '.css', '.js', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico') } |
    ForEach-Object { $_.FullName.Substring($taskRoot.Length + 1).Replace('\', '/') }
$taskSha = [System.Security.Cryptography.SHA256]::Create()
try {
    $taskPayload = @($taskFiles | Sort-Object -Unique | ForEach-Object {
        $bytes = [System.IO.File]::ReadAllBytes((Join-Path $taskRoot $_))
        @{ path = $_; base64 = [Convert]::ToBase64String($bytes); sha256 = [BitConverter]::ToString($taskSha.ComputeHash($bytes)).Replace('-', '') }
    }) | ConvertTo-Json -Depth 4 -Compress
}
finally { $taskSha.Dispose() }

$taskScript = @'
$ErrorActionPreference = 'Stop'
$stage = $null
$installed = @()
$preserveStage = $false
$app = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\system0'))
$appBoundary = $app + [System.IO.Path]::DirectorySeparatorChar
try {
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
    $payload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__FILES_PAYLOAD__')) | ConvertFrom-Json
    $stage = Join-Path $app ('.patch-' + [Guid]::NewGuid().ToString('N'))
    $seen = @{}
    foreach ($file in $payload) {
        if ($file.path -notmatch '^(server\.mjs|lib/(database|naming|llm|shipping|naver|shipping-preview|invoices)\.mjs|prompts/product-names\.md|node_modules/bcryptjs/(index\.js|package\.json|LICENSE)|node_modules/(officecrypto-tool|cfb|adler-32|crc-32|crypto-js|xml2js|sax|xmlbuilder)/([^:]+\.(js|json)|LICENSE(\.md)?)|public/[^:]+\.(html|css|js|svg|png|jpg|jpeg|webp|ico))$' -or
            $file.path.Split('/') -contains '..' -or $file.path.Contains('\') -or $seen.ContainsKey($file.path)) {
            throw '패치 파일 경로를 확인할 수 없습니다.'
        }
        $seen[$file.path] = $true
        $target = [System.IO.Path]::GetFullPath((Join-Path $app $file.path))
        if (-not $target.StartsWith($appBoundary, [StringComparison]::OrdinalIgnoreCase)) { throw '패치 대상이 설치 폴더 밖입니다.' }
        for ($check = $target; $check.Length -ge $app.Length; $check = [System.IO.Path]::GetDirectoryName($check)) {
            if (Test-Path -LiteralPath $check) {
                if ((Get-Item -LiteralPath $check -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                    throw '연결된 폴더에는 패치를 적용할 수 없습니다.'
                }
            }
        }
        $bytes = [Convert]::FromBase64String($file.base64)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '') }
        finally { $sha.Dispose() }
        if ($hash -ne $file.sha256) { throw '패치 내용이 손상되었습니다. 패치 파일을 다시 받아 주세요.' }
        $pending = Join-Path (Join-Path $stage 'new') $file.path
        [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($pending)) | Out-Null
        [System.IO.File]::WriteAllBytes($pending, $bytes)
    }
    foreach ($file in $payload) {
        $target = Join-Path $app $file.path
        $pending = Join-Path (Join-Path $stage 'new') $file.path
        $backup = Join-Path (Join-Path $stage 'old') $file.path
        [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
        $existed = [System.IO.File]::Exists($target)
        if ($existed) {
            [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($backup)) | Out-Null
            [System.IO.File]::Replace($pending, $target, $backup)
        } else { [System.IO.File]::Move($pending, $target) }
        $installed += @{ target = $target; backup = $backup; existed = $existed }
    }
    Write-Host '패치 적용 완료. system0를 다시 실행해 주세요.'
    exit 0
}
catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    for ($index = $installed.Count - 1; $index -ge 0; $index--) {
        $file = $installed[$index]
        try {
            if ($file.existed) { [System.IO.File]::Replace($file.backup, $file.target, [NullString]::Value) }
            else { Remove-Item -LiteralPath $file.target -Force }
        } catch { $preserveStage = $true; Write-Host ('원래 파일 복구가 필요합니다: ' + $file.target) -ForegroundColor Red }
    }
    if ($preserveStage) { Write-Host ('기존 파일 보관 위치: ' + $stage) }
    exit 1
}
finally {
    if ($stage -and -not $preserveStage -and (Test-Path -LiteralPath $stage)) {
        $resolvedStage = [System.IO.Path]::GetFullPath($stage)
        if (-not $resolvedStage.StartsWith($appBoundary, [StringComparison]::OrdinalIgnoreCase)) { throw '패치 임시 폴더 경로 확인 실패' }
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
'@
$taskScript = $taskScript.Replace('__FILES_PAYLOAD__', [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($taskPayload)))
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
