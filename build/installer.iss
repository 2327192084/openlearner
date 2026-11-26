; ============================================================================
; OpenLeaner 安装程序 —— Inno Setup 6（2026-11-24，v0.40 起替换 NSIS）
;
; ## 为什么从 NSIS 换到 Inno Setup
;
; 旧方案是 build/installer.nsi + makensis 直接编（原因见那个文件的注释：
; electron-builder 的 nsis 目标两步编译在本机稳定失败）。换成 Inno Setup 后：
;   - 单次编译出包，无两步编译环节
;   - 卸载器由 Inno 自动生成，不再手工 WriteUninstaller
;   - 脚本同样是 Unicode 原生（[Languages] 用 ChineseSimplified.isl）
;
; ## 与旧 NSIS 脚本刻意保持一致的行为
;
; - **装到用户目录**（{localappdata}\Programs\OpenLeaner），PrivilegesRequired=lowest，
;   不弹 UAC —— 学生机器常常没有管理员。
; - **只写 HKCU**，不碰 HKLM。
; - **卸载不删数据**：学习库在 %APPDATA%\OpenLeaner（不在安装目录），
;   UninstallFilesDir 也不指向它；卸载只删应用文件与注册表项。
; - 桌面 + 开始菜单快捷方式；「应用和功能」里能看到版本、大小、卸载入口。
; - 默认静默参数与 NSIS /S 等价（/SILENT、/VERYSILENT 均支持）。
;
; ## 编译方式
;
;   ISCC.exe /DVERSION=0.40.1 installer.iss
; （SOURCE_DIR 缺省 release\win-unpacked；版本号与 package.json 保持同值，
;  由 scripts/build-innosetup.cjs 自动传入。）

#define MyAppName "OpenLeaner"
#define MyAppExe "OpenLeaner.exe"
#define MyAppPublisher "OpenLeaner"
#define MyAppId "com.openleaner.app"

#ifndef VERSION
  #define VERSION "0.40.1"
#endif

#ifndef SOURCE_DIR
  #define SOURCE_DIR "..\release\win-unpacked"
#endif

[Setup]
AppId={{D8F2C6E4-3A17-4B8D-9C5A-OpenLeaner40}
AppName={#MyAppName}
AppVersion={#VERSION}
; 用户目录安装：不需要管理员
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\{#MyAppName}
; 记住上次安装目录（对齐 NSIS 的 InstallDirRegKey）
UsePreviousAppDir=yes
DirExistsWarning=no
OutputDir=.
OutputBaseFilename=OpenLeaner-{#VERSION}-setup
Compression=lzma2/max
SolidCompression=yes
; win-unpacked 里的 exe 已有各自签名状态，不重复签名
Uninstallable=yes
CreateUninstallRegKey=yes
; 关闭向导「完成页」上的额外勾选，只留“运行 OpenLeaner”
; 与 NSIS 的 MUI_FINISHPAGE_RUN 对齐
WizardStyle=modern
; 中文界面优先（文件名含中文路径时依旧安全，Inno 原生 Unicode）
ShowLanguageDialog=no

[Languages]
Name: "chs"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "startmenuicon"; Description: "创建开始菜单快捷方式"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
; win-unpacked 全部内容（app.asar、resources、locales、OpenLeaner.exe、启动器）
Source: "{#SOURCE_DIR}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; 开始菜单（普通 + 卸载入口，对齐 NSIS 的两个快捷方式）
Name: "{autoprograms}\{#MyAppName}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"
Name: "{autoprograms}\{#MyAppName}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
; 桌面（默认勾选，任务里可取消）
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"; Tasks: desktopicon

[Run]
; 完成页可勾选立即启动（启动器优先 —— 沙箱问题见启动器 bat 注释）
Filename: "{app}\OpenLeaner-Launcher.bat"; Flags: postinstall skipifsilent nowait; Description: "立即启动 {#MyAppName}"; Check: LauncherExists

[UninstallRun]
; 先关掉正在运行的实例，否则文件被占用删不掉（对齐 NSIS 的 taskkill）
Filename: "{cmd}"; Parameters: "/C taskkill /F /IM {#MyAppExe}"; Flags: runhidden; RunOnceId: "KillApp"

[UninstallDelete]
; 确保安装目录被清干净（不包含 {app} 以外的位置；学习库在 %APPDATA%\OpenLeaner 不受影响）
Type: filesandordirs; Name: "{app}\resources"
Type: filesandordirs; Name: "{app}\locales"

[Code]
function LauncherExists(): Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\OpenLeaner-Launcher.bat'));
end;

// 已装旧版（NSIS 装的）也沿用其目录：NSIS 写过 HKCU\Software\OpenLeaner\InstallDir
// 2026-11-24 修复：原实现把 WizardForm.DirEdit 放在 InitializeSetup 里 —— 官方文档明确
// InitializeSetup 在向导窗体创建之前调用，此时引用 WizardForm 属于未定义行为：
// 大多数机器上 Inno 会自动先建窗体，但无 DWM / 精简系统上自动创建失败，表现为
// "Runtime error (at 4:280): Could not call proc"（用户新电脑实测复现）。
// 改成 InitializeWizard —— 官方指定用于初始化向导控件的时机，此时窗体必然已存在。
procedure InitializeWizard();
var
  oldDir: String;
begin
  if RegQueryStringValue(HKCU, 'Software\OpenLeaner', 'InstallDir', oldDir) then
  begin
    if DirExists(oldDir) then
      WizardForm.DirEdit.Text := oldDir;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  uninstNsis: String;
begin
  // 覆盖安装：把 NSIS 时代留下的 Uninstall.exe 从「应用和功能」里清掉，
  // 避免出现两条卸载入口。
  if CurStep = ssPostInstall then
  begin
    uninstNsis := ExpandConstant('{app}\Uninstall.exe');
    if FileExists(uninstNsis) then
      DeleteFile(uninstNsis);
    RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\com.openleaner.app');
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  // 卸载完成时，如果学习库还在，告诉用户数据保留在哪（对齐 NSIS 的提示）
  if CurUninstallStep = usPostUninstall then
  begin
    if DirExists(ExpandConstant('{userappdata}\OpenLeaner')) then
      MsgBox('学习库数据保留在：' #13#10 +
             ExpandConstant('{userappdata}\OpenLeaner') + #13#10#13#10 +
             '如果不再需要，请手动删除该文件夹。', mbInformation, MB_OK);
  end;
end;
