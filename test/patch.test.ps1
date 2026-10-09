param()
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskCheck = Join-Path $taskRoot ('.work\patch-check-' + [Guid]::NewGuid().ToString('N'))
$taskLocal = Join-Path $taskCheck '격리 데이터 폴더'
$taskApp = Join-Path $taskLocal 'Programs\system0'
$taskData = Join-Path $taskLocal 'system0'
$taskPatch = Join-Path $taskCheck '패치 폴더\system0 patch.cmd'
$taskHold = $null

function Run-Patch([int]$CodePage = 949) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $info.Arguments = '/d /c chcp ' + $CodePage + ' >nul & call "' + $taskPatch + '"'
    $info.WorkingDirectory = $taskCheck
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.RedirectStandardInput = $true
    $info.EnvironmentVariables['LOCALAPPDATA'] = $taskLocal
    $info.EnvironmentVariables['SYSTEM0_ENV_FILE'] = Join-Path $taskData '.env'
    $info.EnvironmentVariables['SYSTEM0_PATCH_NO_PAUSE'] = '1'
    $process = [System.Diagnostics.Process]::Start($info)
    try {
        $process.StandardInput.WriteLine('')
        $process.StandardInput.Close()
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) { $process.Kill(); throw '패치 실행 시간 초과' }
        return @{ Code = $process.ExitCode; Message = $output.Result + $errors.Result }
    } finally { $process.Dispose() }
}
function Assert-Hash($File, $Expected, $Message) {
    if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -ne $Expected) { throw $Message }
}

[System.IO.Directory]::CreateDirectory((Join-Path $taskApp 'runtime')) | Out-Null
[System.IO.Directory]::CreateDirectory((Join-Path $taskApp 'public')) | Out-Null
[System.IO.Directory]::CreateDirectory($taskData) | Out-Null
try {
    & (Join-Path $taskRoot 'installer\build-patch.ps1') -OutputFile $taskPatch
    $taskExpected = (Get-FileHash -LiteralPath (Join-Path $taskRoot 'public\app.js')).Hash
    $taskBatchBytes = [System.IO.File]::ReadAllBytes($taskPatch)
    if ($taskBatchBytes | Where-Object { $_ -ge 128 }) { throw '패치 CMD는 ASCII여야 합니다.' }
    if ([System.Text.Encoding]::ASCII.GetString($taskBatchBytes) -match '(?<!\r)\n') { throw '패치 CMD는 CRLF여야 합니다.' }
    Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $taskApp 'runtime\node.exe')
    Copy-Item -LiteralPath (Join-Path $taskRoot 'installer\launch.mjs') -Destination (Join-Path $taskApp 'launch.mjs')
    [System.IO.File]::WriteAllText((Join-Path $taskApp 'server.mjs'), '// isolated fixture')
    [System.IO.File]::WriteAllText((Join-Path $taskApp 'package.json'), '{"name":"system0","version":"0.1.4"}')
    [System.IO.File]::WriteAllText((Join-Path $taskApp 'public\app.js'), '// original fixture')
    $taskHelper = Join-Path $taskCheck 'fixture.mjs'
    $taskReady = Join-Path $taskCheck 'ready.json'
    $taskStop = Join-Path $taskCheck 'stop'
    $taskRunning = Join-Path $taskCheck 'running'
    @'
