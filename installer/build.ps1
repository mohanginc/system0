param()
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskBuild = Join-Path $taskRoot ('.work\installer-' + [Guid]::NewGuid().ToString('N'))
$taskOutput = Join-Path $taskRoot 'outputs\installer'
$taskVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json).version

function Get-VerifiedFile($Uri, $Destination, $Sha256) {
    Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $Sha256) {
        throw "다운로드 무결성 확인 실패: $Uri"
    }
}

New-Item -ItemType Directory -Path $taskBuild, $taskOutput -Force | Out-Null
try {
    $taskNodeVersion = '24.21.0'
    $taskNodeZip = Join-Path $taskBuild 'node.zip'
    Get-VerifiedFile "https://nodejs.org/dist/v$taskNodeVersion/node-v$taskNodeVersion-win-x64.zip" $taskNodeZip '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
    Expand-Archive -LiteralPath $taskNodeZip -DestinationPath (Join-Path $taskBuild 'node')
    $taskNodeSource = Join-Path $taskBuild "node\node-v$taskNodeVersion-win-x64"

    $taskCompilerSetup = Join-Path $taskBuild 'inno-setup.exe'
    Get-VerifiedFile 'https://github.com/jrsoftware/issrc/releases/download/is-7_1_0/innosetup-7.1.0-x64.exe' $taskCompilerSetup '0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f'
    $taskCompiler = Join-Path $taskBuild 'inno'
    $taskInstall = Start-Process -FilePath $taskCompilerSetup -ArgumentList @('/PORTABLE=1', '/CURRENTUSER', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOICONS', ('/DIR="' + $taskCompiler + '"')) -WindowStyle Hidden -Wait -PassThru
    if ($taskInstall.ExitCode -ne 0) { throw '설치 파일 컴파일러 준비 실패' }

    $taskPayload = Join-Path $taskBuild 'payload'
    New-Item -ItemType Directory -Path $taskPayload, (Join-Path $taskPayload 'runtime') -Force | Out-Null
    foreach ($taskFile in @('server.mjs', 'package.json', 'package-lock.json')) {
        Copy-Item -LiteralPath (Join-Path $taskRoot $taskFile) -Destination $taskPayload
    }
    foreach ($taskFolder in @('lib', 'public', 'prompts')) {
        Copy-Item -LiteralPath (Join-Path $taskRoot $taskFolder) -Destination $taskPayload -Recurse
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'launch.mjs'), (Join-Path $PSScriptRoot 'start.cmd') -Destination $taskPayload
    # CMD requires Windows line endings; ASCII avoids code-page parsing errors.
    $taskBatch = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'start.cmd'))
    if ($taskBatch -match '[^\x00-\x7F]') { throw 'start.cmd는 ASCII 문자만 사용해야 합니다.' }
    [System.IO.File]::WriteAllText((Join-Path $taskPayload 'start.cmd'), (($taskBatch -replace '\r?\n', "`r`n")), [System.Text.Encoding]::ASCII)
    Copy-Item -LiteralPath (Join-Path $taskNodeSource 'node.exe'), (Join-Path $taskNodeSource 'LICENSE') -Destination (Join-Path $taskPayload 'runtime')
    & (Join-Path $taskNodeSource 'node.exe') (Join-Path $taskNodeSource 'node_modules\npm\bin\npm-cli.js') ci --prefix $taskPayload --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw '운영 의존성 준비 실패' }
    $taskUnsafe = Get-ChildItem -LiteralPath $taskPayload -Force -Recurse -File | Where-Object { $_.Name -eq '.env' -or $_.Name -like '*.sqlite*' -or $_.Name -like '*.db*' }
    if ($taskUnsafe) { throw '패키지에 설정 또는 운영 데이터가 포함되어 있습니다.' }

    & (Join-Path $taskCompiler 'ISCC.exe') '/Qp' "/DPayloadDir=$taskPayload" "/DAppVersion=$taskVersion" "/O$taskOutput" (Join-Path $PSScriptRoot 'setup.iss')
    if ($LASTEXITCODE -ne 0) { throw '설치 EXE 생성 실패' }
    Get-Item -LiteralPath (Join-Path $taskOutput "system0-setup-$taskVersion.exe") | Select-Object FullName, Length
    Copy-Item -LiteralPath (Join-Path $taskPayload 'start.cmd') -Destination (Join-Path $taskOutput 'start.cmd')
}
finally {
    $taskResolved = [System.IO.Path]::GetFullPath($taskBuild)
    $taskAllowed = [System.IO.Path]::GetFullPath((Join-Path $taskRoot '.work')) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $taskResolved.StartsWith($taskAllowed, [System.StringComparison]::OrdinalIgnoreCase)) { throw '임시 폴더 경로 확인 실패' }
    if (Test-Path -LiteralPath $taskResolved) { Remove-Item -LiteralPath $taskResolved -Recurse -Force }
}
