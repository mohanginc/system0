param()
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskCheck = Join-Path $taskRoot ('.work\patch-check-' + [Guid]::NewGuid().ToString('N'))
$taskLocal = Join-Path ([System.IO.Path]::GetTempPath()) ('system0-patch-' + [Guid]::NewGuid().ToString('N') + '-격리 데이터 폴더')
$taskApp = Join-Path $taskLocal 'Programs\system0'
$taskData = Join-Path $taskLocal 'system0'
$taskPatch = Join-Path $taskCheck '패치 폴더\system0 patch.cmd'
$taskModules = Join-Path $taskApp 'node_modules'
$taskLinks = @()
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
        if (-not $process.WaitForExit(30000)) { $process.Kill(); throw '패치 실행 시간 초과' }
        return @{ Code = $process.ExitCode; Message = $output.Result + $errors.Result }
    } finally { $process.Dispose() }
}
function Assert-Hash($File, $Expected, $Message) {
    if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -ne $Expected) { throw ($Message + ': ' + $File) }
}
function Assert-Payload {
    foreach ($file in $taskExpected.Keys) { Assert-Hash (Join-Path $taskApp $file) $taskExpected[$file] '패치 파일 불일치' }
    if (Get-ChildItem -LiteralPath $taskApp -Directory -Force | Where-Object { $_.Name -like '.patch-*' }) {
        throw '패치 임시 폴더가 남았습니다.'
    }
}
function Assert-Preserved {
    Assert-Hash $taskEnv $taskEnvHash '패치가 설정을 변경했습니다.'
    Assert-Hash $taskDb $taskDbHash '패치가 DB를 변경했습니다.'
    foreach ($file in $taskExcluded.Keys) { Assert-Hash (Join-Path $taskApp $file) $taskExcluded[$file] '패치 제외 파일이 변경되었습니다.' }
}

