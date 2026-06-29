@echo off
chcp 65001 >nul
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "PANEL_JS=%SCRIPT_DIR%scripts\mcp-control-panel.mjs"
set "GPT_REPO_PANEL_OPEN=1"

if not exist "%PANEL_JS%" (
    echo [ERROR] Control panel script not found:
    echo %PANEL_JS%
    pause
    exit /b 1
)

echo.
echo ====== GPT Repo MCP Control Panel ======
echo The browser will open after the panel port is bound successfully.
echo If the panel port is already in use, this window will show the error instead of opening a stale page.
echo.
echo Keep this window open. Stop with Ctrl+C.
echo.

node "%PANEL_JS%"
set "PANEL_EXIT_CODE=%ERRORLEVEL%"

echo.
echo Control panel ended. ExitCode = %PANEL_EXIT_CODE%
echo.
pause

endlocal
exit /b %PANEL_EXIT_CODE%
