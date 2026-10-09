param([string]$Installer)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not $Installer) {
    $taskVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json).version
    $Installer = Join-Path $taskRoot "outputs\installer\system0-setup-$taskVersion.exe"
}
$Installer = [System.IO.Path]::GetFullPath($Installer)
$taskCheck = Join-Path $taskRoot ('.work\installer-check-' + [Guid]::NewGuid().ToString('N'))
$taskApp = Join-Path $taskCheck '설치 앱'
$taskData = Join-Path $taskCheck '운영 데이터'
$taskRegistry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{C8D8D708-2A19-4B03-9D1F-72B31A58CC28}_is1'
if (Test-Path -LiteralPath $taskRegistry) { throw '이미 설치된 system0가 있어 격리 설치 검증을 중단합니다.' }
$taskSavedEnv = @{}
foreach ($taskName in @('SYSTEM0_ENV_FILE', 'SYSTEM0_INSTALL_API_KEY', 'PATH')) {
    $taskSavedEnv[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process')
}
$taskHold = $null
$taskInstalled = $false

function Run-Setup {
    $taskProcess = Start-Process -FilePath $Installer -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOICONS', '/TASKS=""', ('/DIR="' + $taskApp + '"'), ('/DATADIR="' + $taskData + '"')) -WindowStyle Hidden -Wait -PassThru
    return $taskProcess.ExitCode
}

New-Item -ItemType Directory -Path $taskCheck -Force | Out-Null
try {
    $env:SYSTEM0_ENV_FILE = Join-Path $taskData '.env'
    $env:SYSTEM0_INSTALL_API_KEY = 'sk-proj-system0-installer-test'
    if ((Run-Setup) -ne 0) { throw '최초 설치 실패' }
    $taskInstalled = $true
    $taskNode = Join-Path $taskApp 'runtime\node.exe'
    if (-not (Test-Path -LiteralPath $taskNode)) { throw '번들 Node.js 누락' }
    foreach ($taskItem in @('server.mjs', 'lib\excel.mjs', 'public\index.html', 'prompts\product-names.md')) {
        if ((Get-FileHash -LiteralPath (Join-Path $taskRoot $taskItem)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $taskApp $taskItem)).Hash) { throw "설치 내용 불일치: $taskItem" }
    }
    $taskSettings = Get-Content -LiteralPath $env:SYSTEM0_ENV_FILE -Raw
    if ($taskSettings -notmatch 'OPENAI_API_KEY=sk-proj-system0-installer-test' -or $taskSettings -notmatch 'PORT=3100') { throw '최초 설정 저장 실패' }

    $taskScript = Join-Path $taskCheck 'check.mjs'
    @'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const [mode, app, data, stopFile] = process.argv.slice(2);
const cfg = path.join(data, '.env');
if (mode === 'prepare') {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('PORT=3100', `PORT=${port}`)
    + `DATABASE_PATH=${path.join(data, 'system0.sqlite')}\n`);
  process.exit(0);
}
if (mode === 'cmd') {
  const filename = path.join(app, 'launch.mjs'), original = readFileSync(filename);
  const marker = path.join(data, 'cmd-start.json');
  try {
    writeFileSync(filename, `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.SYSTEM0_CMD_TEST_MARKER, JSON.stringify({ node: process.execPath, cwd: process.cwd() }));\n`);
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `chcp 949 >nul & call "${path.join(app, 'start.cmd')}"`],
      { encoding: 'utf8', timeout: 10000, windowsHide: true, windowsVerbatimArguments: true, input: '\r\n', env: { ...process.env, SYSTEM0_CMD_TEST_MARKER: marker } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const observed = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal(path.resolve(observed.node).toLowerCase(), path.join(app, 'runtime', 'node.exe').toLowerCase());
    assert.equal(path.resolve(observed.cwd).toLowerCase(), path.resolve(app).toLowerCase());
  } finally { writeFileSync(filename, original); }
  process.exit(0);
}
const { launch } = await import(pathToFileURL(path.join(app, 'launch.mjs')));
const XLSX = createRequire(path.join(app, 'package.json'))('xlsx');
let url = `http://127.0.0.1:${parseEnv(readFileSync(cfg, 'utf8')).PORT}`;
const child = await launch({ envFile: cfg, browser: mode === 'browser' ? undefined : async value => { url = value; } });
assert.ok(child, 'a new bundled server must start');
try {
  const api = async (route, options) => {
    const response = await fetch(url + route, options); assert.ok(response.ok, await response.clone().text()); return response;
  };
  assert.equal((await (await api('/api/status')).json()).app, 'system0');
  if (mode === 'browser') {
    await delay(1500);
  } else if (mode === 'hold') {
    writeFileSync(stopFile + '.ready', 'ready');
    const deadline = Date.now() + 60000;
    while (!existsSync(stopFile) && Date.now() < deadline) await delay(100);
  } else if (mode === 'workflow') {
    let opened = 0;
    assert.equal(await launch({ envFile: cfg, browser: async () => { opened++; } }), null);
    assert.equal(opened, 1);
    const raw = [['주문번호', '원상품명', '수량', '전화번호'], ['00001', '테스트 원본', 1, '01001230000'], ['00002', '테스트 원본', 2, '01001230000']];
    const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(raw), '주문');
    const form = new FormData(); form.append('files', new Blob([XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })]), '검증 주문.xlsx');
    const detail = await (await api('/api/import', { method: 'POST', body: form })).json();
    assert.equal(detail.rows.length, 2);
    await api(`/api/batches/${detail.batch.id}/rows`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: detail.rows.map(row => ({ id: row.id, cleanedName: '직원 검수 테스트 제목', reviewNote: '검수 저장 확인', status: 'confirmed' })) }) });
    const bytes = Buffer.from(await (await api(`/api/batches/${detail.batch.id}/export`)).arrayBuffer());
    const exported = XLSX.read(bytes, { type: 'buffer' });
    const expected = raw.map(row => [...row]); expected[1][1] = expected[2][1] = '직원 검수 테스트 제목';
    assert.deepEqual(XLSX.utils.sheet_to_json(exported.Sheets['주문'], { header: 1 }), expected);
    assert.ok((await (await api('/api/backup', { method: 'POST' })).arrayBuffer()).byteLength > 1000);
  } else if (mode === 'verify') {
    const batches = (await (await api('/api/batches')).json()).batches; assert.equal(batches.length, 1);
    const rows = (await (await api(`/api/batches/${batches[0].id}`)).json()).rows; assert.equal(rows.length, 2);
    for (const row of rows) { assert.equal(row.cleanedName, '직원 검수 테스트 제목'); assert.equal(row.reviewNote, '검수 저장 확인'); assert.equal(row.status, 'confirmed'); }
  }
} finally {
  const ended = once(child, 'exit'); child.send({ type: 'system0-shutdown' }); await ended;
}
'@ | Set-Content -LiteralPath $taskScript -Encoding utf8
    # Only the bundled runtime is available on PATH during the app check.
    $env:PATH = Join-Path $env:SystemRoot 'System32'
    & $taskNode $taskScript prepare $taskApp $taskData
    if ($LASTEXITCODE -ne 0) { throw '격리 설정 실패' }
    & $taskNode $taskScript cmd $taskApp $taskData
    if ($LASTEXITCODE -ne 0) { throw '설치된 start.cmd의 실제 CMD 실행 실패' }
    & $taskNode $taskScript workflow $taskApp $taskData
    if ($LASTEXITCODE -ne 0) { throw '번들 실행·가져오기·검수·다운로드 검증 실패' }
    $taskEnvHash = (Get-FileHash -LiteralPath $env:SYSTEM0_ENV_FILE).Hash
    $taskDbHash = (Get-FileHash -LiteralPath (Join-Path $taskData 'system0.sqlite')).Hash
    $taskUpdatedFile = Join-Path $taskApp 'public\app.js'
    Add-Content -LiteralPath $taskUpdatedFile -Value '// installer update check'
    $taskMarkedHash = (Get-FileHash -LiteralPath $taskUpdatedFile).Hash

    $taskStopFile = Join-Path $taskCheck 'stop'
    $taskHold = Start-Process -FilePath $taskNode -ArgumentList @(('"' + $taskScript + '"'), 'hold', ('"' + $taskApp + '"'), ('"' + $taskData + '"'), ('"' + $taskStopFile + '"')) -WindowStyle Hidden -PassThru
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not (Test-Path -LiteralPath ($taskStopFile + '.ready')) -and [DateTime]::UtcNow -lt $taskDeadline) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path -LiteralPath ($taskStopFile + '.ready'))) { throw '실행 중 업데이트 차단 검증 준비 실패' }
    if ((Run-Setup) -eq 0) { throw '실행 중 업데이트가 차단되지 않았습니다.' }
    if ((Get-FileHash -LiteralPath $taskUpdatedFile).Hash -ne $taskMarkedHash) { throw '실행 중 프로그램 파일이 교체되었습니다.' }
    New-Item -ItemType File -Path $taskStopFile -Force | Out-Null
    if (-not $taskHold.WaitForExit(10000)) { throw '검증 서버 종료 실패' }
    $taskHold = $null

    if ((Run-Setup) -ne 0) { throw '재설치 실패' }
    if ((Get-FileHash -LiteralPath $env:SYSTEM0_ENV_FILE).Hash -ne $taskEnvHash) { throw '재설치가 API 설정을 변경했습니다.' }
    if ((Get-FileHash -LiteralPath (Join-Path $taskData 'system0.sqlite')).Hash -ne $taskDbHash) { throw '재설치가 운영 DB를 변경했습니다.' }
    if ((Get-FileHash -LiteralPath $taskUpdatedFile).Hash -ne (Get-FileHash -LiteralPath (Join-Path $taskRoot 'public\app.js')).Hash) { throw '프로그램 파일 업데이트 실패' }
    & $taskNode $taskScript verify $taskApp $taskData
    if ($LASTEXITCODE -ne 0) { throw '재설치 후 작업 데이터 복원 확인 실패' }
    & $taskNode $taskScript browser $taskApp $taskData
    if ($LASTEXITCODE -ne 0) { throw '기본 브라우저 실행 실패' }
    $taskUninstall = Start-Process -FilePath (Join-Path $taskApp 'unins000.exe') -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -WindowStyle Hidden -Wait -PassThru
    if ($taskUninstall.ExitCode -ne 0) { throw '격리 설치 정리 실패' }
    $taskInstalled = $false
    if (-not (Test-Path -LiteralPath $env:SYSTEM0_ENV_FILE) -or -not (Test-Path -LiteralPath (Join-Path $taskData 'system0.sqlite'))) { throw '제거 과정이 운영 데이터를 삭제했습니다.' }
    Write-Output '설치 검증 통과: Node 별도 설치 없이 실행, 주문·다운로드, 실행 중 업데이트 차단, 재설치·제거 시 설정과 DB 보존'
}
finally {
    if ($taskHold -and -not $taskHold.HasExited) {
        New-Item -ItemType File -Path (Join-Path $taskCheck 'stop') -Force | Out-Null
        if (-not $taskHold.WaitForExit(10000)) { Stop-Process -Id $taskHold.Id -Force }
    }
    if ($taskInstalled -and (Test-Path -LiteralPath (Join-Path $taskApp 'unins000.exe'))) {
        Start-Process -FilePath (Join-Path $taskApp 'unins000.exe') -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -WindowStyle Hidden -Wait | Out-Null
    }
    foreach ($taskName in $taskSavedEnv.Keys) { [Environment]::SetEnvironmentVariable($taskName, $taskSavedEnv[$taskName], 'Process') }
    $taskResolved = [System.IO.Path]::GetFullPath($taskCheck)
    $taskAllowed = [System.IO.Path]::GetFullPath((Join-Path $taskRoot '.work')) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $taskResolved.StartsWith($taskAllowed, [System.StringComparison]::OrdinalIgnoreCase)) { throw '검증 폴더 경로 확인 실패' }
    if (Test-Path -LiteralPath $taskResolved) { Remove-Item -LiteralPath $taskResolved -Recurse -Force }
}
