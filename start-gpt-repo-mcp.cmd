@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion

REM ============================================================
REM start-gpt-repo-mcp.cmd
REM Start a disposable gpt-repo-mcp runtime.
REM Setup/check/build lives in scripts\setup-gpt-repo-mcp.cmd.
REM Repository access is generated fresh from gpt-repo-mcp.config.json.
REM ============================================================

set "SCRIPT_DIR=%~dp0"
set "CONFIG_FILE=%SCRIPT_DIR%gpt-repo-mcp.config.json"
set "TOOLS_DIR=%SCRIPT_DIR%scripts"
set "SYNC_PS1=%TOOLS_DIR%\sync-repo-config.ps1"
set "RUNNER_PS1=%TOOLS_DIR%\run-bound-mcp.ps1"
set "RUNTIME_DIR=%SCRIPT_DIR%.runtime"
set "RUNTIME_CONFIG=%RUNTIME_DIR%\config.runtime.json"

if not exist "%CONFIG_FILE%" (
    echo [ERROR] Config file not found:
    echo %CONFIG_FILE%
    pause
    exit /b 1
)

if not exist "%SYNC_PS1%" (
    echo [ERROR] Config sync script not found:
    echo %SYNC_PS1%
    pause
    exit /b 1
)

if not exist "%RUNNER_PS1%" (
    echo [ERROR] Runtime PowerShell script not found:
    echo %RUNNER_PS1%
    pause
    exit /b 1
)

echo.
echo ====== 1. Read runtime config ======

for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content -Raw '%CONFIG_FILE%' | ConvertFrom-Json).installRoot"`) do set "INSTALL_ROOT=%%A"
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content -Raw '%CONFIG_FILE%' | ConvertFrom-Json).projectDirName"`) do set "PROJECT_DIR_NAME=%%A"
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content -Raw '%CONFIG_FILE%' | ConvertFrom-Json).repoPath"`) do set "TARGET_REPO_PATH=%%A"
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content -Raw '%CONFIG_FILE%' | ConvertFrom-Json).repoMode"`) do set "TARGET_REPO_MODE=%%A"
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content -Raw '%CONFIG_FILE%' | ConvertFrom-Json).allowNonGit"`) do set "ALLOW_NON_GIT=%%A"
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content -Raw '%CONFIG_FILE%' | ConvertFrom-Json).includeChildDirs"`) do set "INCLUDE_CHILD_DIRS=%%A"
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content -Raw '%CONFIG_FILE%' | ConvertFrom-Json).localPort"`) do set "LOCAL_PORT=%%A"
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content -Raw '%CONFIG_FILE%' | ConvertFrom-Json).httpsPort"`) do set "HTTPS_PORT=%%A"
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content -Raw '%CONFIG_FILE%' | ConvertFrom-Json).useTailscaleFunnel"`) do set "USE_TAILSCALE_FUNNEL=%%A"
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content -Raw '%CONFIG_FILE%' | ConvertFrom-Json).tokenLength"`) do set "TOKEN_LENGTH=%%A"

if "%TARGET_REPO_MODE%"=="" set "TARGET_REPO_MODE=read"
if "%ALLOW_NON_GIT%"=="" set "ALLOW_NON_GIT=True"
if "%INCLUDE_CHILD_DIRS%"=="" set "INCLUDE_CHILD_DIRS=True"
if "%LOCAL_PORT%"=="" set "LOCAL_PORT=8787"
if "%HTTPS_PORT%"=="" set "HTTPS_PORT=443"
if "%USE_TAILSCALE_FUNNEL%"=="" set "USE_TAILSCALE_FUNNEL=True"
if "%TOKEN_LENGTH%"=="" set "TOKEN_LENGTH=32"

set "PROJECT_DIR=%INSTALL_ROOT%\%PROJECT_DIR_NAME%"

echo PROJECT_DIR        = %PROJECT_DIR%
echo TARGET_REPO_PATH   = %TARGET_REPO_PATH%
echo TARGET_REPO_MODE   = %TARGET_REPO_MODE%
echo ALLOW_NON_GIT      = %ALLOW_NON_GIT%
echo INCLUDE_CHILD_DIRS = %INCLUDE_CHILD_DIRS%
echo LOCAL_PORT         = %LOCAL_PORT%
echo HTTPS_PORT         = %HTTPS_PORT%
echo RUNTIME_CONFIG     = %RUNTIME_CONFIG%

echo.
echo ====== 2. Validate prepared runtime ======

if not exist "%PROJECT_DIR%\package.json" (
    echo [ERROR] Prepared gpt-repo-mcp project not found:
    echo %PROJECT_DIR%
    echo.
    echo Run setup first:
    echo %TOOLS_DIR%\setup-gpt-repo-mcp.cmd
    pause
    exit /b 1
)

if not exist "%TARGET_REPO_PATH%" (
    echo [ERROR] Target repository path does not exist:
    echo %TARGET_REPO_PATH%
    pause
    exit /b 1
)

echo.
echo ====== 3. Generate one-shot repository config ======

if not exist "%RUNTIME_DIR%" (
    mkdir "%RUNTIME_DIR%"
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SYNC_PS1%" -ProjectDir "%PROJECT_DIR%" -RepoRoot "%TARGET_REPO_PATH%" -RepoMode "%TARGET_REPO_MODE%" -AllowNonGit "%ALLOW_NON_GIT%" -IncludeChildDirs "%INCLUDE_CHILD_DIRS%" -OutputConfig "%RUNTIME_CONFIG%"
if errorlevel 1 (
    echo [ERROR] Failed to generate one-shot repository config.
    pause
    exit /b 1
)

echo.
echo ====== 4. Generate token ======

for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$chars='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.ToCharArray(); -join (1..%TOKEN_LENGTH% | ForEach-Object { $chars | Get-Random })"`) do set "MCP_TOKEN=%%A"

echo MCP_TOKEN = %MCP_TOKEN%

echo.
echo ====== 5. Start one-shot MCP runtime ======
echo.
echo IMPORTANT:
echo - Keep this window open.
echo - Stop MCP Server with Ctrl+C.
echo - When MCP Server stops, Funnel and one-shot config will be cleaned up.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%RUNNER_PS1%" -ProjectDir "%PROJECT_DIR%" -LocalPort %LOCAL_PORT% -HttpsPort %HTTPS_PORT% -Token "%MCP_TOKEN%" -UseFunnel "%USE_TAILSCALE_FUNNEL%" -RuntimeConfig "%RUNTIME_CONFIG%"

set "RUNTIME_EXIT_CODE=%ERRORLEVEL%"

if exist "%RUNTIME_CONFIG%" (
    del /f /q "%RUNTIME_CONFIG%" >nul 2>nul
)

echo.
echo ====== Script finished ======
echo Runtime exit code: %RUNTIME_EXIT_CODE%
echo.
echo If Funnel is still on, stop it manually:
echo tailscale funnel --https=%HTTPS_PORT% off
echo.
pause

endlocal
exit /b %RUNTIME_EXIT_CODE%