[System.IO.Directory]::CreateDirectory((Join-Path $taskApp 'runtime')) | Out-Null
[System.IO.Directory]::CreateDirectory((Join-Path $taskApp 'public')) | Out-Null
[System.IO.Directory]::CreateDirectory((Join-Path $taskApp 'lib')) | Out-Null
[System.IO.Directory]::CreateDirectory((Join-Path $taskApp 'prompts')) | Out-Null
[System.IO.Directory]::CreateDirectory($taskModules) | Out-Null
[System.IO.Directory]::CreateDirectory($taskData) | Out-Null
try {
    & (Join-Path $taskRoot 'installer\build-patch.ps1') -OutputFile $taskPatch
    $taskBcryptFiles = @('node_modules\bcryptjs\index.js', 'node_modules\bcryptjs\package.json', 'node_modules\bcryptjs\LICENSE')
    $taskCryptoPackages = @('officecrypto-tool', 'cfb', 'adler-32', 'crc-32', 'crypto-js', 'xml2js', 'sax', 'xmlbuilder')
    $taskCryptoFiles = @()
    foreach ($taskPackageName in $taskCryptoPackages) {
        $taskPackageRoot = Join-Path $taskRoot ('node_modules\' + $taskPackageName)
        $taskRuntimePattern = switch ($taskPackageName) {
            'officecrypto-tool' { '^(index\.js|src/.+\.js)$' }
            'cfb' { '^cfb\.js$' }
            'adler-32' { '^adler32\.js$' }
            'crc-32' { '^crc32\.js$' }
            'crypto-js' { '^(?!crypto-js\.js$)[^/]+\.js$' }
            'xml2js' { '^lib/(?!xml2js\.bc\.js$).+\.js$' }
            default { '^lib/.+\.js$' }
        }
        $taskCryptoFiles += Get-ChildItem -LiteralPath $taskPackageRoot -Recurse -File | Where-Object {
            $relative = $_.FullName.Substring($taskPackageRoot.Length + 1).Replace('\', '/')
            $relative -match '^(package\.json|LICENSE(?:\.md)?)$' -or $relative -match $taskRuntimePattern
        } | ForEach-Object { $_.FullName.Substring($taskRoot.Length + 1) }
    }
    $taskFiles = @('server.mjs', 'lib\database.mjs', 'lib\naming.mjs', 'lib\llm.mjs', 'lib\shipping.mjs',
        'lib\naver.mjs', 'lib\shipping-preview.mjs', 'lib\invoices.mjs', 'prompts\product-names.md') + $taskBcryptFiles + $taskCryptoFiles
    $taskFiles += Get-ChildItem -LiteralPath (Join-Path $taskRoot 'public') -Recurse -File |
        Where-Object { $_.Extension -in @('.html', '.css', '.js', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico') } |
        ForEach-Object { $_.FullName.Substring($taskRoot.Length + 1) }
    $taskExpected = @{}
    foreach ($file in $taskFiles) { $taskExpected[$file] = (Get-FileHash -LiteralPath (Join-Path $taskRoot $file)).Hash }
    $taskBatchBytes = [System.IO.File]::ReadAllBytes($taskPatch)
    $taskBatchText = [System.Text.Encoding]::UTF8.GetString($taskBatchBytes)
    if ($taskBatchText -match '[^\x00-\x7F]') { throw '패치 CMD는 ASCII여야 합니다.' }
    if ($taskBatchText -match '(?<!\r)\n') { throw '패치 CMD는 CRLF여야 합니다.' }
    $taskSections = $taskBatchText -split '(?m)^:SYSTEM0_PAYLOAD\r?$', 2
    if ($taskSections.Count -ne 2) { throw '패치 payload를 찾을 수 없습니다.' }
    $taskScript = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($taskSections[1].Trim()))
    $taskMatch = [regex]::Match($taskScript, "FromBase64String\('([A-Za-z0-9+/=]+)'\)")
    if (-not $taskMatch.Success) { throw '패치 파일 목록을 찾을 수 없습니다.' }
    $taskPayload = @([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($taskMatch.Groups[1].Value)) | ConvertFrom-Json)
    $taskPaths = @($taskFiles | ForEach-Object { $_.Replace('\', '/') } | Sort-Object)
    if (@(Compare-Object $taskPaths @($taskPayload.path | Sort-Object)).Count) { throw '패치 payload 파일 목록 불일치' }
    Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $taskApp 'runtime\node.exe')
    Copy-Item -LiteralPath (Join-Path $taskRoot 'installer\launch.mjs') -Destination (Join-Path $taskApp 'launch.mjs')
    Copy-Item -LiteralPath (Join-Path $taskRoot 'installer\start.cmd') -Destination (Join-Path $taskApp 'start.cmd')
    Copy-Item -LiteralPath (Join-Path $taskRoot 'lib\excel.mjs') -Destination (Join-Path $taskApp 'lib\excel.mjs')
    $taskPackage = '{"name":"system0","version":"0.1.4","type":"module"}'
    [System.IO.File]::WriteAllText((Join-Path $taskApp 'package.json'), $taskPackage)
    foreach ($file in @('server.mjs', 'lib\database.mjs', 'lib\naming.mjs', 'prompts\product-names.md', 'public\app.js', 'public\index.html', 'public\styles.css')) {
        [System.IO.File]::WriteAllText((Join-Path $taskApp $file), '// previous installed file')
    }
    if (Test-Path -LiteralPath (Join-Path $taskApp 'lib\llm.mjs')) { throw '새 파일 생성 fixture 준비 실패' }
    if (Test-Path -LiteralPath (Join-Path $taskModules 'bcryptjs')) { throw 'bcryptjs는 패치 전에 존재하면 안 됩니다.' }
    foreach ($taskPackageName in $taskCryptoPackages) {
        if (Test-Path -LiteralPath (Join-Path $taskModules $taskPackageName)) { throw '암호화 의존성은 패치 전에 존재하면 안 됩니다.' }
    }
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
import * as XLSX from 'xlsx';
const [app,data,ready,stop,running] = process.argv.slice(2);
const workbook = XLSX.utils.book_new();
const raw = [['상품명','옵션명','수량'],['면20수 상품','면100수 새싹',1],['면20수 상품','면100수 새싹',2]];
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(raw), '주문');
const original = XLSX.write(workbook,{type:'buffer',bookType:'xlsx'});
const db = new DatabaseSync(path.join(data, 'system0.sqlite'));
db.exec("CREATE TABLE batches (id INTEGER PRIMARY KEY,name TEXT NOT NULL,file_count INTEGER NOT NULL,row_count INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));" +
  "CREATE TABLE sheets (id INTEGER PRIMARY KEY,batch_id INTEGER NOT NULL,source_file TEXT NOT NULL,source_sheet TEXT NOT NULL,raw_json TEXT NOT NULL,header_index INTEGER NOT NULL,file_id INTEGER);" +
  "CREATE TABLE source_files (id INTEGER PRIMARY KEY,batch_id INTEGER NOT NULL,name TEXT NOT NULL,content BLOB NOT NULL);" +
  "CREATE TABLE rows (id INTEGER PRIMARY KEY,batch_id INTEGER NOT NULL,sheet_id INTEGER NOT NULL,source_row INTEGER NOT NULL,original_name TEXT NOT NULL,product_name TEXT NOT NULL,option_name TEXT NOT NULL,generated_name TEXT NOT NULL DEFAULT '',cleaned_name TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',review_note TEXT NOT NULL DEFAULT '');" +
  "CREATE TABLE row_revisions (id INTEGER PRIMARY KEY,row_id INTEGER NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));" +
  "INSERT INTO batches VALUES (1,'기존 직원 검수 작업',1,2,'2000-01-01T00:00:00.000Z');" +
  "INSERT INTO rows VALUES (1,1,1,2,'면20수 상품','면20수 상품','면100수 새싹','이전 AI명','기존 직원 검수명','confirmed','직원 소재 확인');" +
  "INSERT INTO rows VALUES (2,1,1,3,'면20수 상품','면20수 상품','면100수 새싹','이전 AI명','기존 직원 검수명','confirmed','직원 소재 확인');");
db.prepare('INSERT INTO source_files VALUES (1,1,?,?)').run('기존 주문.xlsx', original);
db.prepare('INSERT INTO sheets VALUES (1,1,?,?,?,?,1)').run('기존 주문.xlsx','주문',JSON.stringify(raw),0);
db.prepare('INSERT INTO row_revisions VALUES (1,1,?,?,?)').run(
  JSON.stringify({cleanedName:'이전 AI명',status:'review',reviewNote:''}),
  JSON.stringify({cleanedName:'기존 직원 검수명',status:'confirmed',reviewNote:'직원 소재 확인'}),
  '2001-01-01T00:00:00.000Z');
db.close();
const server = createServer((_request,response) => response.end(JSON.stringify({
  app: existsSync(running) ? 'system0' : 'fixture-other-service', instance: app
})));
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
writeFileSync(path.join(data,'.env'), ['OPENAI_API_KEY=sk-proj-patch-fixture','PORT='+server.address().port,''].join('\n'));
writeFileSync(ready, JSON.stringify({port:server.address().port}));
try {
  const deadline = Date.now() + 180000;
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
    $taskExcluded = @{}
    foreach ($file in @('launch.mjs','start.cmd','runtime\node.exe','package.json','lib\excel.mjs')) {
        $taskExcluded[$file] = (Get-FileHash -LiteralPath (Join-Path $taskApp $file)).Hash
    }
    foreach ($taskCodePage in @(949,65001)) {
        [System.IO.File]::WriteAllText((Join-Path $taskApp 'public\app.js'), '// previous file CP' + $taskCodePage)
        $result = Run-Patch $taskCodePage
        if ($result.Code -ne 0) { throw ('패치 적용 실패: ' + $result.Message) }
        Assert-Payload
        Assert-Preserved
    }
    if ((Run-Patch).Code -ne 0) { throw '동일 패치 재실행 실패' }
    Assert-Payload
    Assert-Preserved
    Write-Output 'CMD 적용 통과: CP949/65001, 한글·공백 경로, 신규·기존 파일, 재실행, DB·설정·런타임 보존'

    [System.IO.File]::WriteAllText((Join-Path $taskApp 'lib\database.mjs'), '// rollback database marker')
    Remove-Item -LiteralPath (Join-Path $taskApp 'lib\llm.mjs') -Force
    foreach ($file in @($taskBcryptFiles + $taskCryptoFiles + 'lib\invoices.mjs')) { Remove-Item -LiteralPath (Join-Path $taskApp $file) -Force }
    $taskBefore = @{}
    foreach ($file in $taskExpected.Keys) {
        $target = Join-Path $taskApp $file
        $taskBefore[$file] = if (Test-Path -LiteralPath $target -PathType Leaf) { (Get-FileHash -LiteralPath $target).Hash } else { $null }
    }
    $taskLock = [System.IO.File]::Open((Join-Path $taskApp 'public\app.js'), [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try { $result = Run-Patch } finally { $taskLock.Dispose() }
    if ($result.Code -eq 0) { throw '파일 잠금 중 교체 실패가 감지되지 않았습니다.' }
    foreach ($file in $taskBefore.Keys) {
        $target = Join-Path $taskApp $file
        if ($null -eq $taskBefore[$file]) {
            if (Test-Path -LiteralPath $target) { throw ('롤백 후 새 파일이 남았습니다: ' + $file) }
        } else { Assert-Hash $target $taskBefore[$file] '중간 실패 후 기존 파일 복구 실패' }
    }
    Assert-Preserved
    if (Get-ChildItem -LiteralPath $taskApp -Directory -Force | Where-Object { $_.Name -like '.patch-*' }) { throw '롤백 후 임시 폴더가 남았습니다.' }
    if ((Run-Patch).Code -ne 0) { throw '롤백 후 정상 패치 재시도 실패' }
    Assert-Payload
    Write-Output '중간 교체 실패 통과: 기존 파일 역순 복구, 신규 파일 제거, 재시도'

    [System.IO.File]::WriteAllText((Join-Path $taskApp 'public\app.js'), '// running app must not change')
    $taskBlockedHash = (Get-FileHash -LiteralPath (Join-Path $taskApp 'public\app.js')).Hash
    [System.IO.File]::WriteAllText($taskRunning, 'running')
    if ((Run-Patch).Code -eq 0) { throw '실행 중 패치가 차단되지 않았습니다.' }
    Assert-Hash (Join-Path $taskApp 'public\app.js') $taskBlockedHash '실행 중 파일이 교체되었습니다.'
    Remove-Item -LiteralPath $taskRunning -Force
    [System.IO.File]::WriteAllText((Join-Path $taskApp 'package.json'), '{"name":"system0","version":"0.1.5"}')
    if ((Run-Patch).Code -eq 0) { throw '지원하지 않는 버전이 허용되었습니다.' }
    Remove-Item -LiteralPath (Join-Path $taskApp 'package.json') -Force
    if ((Run-Patch).Code -eq 0) { throw '설치 없는 경로에서 패치가 적용되었습니다.' }
    Assert-Hash (Join-Path $taskApp 'public\app.js') $taskBlockedHash '실패 요청이 화면 파일을 변경했습니다.'
    Assert-Hash $taskEnv $taskEnvHash '실패 요청이 설정을 변경했습니다.'
    Assert-Hash $taskDb $taskDbHash '실패 요청이 DB를 변경했습니다.'
    [System.IO.File]::WriteAllText((Join-Path $taskApp 'package.json'), $taskPackage)
    if ((Run-Patch).Code -ne 0) { throw '차단 검증 후 정상 패치 실패' }
    Assert-Payload
    Assert-Preserved
    Write-Output '차단 검증 통과: 실행 중, 미설치, 다른 버전'
    [System.IO.File]::WriteAllText($taskStop, 'stop')
    if (-not $taskHold.WaitForExit(10000)) { throw '격리 상태 확인 서버 종료 실패' }

    if ((Get-Item -LiteralPath $taskModules -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw '검증용 node_modules는 일반 폴더여야 합니다.'
    }
    foreach ($dependency in Get-ChildItem -LiteralPath (Join-Path $taskRoot 'node_modules') -Directory -Force) {
        if ($dependency.Name -in (@('bcryptjs', '.bin') + $taskCryptoPackages)) { continue }
        $link = Join-Path $taskModules $dependency.Name
        New-Item -ItemType Junction -Path $link -Target $dependency.FullName | Out-Null
        $taskLinks += $link
    }
    $taskApiCheck = Join-Path $taskApp 'patched-api-check.mjs'
    @'
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readdirSync, realpathSync, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as XLSX from 'xlsx';
import { hashSync, compareSync } from 'bcryptjs';
import officeCrypto from 'officecrypto-tool';
const [installed,data] = process.argv.slice(2);
const bcryptRoot = path.join(installed,'node_modules','bcryptjs');
assert.deepEqual(readdirSync(bcryptRoot).sort(),['LICENSE','index.js','package.json'].sort());
assert.equal(realpathSync(fileURLToPath(import.meta.resolve('bcryptjs'))),realpathSync(path.join(bcryptRoot,'index.js')));
const hash = hashSync('isolated-patch-fixture','$2b$04$abcdefghijklmnopqrstuu');
assert.ok(compareSync('isolated-patch-fixture',hash));
assert.equal(compareSync('different',hash),false);
const cryptoPackages = ['officecrypto-tool','cfb','adler-32','crc-32','crypto-js','xml2js','sax','xmlbuilder'];
const installedRequire = createRequire(import.meta.url);
for (const name of cryptoPackages) {
  const root = path.join(installed,'node_modules',name);
  assert.equal(lstatSync(root).isSymbolicLink(),false,name+' must be actual patched files');
  assert.ok(realpathSync(installedRequire.resolve(name)).startsWith(realpathSync(root)+path.sep),name+' resolves inside patched installation');
  const requireFromPackage = createRequire(path.join(root,'package.json'));
  const info = requireFromPackage('./package.json');
  for (const dependency of Object.keys(info.dependencies || {})) {
    assert.ok(cryptoPackages.includes(dependency));
    assert.ok(realpathSync(requireFromPackage.resolve(dependency)).startsWith(realpathSync(path.join(installed,'node_modules',dependency))+path.sep));
  }
}
process.env.SYSTEM0_ENV_FILE = path.join(data,'.env');
const {createApp} = await import(pathToFileURL(path.join(installed,'server.mjs')).href);
const {namingVersion} = await import(pathToFileURL(path.join(installed,'lib/naming.mjs')).href);
let requests = 0, previewRequests = 0, naverReads = 0;
const app = createApp({databasePath:path.join(data,'system0.sqlite'),model:'fixture-model',
  naver:{listNewOrders:async()=>({from:'2026-10-10T01:00:00.000Z',to:'2026-10-17T01:00:00.000Z',
    orders:++naverReads === 1 ? [
      {productOrderId:'202610170000000011',orderId:'202610170000000001',originalName:'미리보기 전용 상품',
        productName:'미리보기 전용 상품',optionName:'옵션 A',quantity:3,recipient:'모의 신규 수취인',phone:'010-1111-2222',
        address:'서울 강남구 테헤란로 123 (역삼동, 비공개빌딩) 101호'},
      {productOrderId:'202610170000000012',orderId:'202610170000000001',originalName:'미리보기 전용 상품',
        productName:'미리보기 전용 상품',optionName:'옵션 B',quantity:2,recipient:'모의 신규 수취인',phone:'010-1111-2222',
        address:'서울 강남구 테헤란로 123 (역삼동, 비공개빌딩) 101호'},
    ]:[]}),queryProductOrders:async ids=>ids.map(productOrderId=>({productOrderId,orderId:'202610220000000099',
      status:'DELIVERING',remainQuantity:1,trackingNumber:'001234567890',deliveryCompanyCode:'KGB',
      recipient:'송장 모의 수취인',phone:'010-0000-0000',address:'서울 강남구 테스트로 1',detailAddress:'101호',
      claimStatus:'',isWrongTrackingNumber:false,deliveryStatus:'DELIVERING',deliveryMethod:'DELIVERY'}))},
  client:{responses:{create:async request => {
    const input = JSON.parse(request.input);
    if (input.every(row=>row.originalName === '미리보기 전용 상품')) {
      previewRequests++;
      assert.equal(input.length,2);
      for (const row of input) assert.deepEqual(Object.keys(row),['id','originalName','productName','optionName']);
      for (const value of ['모의 신규 수취인','010-1111-2222','테헤란로','비공개빌딩','101호','202610170000000001']) {
        assert.ok(!request.input.includes(value));
      }
      return {usage:{total_tokens:30},output_text:JSON.stringify({items:input.map(row=>({id:row.id,
        cleanedName:'미리보기 정리 '+row.optionName,needsAttention:row.optionName === '옵션 B',
        note:row.optionName === '옵션 B' ? '선택 소재 확인 필요' : ''}))})};
    }
    requests++;
    assert.equal(input.length,1);
    assert.equal(input[0].previousName,'기존 직원 검수명');
    assert.equal(input[0].previousReviewNote,'직원 소재 확인');
    assert.ok(request.instructions.includes('속통'));
    return {usage:{total_tokens:25},output_text:JSON.stringify({items:input.map(row=>({
      id:row.id,cleanedName:'새 지침 모의 명칭',needsAttention:false,note:''}))})};
  }}}});
const db = app.locals.db;
const originalRows = db.prepare('SELECT * FROM rows WHERE batch_id = 1 ORDER BY id').all();
const revisions = db.prepare('SELECT * FROM row_revisions ORDER BY id').all();
const original = Buffer.from(db.prepare('SELECT content FROM source_files WHERE id = 1').get().content);
assert.ok(originalRows.every(row=>row.naming_version === ''));
const server = await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
const base = 'http://127.0.0.1:'+server.address().port;
const json = body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
try {
  const upload = async()=>{
    const form = new FormData(); form.append('files',new Blob([original]),'새 주문.xlsx');
    const response = await fetch(base+'/api/import',{method:'POST',body:form});
    assert.equal(response.status,201); return response.json();
  };
  const first = await upload();
  const response = await fetch(base+'/api/batches/'+first.batch.id+'/normalize',json({}));
  assert.equal(response.status,200);
  const generated = await response.json();
  assert.ok(generated.rows.every(row=>row.nameSource === 'ai' && row.namingVersion === namingVersion));
  assert.equal(generated.rows.length,2); assert.equal(requests,1);
  assert.deepEqual(db.prepare('SELECT * FROM rows WHERE batch_id = 1 ORDER BY id').all(),originalRows);
  assert.deepEqual(db.prepare('SELECT * FROM row_revisions ORDER BY id').all(),revisions);
  assert.ok(Buffer.from(db.prepare('SELECT content FROM source_files WHERE id = 1').get().content).equals(original));
  const next = await upload();
  const reused = await (await fetch(base+'/api/batches/'+next.batch.id+'/normalize',json({}))).json();
  assert.ok(reused.rows.every(row=>row.nameSource === 'reused' && row.namingVersion === namingVersion));
  assert.equal(requests,1);
  const exported = await fetch(base+'/api/batches/'+next.batch.id+'/export');
  assert.equal(exported.status,200);
  const workbook = XLSX.read(Buffer.from(await exported.arrayBuffer()),{type:'buffer'});
  assert.deepEqual(XLSX.utils.sheet_to_json(workbook.Sheets['주문'],{header:1,raw:true}),
    [['상품명','옵션명','수량'],['새 지침 모의 명칭','면100수 새싹',1],['새 지침 모의 명칭','면100수 새싹',2]]);
  for (const resource of ['/','/app.js','/intro.js','/intro.css','/assets/babestellar-logo.png','/assets/intro-night-sky.png',
    '/llm-usage.html','/llm-usage.js','/llm-usage.css','/shipping-board.html','/shipping-board.js','/shipping-board.css',
    '/invoices.html','/invoices.js','/invoices.css']) {
    const result = await fetch(base+resource); assert.equal(result.status,200,resource);
    assert.ok((await result.arrayBuffer()).byteLength > 0);
  }
  const purposes = await (await fetch(base+'/api/llm/purposes')).json();
  assert.equal(purposes.purposes[0].code,'product_names');
  const date = new Date(Date.now()+9*60*60*1000).toISOString().slice(0,10);
  const shipping = await fetch(base+'/api/shipping/board?date='+date);
  assert.equal(shipping.status,200);
  const board = await shipping.json();
  assert.equal(board.summary.bundleCount,4);
  assert.equal(board.groups.length,1);
  assert.equal(board.groups[0].name,'새 지침 모의 명칭');
  assert.equal(board.groups[0].count,4);
  assert.equal(board.invoiceState,'unavailable');
  const shippingDates = await fetch(base+'/api/shipping/dates?month='+date.slice(0,7));
  assert.equal(shippingDates.status,200);
  assert.ok((await shippingDates.json()).days.some(day=>day.date === date && day.batchCount === 2));
  const usage = await (await fetch(base+'/api/llm/usage?from='+date+'&to='+date)).json();
  assert.deepEqual(usage.totals,{calls:1,succeeded:1,failed:0,running:0});
  assert.equal(requests,1);
  assert.ok(purposes.purposes.some(purpose=>purpose.code === 'product_names_preview' && purpose.active));
  const orderSnapshot = ()=>Object.fromEntries(['batches','sheets','source_files','rows','row_revisions']
    .map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY id').all()]));
  const beforePreview = orderSnapshot();
  const previewResponse = await fetch(base+'/api/shipping/preview',{method:'POST'});
  assert.equal(previewResponse.status,200);
  assert.equal(previewResponse.headers.get('cache-control'),'no-store');
  const preview = await previewResponse.json();
  assert.equal(preview.mode,'new');
  assert.deepEqual(preview.summary,{orderCount:1,rowCount:2,quantity:5,groupCount:2,attentionQuantity:2});
  assert.deepEqual(preview.groups.map(group=>[group.name,group.count]),
    [['미리보기 정리 옵션 A',3],['미리보기 정리 옵션 B',2]]);
  assert.deepEqual(preview.groups.flatMap(group=>group.shipments.map(row=>row.id)),
    ['202610170000000011','202610170000000012']);
  assert.ok(preview.groups.flatMap(group=>group.shipments).every(row=>row.orderId === '202610170000000001'
    && row.recipient === '모의 신규 수취인' && row.phone === '010-1111-2222' && row.neighborhood === '서울 강남구 역삼동'));
  assert.equal(preview.groups[1].shipments[0].note,'선택 소재 확인 필요');
  for (const value of ['테헤란로','123','비공개빌딩','101호','originalName','address']) assert.ok(!JSON.stringify(preview).includes(value));
  assert.equal(previewRequests,1);
  assert.equal(requests,1);
  assert.deepEqual(orderSnapshot(),beforePreview);
  const previewCall = db.prepare('SELECT * FROM llm_calls WHERE purpose_code = ?').all('product_names_preview');
  assert.equal(previewCall.length,1);
  assert.equal(previewCall[0].batch_id,null);
  assert.equal(previewCall[0].item_count,2);
  assert.equal(previewCall[0].status,'succeeded');
  assert.ok(!JSON.stringify(previewCall).includes('모의 신규 수취인'));
  const emptyResponse = await fetch(base+'/api/shipping/preview',{method:'POST'});
  assert.equal(emptyResponse.status,200);
  const empty = await emptyResponse.json();
  assert.deepEqual(empty.groups,[]);
  assert.deepEqual(empty.summary,{orderCount:0,rowCount:0,quantity:0,groupCount:0,attentionQuantity:0});
  assert.equal(naverReads,2); assert.equal(previewRequests,1);
  assert.deepEqual(orderSnapshot(),beforePreview);
  const finalUsage = await (await fetch(base+'/api/llm/usage?from='+date+'&to='+date)).json();
  assert.deepEqual(finalUsage.totals,{calls:2,succeeded:2,failed:0,running:0});
  const excel = rows=>{
    const workbook=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet(rows),'주문');
    return XLSX.write(workbook,{type:'buffer',bookType:'xlsx'});
  };
  const invoiceSource=excel([['원상품명','주문번호','체결번호','송화주','전화번호','주소','수량','쇼핑몰'],
    ['송장 테스트 쿠션','000001','202610220000000099','송장 모의 수취인','010-0000-0000','서울 강남구 테스트로 1 101호',1,'네이버'],
    ['번호 없는 출고','','','송장 미매칭 수취인','010-0000-0000','서울 강남구 테스트로 1 101호',1,'네이버']]);
  const sourceForm=new FormData(); sourceForm.append('files',new Blob([invoiceSource]),'확인한 주문.xlsx');
  const sourceResponse=await fetch(base+'/api/import',{method:'POST',body:sourceForm}); assert.equal(sourceResponse.status,201);
  const source=await sourceResponse.json();
  const sourceBeforeInvoice=orderSnapshot();
  const invoiceNaver=excel([['상품주문번호','주문번호','상품명','수량','수취인명','수취인연락처1','통합배송지','주문상태'],
    ['202610220000000021','202610220000000099','송장 테스트 쿠션',1,'송장 모의 수취인','010-0000-0000','서울 강남구 테스트로 1 101호','PAYED']]);
  const fixturePassword='isolated-file-password';
  const encrypted=officeCrypto.encrypt(invoiceNaver,{password:fixturePassword});
  const courier=excel([['운송장번호','주문번호','차수','물품명'],
    ['001234567890','000001',1,'송장 테스트 쿠션'],['009999999999','',1,'송장에만 있는 행']]);
  const invoiceForm=entered=>{
    const form=new FormData(); form.append('naverFiles',new Blob([encrypted]),'암호 주문.xlsx');
    form.append('courierFiles',new Blob([courier]),'택배사.xlsx');form.append('deliveryCompanyCode','KGB');
    form.append('batchIds',JSON.stringify([source.batch.id]));form.append('naverPassword',entered);return form;
  };
  assert.equal((await fetch(base+'/api/invoices/import',{method:'POST',body:invoiceForm('wrong-fixture-password')})).status,400);
  const matchedResponse=await fetch(base+'/api/invoices/import',{method:'POST',body:invoiceForm(fixturePassword)});
  assert.equal(matchedResponse.status,201);const matched=await matchedResponse.json();
  assert.equal(matched.orders.length,2);assert.equal(matched.items.length,1);assert.equal(matched.unmatchedCouriers.length,1);
  assert.ok(!JSON.stringify(matched).includes(fixturePassword));
  assert.ok(Buffer.from(db.prepare("SELECT content FROM invoice_files WHERE run_id=? AND kind='naver'").get(matched.run.id).content).equals(encrypted));
  const required=matched.issues.filter(issue=>issue.reviewRequired);assert.ok(required.length);
  assert.ok(matched.issues.some(issue=>!issue.reviewRequired));
  const review=await fetch(base+'/api/invoices/'+matched.run.id+'/items',{method:'PATCH',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({issueResolutions:required.map(issue=>({key:issue.key}))})});
  assert.equal(review.status,200);const reviewed=await review.json();assert.equal(reviewed.summary.issues,0);
  assert.ok(reviewed.issues.filter(issue=>!issue.reviewRequired).every(issue=>!issue.resolved && issue.note===''));
  const invoiceExport=await fetch(base+'/api/invoices/'+matched.run.id+'/export');assert.equal(invoiceExport.status,200);
  const generatedBytes=Buffer.from(await invoiceExport.arrayBuffer());const dispatch=XLSX.read(generatedBytes,{type:'buffer'});
  assert.deepEqual(XLSX.utils.sheet_to_json(dispatch.Sheets['발송처리'],{header:1,raw:true}),
    [['상품주문번호','배송방법','택배사','송장번호'],['202610220000000021','택배,등기,소포','로젠택배','001234567890']]);
  const checked=await fetch(base+'/api/invoices/'+matched.run.id+'/check',{method:'POST'});assert.equal(checked.status,200);
  assert.equal((await checked.json()).items[0].registrationState,'complete');
  assert.equal((await fetch(base+'/api/invoices/'+matched.run.id+'/export')).status,400);
  const copied=await fetch(base+'/api/invoices/'+matched.run.id+'/download');assert.equal(copied.status,200);
  assert.ok(Buffer.from(await copied.arrayBuffer()).equals(generatedBytes));
  const resumed=await (await fetch(base+'/api/invoices/latest?date='+date)).json();
  assert.equal(resumed.invoice.run.id,matched.run.id);assert.equal(resumed.invoice.run.savedFileAvailable,true);
  assert.deepEqual(orderSnapshot(),sourceBeforeInvoice);assert.equal(requests,1);assert.equal(previewRequests,1);
  console.log('Patched installation API passed: actual local bcrypt/Office crypto closure, legacy migration, prompt reuse, XLSX/pages/preview, encrypted invoice matching, checkbox-only review and exact saved-file download after mock registration.');
} finally { await new Promise(resolve=>server.close(resolve)); db.close(); }
'@ | Set-Content -LiteralPath $taskApiCheck -Encoding utf8
    & (Join-Path $taskApp 'runtime\node.exe') $taskApiCheck $taskApp $taskData
    if ($LASTEXITCODE -ne 0) { throw '패치 설치본 API 검증 실패' }
    Assert-Hash $taskEnv $taskEnvHash 'API 검증이 운영 설정 fixture를 변경했습니다.'
}
finally {
    if ($taskHold -and -not $taskHold.HasExited) {
        [System.IO.File]::WriteAllText((Join-Path $taskCheck 'stop'), 'stop')
        if (-not $taskHold.WaitForExit(10000)) { Stop-Process -Id $taskHold.Id -Force }
    }
    $taskModuleBoundary = [System.IO.Path]::GetFullPath($taskModules) + [System.IO.Path]::DirectorySeparatorChar
    foreach ($taskLink in $taskLinks) {
        if (-not [System.IO.Path]::GetFullPath($taskLink).StartsWith($taskModuleBoundary,[System.StringComparison]::OrdinalIgnoreCase) -or
            -not ((Get-Item -LiteralPath $taskLink -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw '검증 의존성 연결 경로 확인 실패'
        }
        try { Remove-Item -LiteralPath $taskLink -Force }
        catch { [System.IO.Directory]::Delete($taskLink) }
    }
    if (Test-Path -LiteralPath $taskModules) {
        if ((Get-Item -LiteralPath $taskModules -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint -or
            (Get-ChildItem -LiteralPath $taskModules -Recurse -Force | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint })) {
            throw '검증 의존성 연결이 남아 정리를 중단합니다.'
        }
    }
    $taskResolvedLocal = [System.IO.Path]::GetFullPath($taskLocal)
    $taskTempBoundary = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $taskResolvedLocal.StartsWith($taskTempBoundary, [System.StringComparison]::OrdinalIgnoreCase) -or
        [System.IO.Path]::GetFileName($taskResolvedLocal) -notmatch '^system0-patch-[a-f0-9]{32}-격리 데이터 폴더$') {
        throw '격리 설치 폴더 경로 확인 실패'
    }
    if (Test-Path -LiteralPath $taskResolvedLocal) { Remove-Item -LiteralPath $taskResolvedLocal -Recurse -Force }
    $taskResolved = [System.IO.Path]::GetFullPath($taskCheck)
    $taskAllowed = [System.IO.Path]::GetFullPath((Join-Path $taskRoot '.work')) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $taskResolved.StartsWith($taskAllowed, [System.StringComparison]::OrdinalIgnoreCase)) { throw '검증 폴더 경로 확인 실패' }
    if (Test-Path -LiteralPath $taskResolved) { Remove-Item -LiteralPath $taskResolved -Recurse -Force }
}
