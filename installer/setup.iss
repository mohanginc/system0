#ifndef PayloadDir
  #error PayloadDir is required
#endif
#ifndef AppVersion
  #define AppVersion "0.1.4"
#endif

[Setup]
AppId={{C8D8D708-2A19-4B03-9D1F-72B31A58CC28}
AppName=system0 주문 상품명 정리
AppVersion={#AppVersion}
AppPublisher=모행
DefaultDirName={localappdata}\Programs\system0
DefaultGroupName=system0
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputBaseFilename=system0-setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupLogging=no
CloseApplications=no
RestartApplications=no
UninstallDisplayIcon={app}\runtime\node.exe

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Tasks]
Name: "desktopicon"; Description: "바탕화면에 실행 바로가기 만들기"

[Icons]
Name: "{userdesktop}\system0 주문 상품명 정리"; Filename: "{app}\start.cmd"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{group}\주문 상품명 정리"; Filename: "{app}\start.cmd"; WorkingDir: "{app}"

[Run]
Filename: "{app}\start.cmd"; Description: "system0 실행"; Flags: shellexec postinstall skipifsilent nowait

[Code]
var
  KeyPage: TInputQueryWizardPage;

function DataDirectory: String;
begin
  { DATADIR is used by the isolated installation check. }
  Result := ExpandConstant('{param:DATADIR|{localappdata}\system0}');
end;

function EnvFilename: String;
begin
  Result := AddBackslash(DataDirectory) + '.env';
end;

function ValidKey(Value: String): Boolean;
var
  I: Integer;
begin
  Value := Trim(Value);
  Result := (Length(Value) > 10) and (Copy(Value, 1, 3) = 'sk-');
  if not Result then Exit;
  for I := 1 to Length(Value) do
    if not (((Value[I] >= 'a') and (Value[I] <= 'z')) or
      ((Value[I] >= 'A') and (Value[I] <= 'Z')) or
      ((Value[I] >= '0') and (Value[I] <= '9')) or
      (Value[I] = '-') or (Value[I] = '_')) then
    begin
      Result := False;
      Exit;
    end;
end;

procedure InitializeWizard;
begin
  KeyPage := CreateInputQueryPage(wpWelcome, 'OpenAI API 키 설정',
    '처음 설치할 때 한 번만 입력합니다.',
    'API 키는 이 컴퓨터에 저장합니다. 기존 설정과 작업 데이터는 재설치해도 유지됩니다.');
  KeyPage.Add('OpenAI API 키:', True);
  KeyPage.Values[0] := GetEnv('SYSTEM0_INSTALL_API_KEY');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = KeyPage.ID) and FileExists(EnvFilename);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = KeyPage.ID) and not ValidKey(KeyPage.Values[0]) then
  begin
    MsgBox('sk-로 시작하는 API 키를 입력해 주세요.', mbError, MB_OK);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
  NodeFile, LaunchFile: String;
begin
  Result := '';
  if not FileExists(EnvFilename) and not ValidKey(KeyPage.Values[0]) then
  begin
    Result := 'OpenAI API 키를 입력해 주세요.';
    Exit;
  end;
  NodeFile := ExpandConstant('{app}\runtime\node.exe');
  LaunchFile := ExpandConstant('{app}\launch.mjs');
  if FileExists(NodeFile) and FileExists(LaunchFile) then
    if not Exec(NodeFile, '"' + LaunchFile + '" --check-stopped',
      ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ExitCode) then
      Result := '기존 앱의 실행 상태를 확인하지 못했습니다. 앱을 종료한 뒤 다시 설치해 주세요.'
    else if ExitCode <> 0 then
      Result := 'system0가 실행 중입니다. 실행 창에서 Ctrl+C로 종료한 뒤 다시 설치해 주세요.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Settings: String;
begin
  if (CurStep = ssPostInstall) and not FileExists(EnvFilename) then
  begin
    if not ForceDirectories(DataDirectory) then
      RaiseException('설정 저장 폴더를 만들 수 없습니다.');
    Settings := 'OPENAI_API_KEY=' + Trim(KeyPage.Values[0]) + #13#10 +
      'PORT=3100' + #13#10;
    if not SaveStringToFile(EnvFilename, Settings, False) then
      RaiseException('API 키를 저장하지 못했습니다. 다시 설치해 주세요.');
  end;
end;
