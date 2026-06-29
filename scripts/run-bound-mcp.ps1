param(
    [string]$ProjectDir,
    [int]$LocalPort,
    [int]$HttpsPort,
    [string]$Token,
    [string]$UseFunnel,
    [string]$RuntimeConfig = ""
)

$ErrorActionPreference = "Stop"

$useFunnelBool = $UseFunnel -ieq "True"
$funnelStarted = $false
$exitCode = 0

function Stop-GptRepoFunnel {
    param([int]$HttpsPort)

    if ($script:funnelStarted) {
        Write-Host ""
        Write-Host "====== Stopping Tailscale Funnel ======"
        try {
            & tailscale funnel --https=$HttpsPort off
        }
        catch {
            Write-Host "[WARN] Failed to stop Funnel automatically."
            Write-Host "Run manually:"
            Write-Host "tailscale funnel --https=$HttpsPort off"
        }
    }
}

function Remove-OneShotConfig {
    param([string]$ConfigPath)

    if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
        return
    }

    $repoRoot = Split-Path -Parent $PSScriptRoot
    $runtimeRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot ".runtime"))
    $resolvedConfig = [System.IO.Path]::GetFullPath($ConfigPath)

    if ($resolvedConfig.StartsWith($runtimeRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedConfig)) {
        Remove-Item -LiteralPath $resolvedConfig -Force
        Write-Host "Removed one-shot config: $resolvedConfig"
    }
}

try {
    Set-Location $ProjectDir

    $configPath = if ([string]::IsNullOrWhiteSpace($RuntimeConfig)) {
        Join-Path $ProjectDir "config.local.json"
    } else {
        $RuntimeConfig
    }

    $env:GPT_REPO_CONFIG = $configPath
    $env:PORT = [string]$LocalPort
    $env:GPT_REPO_PUBLIC_PATH_TOKEN = $Token

    Write-Host ""
    Write-Host "====== Bound runtime ======"
    Write-Host "ProjectDir = $ProjectDir"
    Write-Host "PORT = $env:PORT"
    Write-Host "GPT_REPO_CONFIG = $env:GPT_REPO_CONFIG"
    Write-Host "GPT_REPO_PUBLIC_PATH_TOKEN = $env:GPT_REPO_PUBLIC_PATH_TOKEN"

    if ($useFunnelBool) {
        Write-Host ""
        Write-Host "====== Starting Tailscale Funnel ======"
        Write-Host "tailscale funnel --bg --https=$HttpsPort localhost:$LocalPort"

        & tailscale funnel --bg --https=$HttpsPort "localhost:$LocalPort"

        if ($LASTEXITCODE -ne 0) {
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

        Write-Host ""
        Write-Host "====== Current Funnel status ======"
        & tailscale funnel status

        Write-Host ""
        Write-Host "====== ChatGPT Connector URL ======"
        if ($dnsName) {
            Write-Host "https://$dnsName/t/$Token/mcp" -ForegroundColor Green
        }
        else {
            Write-Host "https://YOUR_DEVICE.YOUR_TAILNET.ts.net/t/$Token/mcp" -ForegroundColor Yellow
            Write-Host "Could not auto-detect DNS name. Check: tailscale funnel status"
        }
    }
    else {
        Write-Host ""
        Write-Host "useTailscaleFunnel=false, Funnel is skipped."
        Write-Host "Local MCP URL path: http://localhost:$LocalPort/t/$Token/mcp"
    }

    Write-Host ""
    Write-Host "====== Starting MCP Server ======"
    Write-Host "Stop this server with Ctrl+C. Funnel and one-shot config will be cleaned up."
    Write-Host ""

    & npm.cmd run dev
    $exitCode = $LASTEXITCODE
}
catch {
    Write-Host ""
    Write-Host "[ERROR] Bound runtime failed:"
    Write-Host $_.Exception.Message
    $exitCode = 1
}
finally {
    Stop-GptRepoFunnel -HttpsPort $HttpsPort
    Remove-OneShotConfig -ConfigPath $RuntimeConfig

    Write-Host ""
    Write-Host "====== Runtime ended ======"
    Write-Host "ExitCode = $exitCode"
}

exit $exitCode
