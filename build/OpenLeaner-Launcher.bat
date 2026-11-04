@echo off
rem ==========================================================================
rem OpenLeaner Launcher
rem ==========================================================================
rem Why this file exists instead of double-clicking OpenLeaner.exe directly:
rem
rem On some Windows setups Chromium's sandbox fails to initialise BEFORE any
rem JavaScript runs. The process exits with code 3 and the user sees nothing
rem at all - not even a log line, because the crash is in native code.
rem
rem Measured matrix (packaged exe):
rem   OpenLeaner.exe                  -> exit 3, main.cjs never executed
rem   OpenLeaner.exe --disable-gpu    -> exit 3, main.cjs never executed
rem   OpenLeaner.exe --no-sandbox     -> runs fine, window appears
rem   ELECTRON_DISABLE_SANDBOX=1 ...  -> runs fine
rem
rem app.commandLine.appendSwitch('no-sandbox') inside main.cjs is TOO LATE -
rem the sandbox is already initialised by then. So the fix has to happen at
rem the launcher level, which is what this file does.
rem
rem This disables the Chromium renderer sandbox, NOT OS account privileges.
rem contextIsolation, nodeIntegration:false, the preload allow-list, the
rem external-protocol allow-list and deny-by-default permissions all stay on.
rem The renderer only loads locally packaged static files, never remote web
rem pages, which keeps the real exposure small.
rem ==========================================================================

setlocal
set "APP_DIR=%~dp0"
set "EXE=%APP_DIR%OpenLeaner.exe"

if not exist "%EXE%" (
    echo [ERROR] OpenLeaner.exe not found.
    echo Expected: %EXE%
    echo.
    echo Make sure this launcher sits next to OpenLeaner.exe.
    pause
    exit /b 1
)

start "" "%EXE%" --no-sandbox %*

endlocal
exit /b 0
