param(
    [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'system0/discord.env'),
    [string]$ServerId,
    [string]$ChannelIds,
    [string]$StaffIds
)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $ConfigPath) { throw '설정 파일이 이미 있습니다. 기존 설정을 확인하거나 -ConfigPath로 다른 파일을 지정해 주세요.' }
function Read-Secret([string]$Label) {
    $secureValue = Read-Host $Label -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secureValue.Dispose() }
}
function Read-Ids([string]$Label) {
    $value = (Read-Host $Label).Trim()
    if ($value -notmatch '^\d{17,20}(\s*,\s*\d{17,20})*$') { throw '이름 대신 개발자 모드에서 복사한 숫자 ID를 입력해 주세요.' }
    $value -replace '\s', ''
}
$guildId = if ($ServerId) { $ServerId } else { Read-Ids '디스코드 서버 ID' }
if (-not $ChannelIds) { $ChannelIds = Read-Ids '허용할 텍스트 채널 ID (여러 개는 쉼표)' }
$userIds = if ($StaffIds) { $StaffIds } else { Read-Ids '사용할 직원 ID (여러 명은 쉼표)' }
if ($guildId -notmatch '^\d{17,20}$' -or $ChannelIds -notmatch '^\d{17,20}(,\d{17,20})*$' -or $userIds -notmatch '^\d{17,20}(,\d{17,20})*$') { throw '서버·채널·사용자 숫자 ID를 확인해 주세요.' }
$token = Read-Secret '봇 토큰 (화면에 표시되지 않음)'
if ($token -notmatch '^[A-Za-z0-9._-]+$') { throw '봇 토큰을 확인해 주세요.' }
$password = Read-Secret '네이버 엑셀 암호 (없으면 Enter)'
if ($password.Contains("'") -or $password.Contains("`r") -or $password.Contains("`n")) { throw '파일 암호에 작은따옴표나 줄바꿈이 있으면 설정 파일에 직접 입력해 주세요.' }
$portText = Read-Host '로컬 system0 포트 (기본 3000)'
if (-not $portText) { $portText = '3000' }
$portNumber = 0
if (-not [int]::TryParse($portText, [ref]$portNumber) -or $portNumber -lt 1 -or $portNumber -gt 65535) { throw '올바른 포트를 입력해 주세요.' }
$secretBytes = New-Object byte[] 32
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $generator.GetBytes($secretBytes) } finally { $generator.Dispose() }
$secretValue = -join ($secretBytes | ForEach-Object { $_.ToString('x2') })
$content = "DISCORD_BOT_TOKEN=$token`nDISCORD_API_SECRET=$secretValue`nDISCORD_GUILD_ID=$guildId`nDISCORD_CHANNEL_IDS=$ChannelIds`nDISCORD_USER_IDS=$userIds`nDISCORD_API_BASE=http://127.0.0.1:$portNumber`nDISCORD_NAVER_FILE_PASSWORD='$password'`n"
$absolutePath = [IO.Path]::GetFullPath($ConfigPath)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($absolutePath)) | Out-Null
[IO.File]::WriteAllText($absolutePath, $content, (New-Object Text.UTF8Encoding($false)))
$acl = New-Object Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')))
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('SYSTEM', 'FullControl', 'Allow')))
Set-Acl -LiteralPath $absolutePath -AclObject $acl
$token = $null; $password = $null; $content = $null; $secretValue = $null
Write-Host '비공개 설정을 저장했습니다. system0 서버를 재시작한 뒤 npm.cmd run discord:start를 실행하세요.'
