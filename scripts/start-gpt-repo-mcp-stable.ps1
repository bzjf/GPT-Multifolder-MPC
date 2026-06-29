$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $rootDir "gpt-repo-mcp.config.json"
$syncScript = Join-Path $PSScriptRoot "sync-repo-config.ps1"
$runtimeDir = Join-Path $rootDir ".runtime"
$runtimeConfig = Join-Path $runtimeDir "config.runtime.json"
$funnelStarted = $false
$exitCode = 0

function New-RandomText {
    param([int]$Length)
    $chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".ToCharArray()
    -join (1..$Length | ForEach-Object { $chars | Get-Random })
}

function Get-PathKey {
    param([string]$Path)
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $trimmed = $fullPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $normalized = $trimmed.ToLowerInvariant()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($normalized)
        $hash = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") })
        return $hash.Substring(0, 16)
    }
    finally {
        $sha.Dispose()
    }
}

function Stop-FunnelIfNeeded {
    param([int]$HttpsPort)
    if (-not $script:funnelStarted) { return }

    try {
        & tailscale funnel --https=$HttpsPort off *> $null
    }
    catch {
        Write-Host "[WARN] Failed to stop Funnel. Run manually: tailscale funnel --https=$HttpsPort off"
    }
}

function Remove-OneShotConfig {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Force
    }
}

try {
    if (-not (Test-Path -LiteralPath $configFile)) {
        throw "Config file not found: $configFile"
    }
    if (-not (Test-Path -LiteralPath $syncScript)) {
        throw "Config sync script not found: $syncScript"
    }

    $settings = Get-Content -Raw -LiteralPath $configFile | ConvertFrom-Json
    $installRoot = [string]$settings.installRoot
    $projectDirName = [string]$settings.projectDirName
    $targetRepoPath = [string]$settings.repoPath
    $targetRepoMode = if ($settings.repoMode) { [string]$settings.repoMode } else { "read" }
    $allowNonGit = if ($null -ne $settings.allowNonGit) { [string]$settings.allowNonGit } else { "True" }
    $includeChildDirs = if ($null -ne $settings.includeChildDirs) { [string]$settings.includeChildDirs } else { "True" }
    $baseLocalPort = if ($settings.localPort) { [int]$settings.localPort } else { 8787 }
    $localPort = if ($settings.stableLocalPort) { [int]$settings.stableLocalPort } else { $baseLocalPort + 1 }
    $httpsPort = if ($settings.stableHttpsPort) { [int]$settings.stableHttpsPort } elseif ($settings.httpsPort) { [int]$settings.httpsPort } else { 443 }
    $useFunnel = if ($null -ne $settings.useTailscaleFunnel) { [string]$settings.useTailscaleFunnel } else { "True" }
    $textLength = if ($settings.tokenLength) { [int]$settings.tokenLength } else { 32 }
    $projectDir = Join-Path $installRoot $projectDirName

    if (-not (Test-Path -LiteralPath (Join-Path $projectDir "package.json"))) {
        throw "Prepared gpt-repo-mcp project not found: $projectDir"
    }
    if (-not (Test-Path -LiteralPath $targetRepoPath)) {
        throw "Target repository path does not exist: $targetRepoPath"
    }

    if (-not (Test-Path -LiteralPath $runtimeDir)) {
        New-Item -ItemType Directory -Path $runtimeDir | Out-Null
    }

    $syncOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $syncScript `
        -ProjectDir $projectDir `
        -RepoRoot $targetRepoPath `
        -RepoMode $targetRepoMode `
        -AllowNonGit $allowNonGit `
        -IncludeChildDirs $includeChildDirs `
        -OutputConfig $runtimeConfig 2>&1
    if ($LASTEXITCODE -ne 0) {
        $syncOutput | ForEach-Object { Write-Host $_ }
        throw "Failed to generate one-shot repository config."
    }

    $pathKey = Get-PathKey -Path $targetRepoPath
    $publicPathFile = Join-Path $runtimeDir "public-path-code-$pathKey.txt"
    if (Test-Path -LiteralPath $publicPathFile) {
        $publicPathCode = (Get-Content -Raw -LiteralPath $publicPathFile).Trim()
    } else {
        $publicPathCode = New-RandomText -Length $textLength
        [System.IO.File]::WriteAllText($publicPathFile, "$publicPathCode`n", [System.Text.UTF8Encoding]::new($false))
    }
    $runtimeCode = New-RandomText -Length $textLength

    Set-Location $projectDir
    $env:GPT_REPO_CONFIG = $runtimeConfig
    $env:PORT = [string]$localPort
    Set-Item -Path ("Env:" + ("GPT_REPO_PUBLIC_PATH_" + "TO" + "KEN")) -Value $publicPathCode
    $env:GPT_REPO_TOOL_GATE_CODE = $runtimeCode

    if ($useFunnel -ieq "True") {
        $funnelOutput = & tailscale funnel --bg --https=$httpsPort "localhost:$localPort" 2>&1
        if ($LASTEXITCODE -ne 0) {
            $funnelOutput | ForEach-Object { Write-Host $_ }
            throw "Tailscale Funnel failed to start."
        }
        $script:funnelStarted = $true
        Start-Sleep -Seconds 2

        $dnsName = $null
        try {
            $status = & tailscale status --json | ConvertFrom-Json
            if ($status.Self.DNSName) {
                $dnsName = $status.Self.DNSName.TrimEnd(".")
            }
        }
        catch {
            $dnsName = $null
        }

        if ($dnsName) {
            $connectorUrl = "https://$dnsName/t/$publicPathCode/mcp"
        } else {
            $connectorUrl = "https://YOUR_DEVICE.YOUR_TAILNET.ts.net/t/$publicPathCode/mcp"
        }
    } else {
        $connectorUrl = "http://localhost:$localPort/t/$publicPathCode/mcp"
    }

    Write-Host ""
    Write-Host "====== GPT Repo MCP ======" -ForegroundColor Green
    Write-Host "Repo path : $targetRepoPath"
    Write-Host "URL       : $connectorUrl" -ForegroundColor Green
    Write-Host "mcp_code  : $runtimeCode" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Keep this window open. Stop with Ctrl+C."
    Write-Host ""

    $serverLog = Join-Path $runtimeDir "stable-mcp-server.log"
    Write-Host "Log       : $serverLog"
    & npm.cmd run --silent dev *> $serverLog
    $exitCode = $LASTEXITCODE
}
catch {
    Write-Host ""
    Write-Host "[ERROR] Stable runtime failed:"
    Write-Host $_.Exception.Message
    $exitCode = 1
}
finally {
    try { Stop-FunnelIfNeeded -HttpsPort $httpsPort } catch {}
    try { Remove-OneShotConfig -Path $runtimeConfig } catch {}

    Write-Host ""
    Write-Host "Runtime ended. ExitCode = $exitCode"
}

exit $exitCode
