[CmdletBinding()]
param(
    [string]$RalphOncePath = ".\scripts\ralph-once.ps1",
    [int]$MaxLoops = 25,
    [int]$MaxRecoveryAttempts = 2,
    [int]$RetryDelaySeconds = 10,
    [int]$CiPollSeconds = 20,
    [string]$RemoteName = "origin",
    [string]$NotificationHandle = ""
)

$ErrorActionPreference = "Stop"

function Assert-CommandAvailable([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found on PATH: $Name"
    }
}

function Resolve-RepoRoot {
    $root = git rev-parse --show-toplevel 2>$null
    if (-not $root) {
        throw "This script must be run inside a git repository."
    }
    return "$root".Trim()
}

function Resolve-PathInRepo([string]$RepoRoot, [string]$PathValue) {
    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return [System.IO.Path]::GetFullPath($PathValue)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $PathValue))
}

function Resolve-ExistingPath([string]$RepoRoot, [string]$PathValue, [string]$Label) {
    $resolved = Resolve-PathInRepo -RepoRoot $RepoRoot -PathValue $PathValue
    if (-not (Test-Path -LiteralPath $resolved)) {
        throw "$Label not found: $resolved"
    }
    return $resolved
}

function Get-RepoInfo {
    $repoInfoJson = gh repo view --json nameWithOwner,defaultBranchRef
    return $repoInfoJson | ConvertFrom-Json
}

function Get-GitHubLogin {
    return "$(gh api user --jq .login)".Trim()
}

function Get-CurrentBranch {
    return "$(git rev-parse --abbrev-ref HEAD)".Trim()
}

function Get-TrackedStatus {
    return @(git status --porcelain --untracked-files=no)
}

function Ensure-DefaultBranchReady([string]$RemoteName, [string]$DefaultBranch) {
    $trackedStatus = Get-TrackedStatus
    if ($trackedStatus.Count -gt 0) {
        throw "Tracked changes are present. Resolve them before running the loop supervisor."
    }

    $currentBranch = Get-CurrentBranch
    if ($currentBranch -ne $DefaultBranch) {
        git switch $DefaultBranch | Out-Null
    }

    git fetch $RemoteName $DefaultBranch | Out-Null
    git pull --ff-only $RemoteName $DefaultBranch | Out-Null
}

function Get-DefaultBranchCiRuns([string]$DefaultBranch) {
    $runsJson = gh run list --branch $DefaultBranch --json databaseId,status,conclusion,workflowName,url --limit 20
    $runs = @()
    if ($runsJson) {
        $runs = $runsJson | ConvertFrom-Json
    }
    return @($runs | Where-Object { $_.workflowName -eq "CI" })
}

function Wait-ForDefaultBranchCi([string]$DefaultBranch, [int]$PollSeconds) {
    while ($true) {
        $runs = Get-DefaultBranchCiRuns -DefaultBranch $DefaultBranch
        $activeRuns = @($runs | Where-Object { $_.status -ne "completed" })
        if ($activeRuns.Count -eq 0) {
            break
        }

        Write-Host "Waiting for $($activeRuns.Count) CI run(s) on '$DefaultBranch' to finish..."
        Start-Sleep -Seconds $PollSeconds
    }

    $latestCompleted = @(Get-DefaultBranchCiRuns -DefaultBranch $DefaultBranch | Where-Object { $_.status -eq "completed" } | Select-Object -First 1)
    if ($latestCompleted.Count -gt 0 -and $latestCompleted[0].conclusion -ne "success") {
        $run = $latestCompleted[0]
        throw "Default branch CI is red on '$DefaultBranch': $($run.url)"
    }
}

