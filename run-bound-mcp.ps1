# Deprecated compatibility wrapper.
# The maintained implementation lives in scripts/run-bound-mcp.ps1.

$scriptPath = Join-Path $PSScriptRoot "scripts\run-bound-mcp.ps1"
if (-not (Test-Path -LiteralPath $scriptPath)) {
    Write-Error "Maintained script not found: $scriptPath"
    exit 1
}

& $scriptPath @args
exit $LASTEXITCODE
