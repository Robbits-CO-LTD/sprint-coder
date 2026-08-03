#ifndef SourceSetup
  #error SourceSetup must be provided by the Forge postMake hook
#endif
#ifndef OutputDir
  #error OutputDir must be provided by the Forge postMake hook
#endif
#ifndef AppVersion
  #error AppVersion must be provided by the Forge postMake hook
#endif
#ifndef SetupIcon
  #error SetupIcon must be provided by the Forge postMake hook
#endif

[Setup]
AppId=SprintCoder.InstallWizard
AppName=Sprint Coder
AppVersion={#AppVersion}
AppVerName=Sprint Coder {#AppVersion}
AppPublisher=Sprint Coder contributors
AppPublisherURL=https://github.com/Robbits-CO-LTD/sprint-coder
AppSupportURL=https://github.com/Robbits-CO-LTD/sprint-coder/issues
AppUpdatesURL=https://github.com/Robbits-CO-LTD/sprint-coder/releases
DefaultDirName={localappdata}\SprintCoder
CreateAppDir=no
Uninstallable=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=Sprint-Coder-Installer
SetupIconFile={#SetupIcon}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
DisableWelcomePage=no
DisableReadyPage=no
DisableFinishedPage=no
ShowLanguageDialog=auto
UsePreviousLanguage=no
CloseApplications=no
RestartApplications=no
RestartIfNeededByRun=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"

[CustomMessages]
english.InstallingSprintCoder=Installing Sprint Coder...
japanese.InstallingSprintCoder=Sprint Coder をインストールしています...
english.SquirrelInstallStartFailed=Could not start the Sprint Coder installer. Error %d: %s
japanese.SquirrelInstallStartFailed=Sprint Coder インストーラーを開始できませんでした。エラー %d: %s
english.SquirrelInstallFailed=Sprint Coder could not be installed. The installer returned error code %d.
japanese.SquirrelInstallFailed=Sprint Coder をインストールできませんでした。インストーラーの終了コード: %d

[Files]
Source: "{#SourceSetup}"; DestDir: "{tmp}"; DestName: "Sprint-Coder-Setup.exe"; Flags: deleteafterinstall ignoreversion; AfterInstall: InstallSprintCoder

[Run]
Filename: "{localappdata}\SprintCoder\Update.exe"; Parameters: "--processStart ""Sprint Coder.exe"""; Description: "{cm:LaunchProgram,Sprint Coder}"; Flags: nowait postinstall skipifsilent skipifdoesntexist

[Code]
procedure InstallSprintCoder;
var
  ResultCode: Integer;
  Bootstrapper: String;
begin
  WizardForm.StatusLabel.Caption := ExpandConstant('{cm:InstallingSprintCoder}');
  Bootstrapper := ExpandConstant('{tmp}\Sprint-Coder-Setup.exe');
  if not Exec(Bootstrapper, '--silent', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    RaiseException(Format(
      ExpandConstant('{cm:SquirrelInstallStartFailed}'),
      [ResultCode, SysErrorMessage(ResultCode)]));
  if ResultCode <> 0 then
    RaiseException(Format(ExpandConstant('{cm:SquirrelInstallFailed}'), [ResultCode]));
end;
