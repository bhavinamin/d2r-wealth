[CmdletBinding()]
param(
    [string]$PrdPath = "PRD.md",
    [string]$ProgressPath = "progress.txt",
    [string]$RalphCommandTemplate = 'ralph run --cwd "{REPO_ROOT}" --prompt-file "{PROMPT_FILE}"',
    [string]$CommitPrefix = "ralph",
    [switch]$ShowPrompt
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
    $root = git rev-parse --show-toplevel 2>$null
    if (-not $root) {
        throw "This script must be run inside a git repository."
    }
    return $root.Trim()
}

function Assert-CleanWorktree {
    $status = git status --porcelain --untracked-files=no
    if ($status) {
        throw @"
Refusing to run with a dirty worktree.
Commit, stash, or clean tracked changes first so this script does not accidentally include unrelated work.
"@
    }
}

function Resolve-ExistingPath([string]$RepoRoot, [string]$PathValue, [string]$Label) {
    $candidate = if ([System.IO.Path]::IsPathRooted($PathValue)) {
        $PathValue
    } else {
        Join-Path $RepoRoot $PathValue
    }

    $resolved = [System.IO.Path]::GetFullPath($candidate)
    if (-not (Test-Path -LiteralPath $resolved)) {
        throw "$Label not found: $resolved"
    }
    return $resolved
}

function Get-CompletedTasks([string]$ProgressFile) {
    $completed = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    if (-not (Test-Path -LiteralPath $ProgressFile)) {
        return $completed
    }

    foreach ($line in Get-Content -LiteralPath $ProgressFile) {
        if ($line -match '^\s*TASK:\s*(.+?)\s*$') {
            [void]$completed.Add($matches[1].Trim())
        }
    }

    return $completed
}

function Get-NextTask([string]$PrdFile, $CompletedTasks) {
    $checkboxPattern = '^\s*[-*]\s*\[(?<done>[ xX])\]\s*(?<task>.+?)\s*$'
    foreach ($line in Get-Content -LiteralPath $PrdFile) {
        if ($line -match $checkboxPattern) {
            $isDone = $matches['done'] -match '[xX]'
            $task = $matches['task'].Trim()
            if (-not $isDone -and -not $CompletedTasks.Contains($task)) {
                return $task
            }
        }
    }

    throw "No incomplete markdown checkbox task was found in $PrdFile after filtering completed progress entries."
}

function Read-ContextFile([string]$PathValue, [string]$Heading) {
    $content = Get-Content -LiteralPath $PathValue -Raw
    return @"
===== $Heading =====
$content
"@
}

function New-RalphPrompt {
    param(
        [string]$RepoRoot,
        [string]$PrdFile,
        [string]$ProgressFile,
        [string]$Task
    )

    $contextBlocks = @(
        Read-ContextFile -PathValue (Join-Path $RepoRoot "agents\frontend-ui-agent.md") -Heading "agents/frontend-ui-agent.md"
        Read-ContextFile -PathValue (Join-Path $RepoRoot "agents\parser-data-agent.md") -Heading "agents/parser-data-agent.md"
        Read-ContextFile -PathValue (Join-Path $RepoRoot "agents\validation-agent.md") -Heading "agents/validation-agent.md"
        Read-ContextFile -PathValue (Join-Path $RepoRoot "skills\save-import-workflow.md") -Heading "skills/save-import-workflow.md"
        Read-ContextFile -PathValue (Join-Path $RepoRoot "skills\market-normalization-workflow.md") -Heading "skills/market-normalization-workflow.md"
        Read-ContextFile -PathValue $PrdFile -Heading "PRD"
        if (Test-Path -LiteralPath $ProgressFile) {
            Read-ContextFile -PathValue $ProgressFile -Heading "progress.txt"
        } else {
            "===== progress.txt =====`nThe progress file does not exist yet."
        }
    )

    return @"
You are Ralph running a single implementation loop inside this repository: $RepoRoot

Selected task:
$Task

Execution contract:
1. Read the PRD and progress context below.
2. Implement only the selected task above.
3. Do not start a second task, even if the first one finishes quickly.
4. Follow the agent and workflow guidance below when making changes.
5. Do not commit, amend commits, or update progress.txt; the wrapper script will handle that after you finish.
6. Keep edits scoped to the selected task and leave the repo in a buildable state if practical.
7. If you need to add notes for the wrapper operator, write them to stdout at the end under a short heading named NOTES.

Task selection rule used by the wrapper:
- first unchecked markdown checkbox task in the PRD
- excluding tasks already logged as completed in progress.txt

Project context:

$($contextBlocks -join "`n`n")
"@
}

