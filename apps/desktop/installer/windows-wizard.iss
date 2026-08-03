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

[Files]
Source: "{#SourceSetup}"; DestDir: "{tmp}"; DestName: "Sprint-Coder-Setup.exe"; Flags: deleteafterinstall ignoreversion

[Run]
Filename: "{tmp}\Sprint-Coder-Setup.exe"; Parameters: "--silent"; StatusMsg: "{cm:InstallingSprintCoder}"; Flags: runhidden waituntilterminated
Filename: "{localappdata}\SprintCoder\Update.exe"; Parameters: "--processStart ""Sprint Coder.exe"""; Description: "{cm:LaunchProgram,Sprint Coder}"; Flags: nowait postinstall skipifsilent skipifdoesntexist