import { createServer } from 'node:http';
import { writeFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
const [app,data,ready,stop,running] = process.argv.slice(2);
const db = new DatabaseSync(path.join(data, 'system0.sqlite'));
db.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('preserve-me')"); db.close();
const server = createServer((_request,response) => response.end(JSON.stringify({
  app: existsSync(running) ? 'system0' : 'fixture-other-service', instance: app
})));
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
writeFileSync(path.join(data,'.env'), `OPENAI_API_KEY=sk-proj-patch-fixture\nPORT=${server.address().port}\n`);
writeFileSync(ready, JSON.stringify({port:server.address().port}));
try {
  const deadline = Date.now() + 120000;
  while (!existsSync(stop) && Date.now() < deadline) await delay(100);
} finally { await new Promise(resolve => server.close(resolve)); }
'@ | Set-Content -LiteralPath $taskHelper -Encoding utf8
    $taskHold = Start-Process -FilePath (Join-Path $taskApp 'runtime\node.exe') -ArgumentList @(
      ('"' + $taskHelper + '"'), ('"' + $taskApp + '"'), ('"' + $taskData + '"'), ('"' + $taskReady + '"'), ('"' + $taskStop + '"'), ('"' + $taskRunning + '"')) -WindowStyle Hidden -PassThru
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $taskReady) -and [DateTime]::UtcNow -lt $taskDeadline) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path -LiteralPath $taskReady)) { throw '격리 상태 확인 서버 준비 실패' }
    $taskEnv = Join-Path $taskData '.env'
    $taskDb = Join-Path $taskData 'system0.sqlite'
    $taskEnvHash = (Get-FileHash -LiteralPath $taskEnv).Hash
    $taskDbHash = (Get-FileHash -LiteralPath $taskDb).Hash
    $taskAppHashes = @{}
    foreach ($file in @('server.mjs', 'launch.mjs', 'runtime\node.exe', 'package.json')) {
        $taskAppHashes[$file] = (Get-FileHash -LiteralPath (Join-Path $taskApp $file)).Hash
    }
    foreach ($taskCodePage in @(949,65001)) {
        [System.IO.File]::WriteAllText((Join-Path $taskApp 'public\app.js'), '// previous file CP' + $taskCodePage)
        $result = Run-Patch $taskCodePage
        if ($result.Code -ne 0) { throw ('패치 적용 실패: ' + $result.Message) }
        Assert-Hash (Join-Path $taskApp 'public\app.js') $taskExpected '화면 파일 교체 실패'
        Assert-Hash $taskEnv $taskEnvHash '패치가 설정을 변경했습니다.'
        Assert-Hash $taskDb $taskDbHash '패치가 DB를 변경했습니다.'
    }
    foreach ($file in $taskAppHashes.Keys) { Assert-Hash (Join-Path $taskApp $file) $taskAppHashes[$file] '화면 파일 외 프로그램 파일이 변경되었습니다.' }
    [System.IO.File]::WriteAllText((Join-Path $taskApp 'public\app.js'), '// running app must not change')
    $taskBlockedHash = (Get-FileHash -LiteralPath (Join-Path $taskApp 'public\app.js')).Hash
    [System.IO.File]::WriteAllText($taskRunning, 'running')
    $result = Run-Patch
    if ($result.Code -eq 0) { throw '실행 중 패치가 차단되지 않았습니다.' }
    Assert-Hash (Join-Path $taskApp 'public\app.js') $taskBlockedHash '실행 중 파일이 교체되었습니다.'
    Remove-Item -LiteralPath $taskRunning
    [System.IO.File]::WriteAllText((Join-Path $taskApp 'package.json'), '{"name":"system0","version":"0.1.5"}')
    if ((Run-Patch).Code -eq 0) { throw '지원하지 않는 버전이 허용되었습니다.' }
    Remove-Item -LiteralPath (Join-Path $taskApp 'package.json')
    if ((Run-Patch).Code -eq 0) { throw '설치 없는 경로에서 패치가 적용되었습니다.' }
    Assert-Hash (Join-Path $taskApp 'public\app.js') $taskBlockedHash '실패 요청이 화면 파일을 변경했습니다.'
    Assert-Hash $taskEnv $taskEnvHash '실패 요청이 설정을 변경했습니다.'
    Assert-Hash $taskDb $taskDbHash '실패 요청이 DB를 변경했습니다.'
    Write-Output '패치 검증 통과: 실제 CMD, CP949/65001, 한글·공백 경로, 단일 파일 교체, DB·설정 보존, 실행 중·미설치·다른 버전 차단'
}
finally {
    if ($taskHold -and -not $taskHold.HasExited) {
        [System.IO.File]::WriteAllText((Join-Path $taskCheck 'stop'), 'stop')
        if (-not $taskHold.WaitForExit(10000)) { Stop-Process -Id $taskHold.Id -Force }
    }
    $taskResolved = [System.IO.Path]::GetFullPath($taskCheck)
    $taskAllowed = [System.IO.Path]::GetFullPath((Join-Path $taskRoot '.work')) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $taskResolved.StartsWith($taskAllowed, [System.StringComparison]::OrdinalIgnoreCase)) { throw '검증 폴더 경로 확인 실패' }
    if (Test-Path -LiteralPath $taskResolved) { Remove-Item -LiteralPath $taskResolved -Recurse -Force }
}
