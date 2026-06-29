@echo off
chcp 65001 >nul
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "PANEL_JS=%SCRIPT_DIR%scripts\mcp-control-panel.mjs"
set "PANEL_URL=http://127.0.0.1:8790"

if not exist "%PANEL_JS%" (
    echo [ERROR] Control panel script not found:
    echo %PANEL_JS%
    pause
    exit /b 1
)

echo.
echo ====== GPT Repo MCP Control Panel ======
echo URL: %PANEL_URL%
echo.
echo Keep this window open. Stop with Ctrl+C.
echo.

start "" "%PANEL_URL%"
node "%PANEL_JS%"
set "PANEL_EXIT_CODE=%ERRORLEVEL%"

echo.
echo Control panel ended. ExitCode = %PANEL_EXIT_CODE%
echo.
pause

endlocal
exit /b %PANEL_EXIT_CODE%
