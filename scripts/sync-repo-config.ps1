param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectDir,

    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,

    [string]$RepoMode = "read",
    [string]$AllowNonGit = "True",
    [string]$IncludeChildDirs = "True",
    [string]$OutputConfig = ""
)

$ErrorActionPreference = "Stop"

function ConvertTo-Bool {
    param([string]$Value, [bool]$Default)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $Default
    }
    return $Value -ieq "true"
}

function ConvertTo-RepoId {
    param([string]$Name)

    $repoId = $Name.ToLowerInvariant() -replace "[^a-z0-9]+", "-"
    $repoId = $repoId.Trim("-")
    if ([string]::IsNullOrWhiteSpace($repoId)) {
        return "repo"
    }
    return $repoId
}

function New-ModeConfig {
    param([string]$Mode)

    $normalized = $Mode.ToLowerInvariant()
    if ($normalized -eq "read") {
        return @{
            writes = @{ enabled = $false }
            operations = @{ enabled = $false }
        }
    }

    if ($normalized -eq "write") {
        return @{
            writes = @{
                enabled = $true
                allowed_globs = @("**")
            }
            operations = @{ enabled = $false }
        }
    }

    if ($normalized -eq "ship") {
        return @{
            writes = @{
                enabled = $true
                allowed_globs = @("**")
            }
            operations = @{
                enabled = $true
                git_stage_enabled = $true
                git_commit_enabled = $true
                cleanup_enabled = $true
            }
        }
    }

    throw "Invalid repoMode '$Mode'. Expected read, write, or ship."
}

function Test-GitRoot {
    param([string]$Path)

    return Test-Path -LiteralPath (Join-Path $Path ".git")
}

function New-RepoConfig {
    param(
        [string]$Path,
        [string]$RepoId,
        [string]$DisplayName,
        [hashtable]$ModeConfig,
        [bool]$AllowNonGitRepo
    )

    $config = [ordered]@{
        repo_id = $RepoId
        display_name = $DisplayName
        root = $Path
        writes = $ModeConfig.writes
        operations = $ModeConfig.operations
    }

    if ($AllowNonGitRepo) {
        $config.allow_non_git = $true
    }

    return $config
}

$allowNonGitBool = ConvertTo-Bool -Value $AllowNonGit -Default $true
$includeChildDirsBool = ConvertTo-Bool -Value $IncludeChildDirs -Default $true
$repoRootItem = Get-Item -LiteralPath $RepoRoot

if (-not $repoRootItem.PSIsContainer) {
    throw "RepoRoot is not a directory: $RepoRoot"
}

if (-not $allowNonGitBool -and -not (Test-GitRoot -Path $repoRootItem.FullName)) {
    throw "RepoRoot is not a git repository. Set allowNonGit=true to expose non-git folders."
}

$modeConfig = New-ModeConfig -Mode $RepoMode
$baseId = ConvertTo-RepoId -Name $repoRootItem.Name
$usedIds = @{}
$repos = New-Object System.Collections.Generic.List[object]

function Add-Repo {
    param(
        [string]$Path,
        [string]$PreferredId,
        [string]$DisplayName,
        [bool]$AllowNonGitRepo
    )

    $repoId = $PreferredId
    $suffix = 2
    while ($script:usedIds.ContainsKey($repoId)) {
        $repoId = "$PreferredId-$suffix"
        $suffix += 1
    }

    $script:usedIds[$repoId] = $true
    $script:repos.Add((New-RepoConfig -Path $Path -RepoId $repoId -DisplayName $DisplayName -ModeConfig $script:modeConfig -AllowNonGitRepo $AllowNonGitRepo))
}

Add-Repo -Path $repoRootItem.FullName -PreferredId $baseId -DisplayName $repoRootItem.Name -AllowNonGitRepo $allowNonGitBool

if ($includeChildDirsBool) {
    $children = Get-ChildItem -LiteralPath $repoRootItem.FullName -Directory -Force |
        Where-Object { $_.Name -notin @(".git", "node_modules") } |
        Sort-Object Name

    foreach ($child in $children) {
        $childIsGit = Test-GitRoot -Path $child.FullName
        if (-not $allowNonGitBool -and -not $childIsGit) {
            Write-Host "[WARN] Skip non-git child folder because allowNonGit=false: $($child.FullName)"
            continue
        }

        $childId = "$baseId-$(ConvertTo-RepoId -Name $child.Name)"
        Add-Repo -Path $child.FullName -PreferredId $childId -DisplayName "$($repoRootItem.Name)/$($child.Name)" -AllowNonGitRepo ($allowNonGitBool -or -not $childIsGit)
    }
}

$config = [ordered]@{
    repos = $repos.ToArray()
    limits = [ordered]@{
        max_files = 50
        max_bytes_per_file = 128000
        max_total_bytes = 750000
        max_tree_entries = 5000
        max_depth = 16
    }
}

$configPath = if ([string]::IsNullOrWhiteSpace($OutputConfig)) {
    Join-Path $ProjectDir "config.local.json"
} else {
    $OutputConfig
}

$configParent = Split-Path -Parent $configPath
if (-not [string]::IsNullOrWhiteSpace($configParent) -and -not (Test-Path -LiteralPath $configParent)) {
    New-Item -ItemType Directory -Path $configParent | Out-Null
}

$json = $config | ConvertTo-Json -Depth 20
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configPath, $json, $utf8NoBom)

Write-Host "Wrote $configPath"
Write-Host "Visible repositories:"
foreach ($repo in $repos) {
    Write-Host "- $($repo.repo_id): $($repo.root)"
}
