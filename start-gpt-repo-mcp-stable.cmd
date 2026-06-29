@echo off
chcp 65001 >nul
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "STABLE_PS1=%SCRIPT_DIR%scripts\start-gpt-repo-mcp-stable.ps1"

if not exist "%STABLE_PS1%" (
    echo [ERROR] Stable runtime script not found:
    echo %STABLE_PS1%
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%STABLE_PS1%"
set "RUNTIME_EXIT_CODE=%ERRORLEVEL%"

pause
endlocal
exit /b %RUNTIME_EXIT_CODE%