function Invoke-Ralph([string]$CommandTemplate, [string]$RepoRoot, [string]$PromptFile) {
    $expanded = $CommandTemplate.Replace("{REPO_ROOT}", $RepoRoot).Replace("{PROMPT_FILE}", $PromptFile)
    Write-Host "Running: $expanded"
    & cmd.exe /d /s /c $expanded
    if ($LASTEXITCODE -ne 0) {
        throw "Ralph command failed with exit code $LASTEXITCODE."
    }
}

function Get-ChangedPaths {
    $paths = @()
    foreach ($line in (git status --porcelain)) {
        if (-not $line) {
            continue
        }

        $pathText = $line.Substring(3)
        if ($pathText.Contains(" -> ")) {
            $pathText = $pathText.Split(" -> ")[1]
        }
        $paths += $pathText.Trim()
    }
    return $paths | Sort-Object -Unique
}

function New-CommitMessage([string]$Prefix, [string]$Task) {
    $sanitized = ($Task -replace '\s+', ' ').Trim()
    return "$Prefix: $sanitized"
}

function Append-ProgressEntry {
    param(
        [string]$ProgressFile,
        [string]$Task,
        [string[]]$ChangedPaths
    )

    if (-not (Test-Path -LiteralPath $ProgressFile)) {
        New-Item -ItemType File -Path $ProgressFile | Out-Null
    }

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    $entryLines = @(
        "[$timestamp] TASK: $Task"
    )

    if ($ChangedPaths.Count -gt 0) {
        $entryLines += "FILES:"
        $entryLines += $ChangedPaths | ForEach-Object { " - $_" }
    }

    $entryLines += ""
    Add-Content -LiteralPath $ProgressFile -Value $entryLines
}

$repoRoot = Resolve-RepoRoot
Assert-CleanWorktree

$prdFile = Resolve-ExistingPath -RepoRoot $repoRoot -PathValue $PrdPath -Label "PRD file"
$progressFile = if ([System.IO.Path]::IsPathRooted($ProgressPath)) {
    [System.IO.Path]::GetFullPath($ProgressPath)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $repoRoot $ProgressPath))
}

$completedTasks = Get-CompletedTasks -ProgressFile $progressFile
$task = Get-NextTask -PrdFile $prdFile -CompletedTasks $completedTasks

$prompt = New-RalphPrompt -RepoRoot $repoRoot -PrdFile $prdFile -ProgressFile $progressFile -Task $task

if ($ShowPrompt) {
    Write-Host $prompt
}

$tempPromptFile = Join-Path ([System.IO.Path]::GetTempPath()) ("ralph-once-" + [System.Guid]::NewGuid().ToString() + ".txt")
Set-Content -LiteralPath $tempPromptFile -Value $prompt -Encoding UTF8

try {
    Invoke-Ralph -CommandTemplate $RalphCommandTemplate -RepoRoot $repoRoot -PromptFile $tempPromptFile

    $changedPaths = Get-ChangedPaths
    if (-not $changedPaths -or $changedPaths.Count -eq 0) {
        throw "Ralph completed without producing any file changes."
    }

    $commitMessage = New-CommitMessage -Prefix $CommitPrefix -Task $task
    Append-ProgressEntry -ProgressFile $progressFile -Task $task -ChangedPaths $changedPaths

    git add -- $changedPaths
    git add -- $progressFile
    git commit -m $commitMessage | Out-Null
    $commitSha = (git rev-parse --short HEAD).Trim()

    Write-Host "Completed task: $task"
    Write-Host "Commit: $commitSha"
} finally {
    if (Test-Path -LiteralPath $tempPromptFile) {
        Remove-Item -LiteralPath $tempPromptFile -Force
    }
}
