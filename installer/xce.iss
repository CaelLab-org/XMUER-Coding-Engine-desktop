; XMUER Coding Engine desktop installer (Inno Setup 6.5+).
; Build with scripts/build-installer.mjs, which injects the version from package.json.

#define AppName "XMUER Coding Engine"
#define AppExeName "XMUER Coding Engine.exe"
#define AppPublisher "CaelLab"
#define AppContact "contact@caellab.com"
#define AppURL "https://engine.xmuer.online/"
#define GroupName "CaelLab"

; GUID electron-builder derived from appId for its NSIS installer; used to take over
; an existing NSIS install and to refuse a leftover per-machine one.
#define OldNsGuid "5dc13d90-07f6-51be-a4ee-f6f843b70f8c"

#ifndef AppVersion
  #error AppVersion is not defined (pass /DAppVersion=x.y.z)
#endif
#ifndef VersionInfoVersion
  #define VersionInfoVersion "0.0.0.0"
#endif
#ifndef PayloadDir
  #define PayloadDir "..\dist\win-unpacked"
#endif
#ifndef InnoOutputDir
  #define InnoOutputDir "..\dist"
#endif
#ifndef InnoOutputName
  #define InnoOutputName "XCE-Setup-" + AppVersion
#endif

[Setup]
AppId={{7C4B9D62-15A8-4F31-9E7D-2B6A0C8E5F47}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
AppComments={#AppName} desktop app
AppContact={#AppContact}
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#GroupName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
MinVersion=10.0
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#InnoOutputDir}
OutputBaseFilename={#InnoOutputName}
SetupIconFile=..\art\icon.ico
UninstallDisplayName={#AppName} {#AppVersion}
UninstallDisplayIcon={app}\{#AppExeName}
; 许可协议只作为安装前的提示页（InfoBeforeFile）；不再用 LicenseFile 那一步，
; 免得用户还要点「我接受」。隐私 + 许可证正文都在 privacy-installer.txt 里。
InfoBeforeFile=..\art\privacy-installer.txt
; 不弹语言选择器：按系统语言自动选，认不出来用 [Languages] 里的第一个
ShowLanguageDialog=no
DisableWelcomePage=no
WizardStyle=dynamic includetitlebar
WizardSizePercent=120,120
WizardImageFile=..\art\wizard-202.png,..\art\wizard-404.png,..\art\wizard-606.png
WizardSmallImageFile=..\art\wizardsmall-55.png,..\art\wizardsmall-110.png,..\art\wizardsmall-165.png
Compression=lzma2/max
SolidCompression=yes
CloseApplications=yes
ChangesAssociations=yes
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} Setup
VersionInfoVersion={#VersionInfoVersion}
VersionInfoTextVersion={#AppVersion}
VersionInfoCopyright=Copyright (C) 2026 CaelLab - AGPL-3.0-only

[Languages]
Name: "chinesesimplified"; MessagesFile: "lang\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
chinesesimplified.WelcomeExtra={#AppName} 是一个 Scratch 风格的编程编辑器，自带 AI 终端。由虚舟实验室（CaelLab）开发并维护，以 AGPL-3.0 许可开源。
english.WelcomeExtra={#AppName} is a Scratch-style coding editor with a built-in AI terminal. Developed and maintained by CaelLab, released under AGPL-3.0.
chinesesimplified.UpgradeNotice=检测到本机已有的 {#AppName}（旧安装器安装）。将就地升级：安装目录不变，你的项目和设置都会保留。
english.UpgradeNotice=An existing {#AppName} installation was found. Setup will upgrade it in place: same folder, your projects and settings are kept.
chinesesimplified.AllUsersBlocked=检测到为「所有用户」安装的旧版本。请先在 Windows 的「设置 → 应用」里卸载它，再运行本安装程序。
english.AllUsersBlocked=A per-machine installation of an older version was found. Uninstall it from Windows Settings > Apps first, then run this installer again.
chinesesimplified.FileAssoc=把 .sb3 / .xce 作品与本程序关联（双击直接打开）
english.FileAssoc=Associate .sb3 / .xce projects with this app (open by double-click)

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce
Name: "fileassoc"; Description: "{cm:FileAssoc}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

; 文件关联：双击 .sb3 / .xce 用本程序打开。
; .chat.xce / .output.xce 也是 .xce 结尾，主进程会认出它们并提示去 AI 面板导入，不会当作品载入。
[Registry]
Root: HKA; Subkey: "Software\Classes\.sb3"; ValueType: string; ValueName: ""; ValueData: "CaelLab.XCE.Project"; Flags: uninsdeletevalue; Tasks: fileassoc
Root: HKA; Subkey: "Software\Classes\.xce"; ValueType: string; ValueName: ""; ValueData: "CaelLab.XCE.Project"; Flags: uninsdeletevalue; Tasks: fileassoc
Root: HKA; Subkey: "Software\Classes\CaelLab.XCE.Project"; ValueType: string; ValueName: ""; ValueData: "XMUER Coding Engine 作品"; Flags: uninsdeletekey; Tasks: fileassoc
Root: HKA; Subkey: "Software\Classes\CaelLab.XCE.Project\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#AppExeName},0"; Tasks: fileassoc
Root: HKA; Subkey: "Software\Classes\CaelLab.XCE.Project\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExeName}"" ""%1"""; Tasks: fileassoc

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
; 应用内自动更新（/VERYSILENT /RELAUNCH=1）：装完把新版直接拉起来
Filename: "{app}\{#AppExeName}"; Flags: nowait; Check: RelaunchAfterSilentInstall

[UninstallDelete]
Type: filesandordirs; Name: "{userappdata}\{#AppName}"

[Code]
var
  OldInstallDir: String;

function RelaunchAfterSilentInstall: Boolean;
begin
  Result := WizardSilent and (ExpandConstant('{param:RELAUNCH|0}') = '1');
end;

function OpenProcess(dwDesiredAccess: Cardinal; bInheritHandle: Boolean;
  dwProcessId: Cardinal): Cardinal;
  external 'OpenProcess@kernel32.dll stdcall';
function WaitForSingleObject(hHandle: Cardinal; dwMilliseconds: Cardinal): Cardinal;
  external 'WaitForSingleObject@kernel32.dll stdcall';
function CloseHandle(hObject: Cardinal): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';

// 应用内更新时，主进程先把安装程序拉起来再退出。Restart Manager 对这种「正在退出的
// Electron 进程」不一定靠得住，所以这里明确等它退干净（最多 2 分钟）再动文件。
procedure WaitForPreviousApp;
var
  WaitPid: Integer;
  ProcHandle: Cardinal;
begin
  WaitPid := StrToIntDef(ExpandConstant('{param:WAITPID|0}'), 0);
  if WaitPid <= 0 then Exit;
  ProcHandle := OpenProcess($00100000, False, WaitPid);
  if ProcHandle <> 0 then
  begin
    WaitForSingleObject(ProcHandle, 120000);
    CloseHandle(ProcHandle);
  end;
end;

function OldNsKey: String;
begin
  Result := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#OldNsGuid}';
end;

function OldNsInstallPresent: Boolean;
begin
  Result := RegKeyExists(HKEY_CURRENT_USER, OldNsKey);
end;

function InitializeSetup: Boolean;
begin
  Result := True;
  WaitForPreviousApp;
  if OldNsInstallPresent then
    RegQueryStringValue(HKEY_CURRENT_USER, 'Software\{#OldNsGuid}', 'InstallLocation', OldInstallDir)
  else if RegKeyExists(HKEY_LOCAL_MACHINE, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#OldNsGuid}') then
  begin
    MsgBox(ExpandConstant('{cm:AllUsersBlocked}'), mbCriticalError, MB_OK);
    Result := False;
  end;
end;

procedure InitializeWizard;
begin
  if OldNsInstallPresent and (OldInstallDir <> '') and DirExists(OldInstallDir) then
    WizardForm.DirEdit.Text := OldInstallDir;

  WizardForm.WelcomeLabel2.Caption := WizardForm.WelcomeLabel2.Caption + #13#10#13#10 +
    ExpandConstant('{cm:WelcomeExtra}');
  if OldNsInstallPresent then
    WizardForm.WelcomeLabel2.Caption := WizardForm.WelcomeLabel2.Caption + #13#10#13#10 +
      ExpandConstant('{cm:UpgradeNotice}');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssInstall) and OldNsInstallPresent then
  begin
    RegDeleteKeyIncludingSubkeys(HKEY_CURRENT_USER, OldNsKey);
    RegDeleteKeyIncludingSubkeys(HKEY_CURRENT_USER, 'Software\{#OldNsGuid}');
    DeleteFile(ExpandConstant('{app}\Uninstall {#AppName}.exe'));
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  // 旧安装器装的用户就地升级：目录必须沿用旧位置，改了就会留一份孤儿安装
  Result := (PageID = wpSelectDir) and OldNsInstallPresent and (OldInstallDir <> '');
end;