function Invoke-LoggedPowerShellFile([string]$ScriptPath, [string[]]$Arguments, [string]$OutputFile) {
    $joinedArguments = if ($Arguments -and $Arguments.Count -gt 0) { $Arguments -join " " } else { "" }
    $command = "powershell -ExecutionPolicy Bypass -File `"$ScriptPath`" $joinedArguments".Trim()
    Write-Host "Running: $command"
    $cmdCommand = "powershell -ExecutionPolicy Bypass -File ""$ScriptPath"""
    if ($joinedArguments) {
        $cmdCommand += " $joinedArguments"
    }

    & cmd.exe /d /s /c "$cmdCommand 2>&1" | Tee-Object -FilePath $OutputFile
    return $LASTEXITCODE
}

function Test-NoTasksRemain([string]$OutputText) {
    return $OutputText -match 'No incomplete markdown checkbox task was found'
}

function Test-TaskCompletedOutput([string]$OutputText) {
    return $OutputText -match '(?m)^Completed task:\s+'
}

function Get-RecoveryAssessment([string]$RepoRoot, [string]$FailureOutputFile) {
    $assessmentFile = Join-Path ([System.IO.Path]::GetTempPath()) ("ralph-loop-recovery-" + [System.Guid]::NewGuid().ToString() + ".txt")

    $prompt = @"
You are diagnosing a failed autonomous Ralph loop in this repository: $RepoRoot

Constraints:
- Do not modify files.
- Do not create commits, branches, issues, or PRs.
- Read local repo state only as needed.
- Determine whether the failure looks transient enough to retry automatically.

Failure transcript:
$(Get-Content -LiteralPath $FailureOutputFile -Raw)

Reply with exactly:
RECOVERY
RETRY_RECOMMENDED: yes|no
HUMAN_REQUIRED: yes|no
DIAGNOSIS: <one short line>
"@

    try {
        $prompt | codex exec - -C $RepoRoot --dangerously-bypass-approvals-and-sandbox | Tee-Object -FilePath $assessmentFile | Out-Null
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{
                retryRecommended = $false
                humanRequired = $true
                diagnosis = "Codex recovery triage failed."
            }
        }

        $content = Get-Content -LiteralPath $assessmentFile -Raw
        $retry = [regex]::Match($content, '(?im)^\s*RETRY_RECOMMENDED:\s*(yes|no)\s*$')
        $human = [regex]::Match($content, '(?im)^\s*HUMAN_REQUIRED:\s*(yes|no)\s*$')
        $diagnosis = [regex]::Match($content, '(?im)^\s*DIAGNOSIS:\s*(.+?)\s*$')

        return [pscustomobject]@{
            retryRecommended = $retry.Success -and $retry.Groups[1].Value.ToLowerInvariant() -eq "yes"
            humanRequired = (-not $human.Success) -or $human.Groups[1].Value.ToLowerInvariant() -eq "yes"
            diagnosis = if ($diagnosis.Success) { $diagnosis.Groups[1].Value.Trim() } else { "No diagnosis provided." }
        }
    } finally {
        if (Test-Path -LiteralPath $assessmentFile) {
            Remove-Item -LiteralPath $assessmentFile -Force
        }
    }
}

function Ensure-NotificationIssue([string]$Title) {
    $existingJson = gh issue list --state open --search "$Title in:title" --json number,title,url --limit 20
    $existing = @()
    if ($existingJson) {
        $existing = $existingJson | ConvertFrom-Json
    }

    $exact = $existing | Where-Object { $_.title -eq $Title } | Select-Object -First 1
    if ($exact) {
        return $exact
    }

    $body = @"
Autonomous Ralph loop escalation issue.

The supervisor opens or updates this issue only when autonomous retries stop making progress and a human needs to inspect the failure.
"@
    $url = "$(gh issue create --title $Title --body $body)".Trim()
    if ($url -match '/(?<num>\d+)$') {
        return [pscustomobject]@{
            number = [int]$matches['num']
            title = $Title
            url = $url
        }
    }

    throw "Unable to create notification issue."
}

function Send-GitHubNotification([string]$Handle, [string]$Message) {
    $issue = Ensure-NotificationIssue -Title "Autonomous loop blocked"
    $tempMessageFile = Join-Path ([System.IO.Path]::GetTempPath()) ("ralph-loop-notify-" + [System.Guid]::NewGuid().ToString() + ".txt")
    $mention = if ($Handle) { "@$Handle " } else { "" }

    try {
        Set-Content -LiteralPath $tempMessageFile -Value ($mention + $Message) -Encoding UTF8
        gh issue comment $issue.number --body-file $tempMessageFile | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to post loop notification comment."
        }
        Write-Host "Notification issue: $($issue.url)"
    } finally {
        if (Test-Path -LiteralPath $tempMessageFile) {
            Remove-Item -LiteralPath $tempMessageFile -Force
        }
    }
}

Assert-CommandAvailable -Name "git"
Assert-CommandAvailable -Name "gh"
Assert-CommandAvailable -Name "codex"

$repoRoot = Resolve-RepoRoot
$ralphOnce = Resolve-ExistingPath -RepoRoot $repoRoot -PathValue $RalphOncePath -Label "Ralph once script"
$repoInfo = Get-RepoInfo
$defaultBranch = $repoInfo.defaultBranchRef.name
if (-not $NotificationHandle) {
    $NotificationHandle = Get-GitHubLogin
}

$loopCount = 0

while ($loopCount -lt $MaxLoops) {
    $loopCount += 1
    Write-Host "Loop $loopCount of $MaxLoops"

    Ensure-DefaultBranchReady -RemoteName $RemoteName -DefaultBranch $defaultBranch
    Wait-ForDefaultBranchCi -DefaultBranch $defaultBranch -PollSeconds $CiPollSeconds
    Ensure-DefaultBranchReady -RemoteName $RemoteName -DefaultBranch $defaultBranch

    $success = $false
    $lastDiagnosis = ""

    for ($attempt = 0; $attempt -le $MaxRecoveryAttempts; $attempt++) {
        $runOutputFile = Join-Path ([System.IO.Path]::GetTempPath()) ("ralph-loop-run-" + [System.Guid]::NewGuid().ToString() + ".txt")

        try {
            $exitCode = Invoke-LoggedPowerShellFile -ScriptPath $ralphOnce -Arguments @() -OutputFile $runOutputFile
            $outputText = if (Test-Path -LiteralPath $runOutputFile) { Get-Content -LiteralPath $runOutputFile -Raw } else { "" }

            if ($exitCode -eq 0) {
                $success = $true
                break
            }

             if (Test-TaskCompletedOutput -OutputText $outputText) {
                $success = $true
                break
            }

            if (Test-NoTasksRemain -OutputText $outputText) {
                Write-Host "No remaining PRD tasks."
                exit 0
            }

            if ($attempt -ge $MaxRecoveryAttempts) {
                $lastDiagnosis = "Autonomous retries exhausted."
                break
            }

            $assessment = Get-RecoveryAssessment -RepoRoot $repoRoot -FailureOutputFile $runOutputFile
            $lastDiagnosis = $assessment.diagnosis
            Write-Host "Recovery diagnosis: $lastDiagnosis"

            if (-not $assessment.humanRequired -and -not $assessment.retryRecommended) {
                $success = $true
                break
            }

            if (-not $assessment.retryRecommended -or $assessment.humanRequired) {
                break
            }

            Start-Sleep -Seconds $RetryDelaySeconds
            Ensure-DefaultBranchReady -RemoteName $RemoteName -DefaultBranch $defaultBranch
        } finally {
            if (Test-Path -LiteralPath $runOutputFile) {
                Remove-Item -LiteralPath $runOutputFile -Force
            }
        }
    }

    if (-not $success) {
        $message = @"
human attention is required for the autonomous Ralph loop.

Loop:
- iteration $loopCount of $MaxLoops

Diagnosis:
- $lastDiagnosis

Repository:
- $($repoInfo.nameWithOwner)
- branch: $defaultBranch
"@
        Send-GitHubNotification -Handle $NotificationHandle -Message $message
        throw "Autonomous loop blocked after retries. A GitHub notification was posted."
    }
}

Write-Host "Reached MaxLoops=$MaxLoops. Stopping."
