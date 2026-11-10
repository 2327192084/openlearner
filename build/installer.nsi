; OpenLeaner 安装程序（2026-11-11）
;
; ## 为什么自己写 NSIS 脚本，不用 electron-builder 的 nsis 目标
;
; electron-builder 的 nsis 目标是**两步编译**：
;   1) 先编译一个只含「安装器逻辑」的临时 exe
;   2) 运行它，让它把自己体内的卸载器释放出来
;   3) 再把卸载器嵌进最终安装包，编译第二次
;
; 第 2 步在本机稳定失败（进程 exit code null）。
; 实测日志里 Install data: 0 / 8 bytes —— 安装数据一个字节都没进去，
; 189KB 全是卸载器代码。它把这个中间产物当成了最终包。
;
; 而 electron-builder 的 `portable` 目标（单文件自解压）在这台机器上
; 一次就成功（101MB），说明 makensis 本身、7z、缓存、编码都没问题，
; 唯一出问题的就是那两步编译里的卸载器环节。
;
; 所以这里直接调 makensis，一次性把「应用文件 + 卸载器 + 快捷方式 +
; 注册表项」全部编进去。绕开那两步，行为完全可控。
;
; ## 几个刻意的选择
;
; - **装到用户目录**（$LOCALAPPDATA\Programs），不要管理员权限。
;   学生机器常常没有管理员，装到 Program Files 会弹 UAC 然后失败。
; - **Unicode true**：中文路径/中文用户名必须靠它。
; - **不写 HKLM**：只写 HKCU，卸载时才不会要求提权。
; - **deleteAppDataOnUninstall = 不删**：学习库是用户的数据，
;   卸载程序时不能顺手删掉他几百页的复习记录。
;   卸载时只提示数据在哪，让他自己决定。

Unicode true
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

; ---- 基本信息（版本号由 makensis 命令行 -DVERSION 传入，避免两处漂）----
!ifndef VERSION
  !define VERSION "0.1.0"
!endif
!ifndef SOURCE_DIR
  !error "必须用 -DSOURCE_DIR=<win-unpacked 目录> 指定要打包的文件"
!endif

!define APP_NAME "OpenLeaner"
!define APP_EXE "OpenLeaner.exe"
!define APP_PUBLISHER "OpenLeaner"
!define APP_ID "com.openleaner.app"
; 卸载信息写在这里（HKCU，无需提权）
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"

Name "${APP_NAME} ${VERSION}"
OutFile "OpenLeaner-${VERSION}-setup.exe"
; 用户目录安装：$LOCALAPPDATA 在 Vista+ 一定存在
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_NAME}" "InstallDir"
; 单用户安装，不请求提权
RequestExecutionLevel user

; ---- 界面 ----
!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

; 完成页：勾上就直接运行
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 ${APP_NAME}"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; ---- 语言：简体中文优先，附带英文兜底 ----
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; ============================================================================
; 安装
; ============================================================================
Section "主程序" SecMain
  SetOutPath "$INSTDIR"

  ; 先清掉上一版残留的旧文件，避免「装了新版、跑的还是旧文件」。
  ; 只删应用文件，不碰 openleaner-data（那是用户数据）。
  RMDir /r "$INSTDIR\resources\app.asar.unpacked"

  ; 应用本体（win-unpacked 的全部内容）
  File /r "${SOURCE_DIR}\*.*"

  ; 安装信息写注册表（HKCU：卸载时不用再要一次权限）
  WriteRegStr HKCU "Software\${APP_NAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\${APP_NAME}" "Version" "${VERSION}"

  ; 「应用和功能」里显示一条
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME} ${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ; 让「应用和功能」能算出这个程序占多大
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"

  ; 卸载器
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; 快捷方式：桌面 + 开始菜单
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
SectionEnd

; ============================================================================
; 卸载
; ============================================================================
Section "Uninstall"
  ; 先关掉正在运行的程序，否则文件被占用删不掉
  ; （用 taskkill 而不是 FindWindow：它不挑窗口标题）
  ExecWait 'taskkill /F /IM ${APP_EXE}' $0

  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"

  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  Delete "$DESKTOP\${APP_NAME}.lnk"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${APP_NAME}"

  ; ⚠️ 刻意**不删** openleaner-data 与 AppData\OpenLeaner：
  ; 那是用户的学习库（资料、知识点、题目、复习记录）。
  ; 卸载软件不等于要删数据。这里只告诉他数据还在哪。
  IfFileExists "$INSTDIR\openleaner-data\*.*" 0 +2
    MessageBox MB_ICONINFORMATION "学习库数据保留在原位置：$\r$\n$INSTDIR\openleaner-data$\r$\n$\r$\n如果不再需要，请手动删除该文件夹。"
SectionEnd

; ============================================================================
; 初始化：允许「已安装就覆盖安装」
; ============================================================================
Function .onInit
  ; 已经装过：沿用上次的安装目录（用户可能装到了 D 盘）
  ReadRegStr $0 HKCU "Software\${APP_NAME}" "InstallDir"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
FunctionEnd
