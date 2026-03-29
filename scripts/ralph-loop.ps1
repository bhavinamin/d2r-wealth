[CmdletBinding()]
param(
    [string]$RalphOncePath = ".\scripts\ralph-once.ps1",
    [int]$MaxLoops = 25,
    [int]$MaxRecoveryAttempts = 2,
    [int]$RetryDelaySeconds = 10,
    [int]$CiPollSeconds = 20,
    [string]$RemoteName = "origin",
    [string]$NotificationHandle = "",
    [int]$PrWaitMinutes = 60
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

function Get-LatestFailedCiRun([string]$BranchName) {
    $runsJson = gh run list --branch $BranchName --json databaseId,status,conclusion,workflowName,url,headBranch --limit 20
    $runs = @()
    if ($runsJson) {
        $runs = $runsJson | ConvertFrom-Json
    }

    return @($runs |
        Where-Object { $_.workflowName -eq "CI" -and $_.status -eq "completed" -and $_.conclusion -eq "failure" } |
        Select-Object -First 1)
}

function Get-OpenPrForBranch([string]$BranchName) {
    $prsJson = gh pr list --state open --head $BranchName --json number,url,title,isDraft --limit 20
    $prs = @()
    if ($prsJson) {
        $prs = $prsJson | ConvertFrom-Json
    }
    return @($prs | Select-Object -First 1)
}

function Get-PrChecksState([string]$BranchName) {
    $prJson = gh pr view $BranchName --json url,state,mergedAt,closed,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup
    $pr = $prJson | ConvertFrom-Json

    $checksState = "not_reported"
    if ($pr.statusCheckRollup) {
        $states = New-Object System.Collections.Generic.List[string]
        foreach ($check in @($pr.statusCheckRollup)) {
            if ($check.state) {
                [void]$states.Add([string]$check.state)
                continue
            }

            if ($check.status -and $check.status -ne "COMPLETED") {
                [void]$states.Add("PENDING")
                continue
            }

            if ($check.conclusion) {
                switch ([string]$check.conclusion) {
                    "SUCCESS" { [void]$states.Add("SUCCESS") }
                    "NEUTRAL" { [void]$states.Add("SUCCESS") }
                    "SKIPPED" { [void]$states.Add("SUCCESS") }
                    "FAILURE" { [void]$states.Add("FAILURE") }
                    "ERROR" { [void]$states.Add("ERROR") }
                    "TIMED_OUT" { [void]$states.Add("FAILURE") }
                    "ACTION_REQUIRED" { [void]$states.Add("FAILURE") }
                    "CANCELLED" { [void]$states.Add("FAILURE") }
                    default { [void]$states.Add([string]$check.conclusion) }
                }
            }
        }

        if ($states.Count -gt 0) {
            if ($states -contains "FAILURE" -or $states -contains "ERROR") {
                $checksState = "failing"
            } elseif ($states -contains "PENDING" -or $states -contains "EXPECTED") {
                $checksState = "pending"
            } elseif ($states -contains "SUCCESS") {
                $checksState = "passing"
            } else {
                $checksState = ($states | Select-Object -First 1)
            }
        }
    }

    return [pscustomobject]@{
        url = [string]$pr.url
        state = [string]$pr.state
        mergedAt = [string]$pr.mergedAt
        closed = [bool]$pr.closed
        isDraft = [bool]$pr.isDraft
        reviewDecision = [string]$pr.reviewDecision
        mergeStateStatus = [string]$pr.mergeStateStatus
        checksState = $checksState
    }
}

function Wait-ForPrOutcome([string]$BranchName, [int]$PollSeconds, [int]$MaxWaitMinutes) {
    $deadline = (Get-Date).AddMinutes($MaxWaitMinutes)

    while ($true) {
        $status = Get-PrChecksState -BranchName $BranchName

        if ($status.mergedAt) {
            return [pscustomobject]@{
                merged = $true
                diagnosis = "PR merged: $($status.url)"
            }
        }

        if ($status.state -eq "CLOSED" -or ($status.closed -and -not $status.mergedAt)) {
            return [pscustomobject]@{
                merged = $false
                diagnosis = "PR closed without merge: $($status.url)"
            }
        }

        if ($status.reviewDecision -eq "CHANGES_REQUESTED") {
            return [pscustomobject]@{
                merged = $false
                diagnosis = "PR review is requesting changes: $($status.url)"
            }
        }

        if ($status.checksState -eq "failing") {
            return [pscustomobject]@{
                merged = $false
                diagnosis = "PR checks are failing: $($status.url)"
            }
        }

        if ((Get-Date) -gt $deadline) {
            return [pscustomobject]@{
                merged = $false
                diagnosis = "Timed out waiting for PR completion: $($status.url)"
            }
        }

        Write-Host "Waiting for PR checks/merge: $($status.url) (checks=$($status.checksState), mergeState=$($status.mergeStateStatus))"
        Start-Sleep -Seconds $PollSeconds
    }
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

function Test-DefaultBranchReady([string]$RemoteName, [string]$DefaultBranch, [int]$PollSeconds) {
    try {
        Ensure-DefaultBranchReady -RemoteName $RemoteName -DefaultBranch $DefaultBranch
        Wait-ForDefaultBranchCi -DefaultBranch $DefaultBranch -PollSeconds $PollSeconds
        Ensure-DefaultBranchReady -RemoteName $RemoteName -DefaultBranch $DefaultBranch
        return $true
    } catch {
        return $false
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

function Get-AllStatusPaths {
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

function Get-NewStatusPaths([string[]]$BaselinePaths) {
    $baseline = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $BaselinePaths) {
        if ($path) {
            [void]$baseline.Add($path)
        }
    }

    $newPaths = @()
    foreach ($path in (Get-AllStatusPaths)) {
        if (-not $baseline.Contains($path)) {
            $newPaths += $path
        }
    }

    return $newPaths | Sort-Object -Unique
}

function Get-FailureLogText([string]$BranchName) {
    $run = Get-LatestFailedCiRun -BranchName $BranchName
    if ($run.Count -eq 0) {
        return ""
    }

    $tempLogFile = Join-Path ([System.IO.Path]::GetTempPath()) ("ralph-loop-failed-run-" + [System.Guid]::NewGuid().ToString() + ".txt")
    try {
        & cmd.exe /d /s /c "gh run view $($run[0].databaseId) --log-failed 2>&1" | Tee-Object -FilePath $tempLogFile | Out-Null
        if (Test-Path -LiteralPath $tempLogFile) {
            return Get-Content -LiteralPath $tempLogFile -Raw
        }
        return ""
    } finally {
        if (Test-Path -LiteralPath $tempLogFile) {
            Remove-Item -LiteralPath $tempLogFile -Force
        }
    }
}

function Ensure-RepairBranch([string]$DefaultBranch) {
    $currentBranch = Get-CurrentBranch
    if ($currentBranch -ne $DefaultBranch) {
        return [pscustomobject]@{
            branchName = $currentBranch
            created = $false
        }
    }

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $branchName = "fix/ci-repair-$timestamp"
    git switch -c $branchName | Out-Null
    return [pscustomobject]@{
        branchName = $branchName
        created = $true
    }
}

function Ensure-RepairPr([string]$BranchName, [string]$DefaultBranch, [string]$Diagnosis) {
    $existingPr = Get-OpenPrForBranch -BranchName $BranchName
    if ($existingPr.Count -gt 0) {
        gh pr ready $BranchName | Out-Null
        gh pr merge $BranchName --auto --squash --delete-branch | Out-Null
        return $existingPr[0]
    }

    $safeDiagnosis = if ($Diagnosis) { $Diagnosis } else { "Repair failed autonomous CI/check state." }
    $title = "repair: unblock autonomous CI"
    $body = @"
## Summary
- Repair autonomous CI/check failures blocking the Ralph loop

## Context
- $safeDiagnosis
"@

    $prUrl = "$(gh pr create --base $DefaultBranch --head $BranchName --title $title --body $body)".Trim()
    gh pr ready $BranchName | Out-Null
    gh pr merge $BranchName --auto --squash --delete-branch | Out-Null
    return [pscustomobject]@{
        url = $prUrl
        title = $title
    }
}

function Invoke-Verification {
    Write-Host "Running: powershell -ExecutionPolicy Bypass -File .\\scripts\\verify.ps1"
    powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1
    if ($LASTEXITCODE -ne 0) {
        throw "Repair verification failed with exit code $LASTEXITCODE."
    }
}

function Invoke-RepairAttempt([string]$RepoRoot, [string]$DefaultBranch, [string]$RemoteName, [string]$FailureOutputFile, [string]$Diagnosis, [int]$PollSeconds, [int]$MaxWaitMinutes) {
    $repairBranch = Ensure-RepairBranch -DefaultBranch $DefaultBranch
    $branchName = $repairBranch.branchName
    $baselinePaths = @(Get-AllStatusPaths)
    $failureTranscript = Get-Content -LiteralPath $FailureOutputFile -Raw
    $failedRunLog = Get-FailureLogText -BranchName $branchName
    if (-not $failedRunLog -and $branchName -ne $DefaultBranch) {
        $failedRunLog = Get-FailureLogText -BranchName $DefaultBranch
    }

    $prompt = @"
You are repairing a failed autonomous Ralph run in this repository: $RepoRoot

Target branch:
- $branchName

Constraints:
- Fix only the failure reflected in the logs below.
- Do not start a new PRD task.
- Do not switch branches, create issues, or update progress.txt.
- You may edit code, tests, or GitHub workflow files as needed to make the failure pass.
- Leave the repository ready for local verification.
- End stdout with:
NOTES
HUMAN_REQUIRED: yes|no
HUMAN_REASON: <short reason if needed>

Supervisor diagnosis:
$Diagnosis

Local failure transcript:
$failureTranscript

Latest failed CI log:
$failedRunLog
"@

    $repairOutputFile = Join-Path ([System.IO.Path]::GetTempPath()) ("ralph-loop-repair-" + [System.Guid]::NewGuid().ToString() + ".txt")
    try {
        $prompt | codex exec - -C $RepoRoot --dangerously-bypass-approvals-and-sandbox | Tee-Object -FilePath $repairOutputFile | Out-Null
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{
                resolved = $false
                diagnosis = "Codex repair command failed."
            }
        }

        $changedPaths = @(Get-NewStatusPaths -BaselinePaths $baselinePaths)
        if ($changedPaths.Count -eq 0) {
            if (Test-DefaultBranchReady -RemoteName $RemoteName -DefaultBranch $DefaultBranch -PollSeconds $PollSeconds) {
                return [pscustomobject]@{
                    resolved = $true
                    diagnosis = "Default branch is already green; no additional repair diff was needed."
                }
            }

            return [pscustomobject]@{
                resolved = $false
                diagnosis = "Codex repair produced no file changes."
            }
        }

        Invoke-Verification

        git add -- $changedPaths
        git commit -m "repair: unblock autonomous loop failure" | Out-Null
        git push -u $RemoteName $branchName | Out-Null

        $pr = Ensure-RepairPr -BranchName $branchName -DefaultBranch $DefaultBranch -Diagnosis $Diagnosis
        $outcome = Wait-ForPrOutcome -BranchName $branchName -PollSeconds $PollSeconds -MaxWaitMinutes $MaxWaitMinutes
        return [pscustomobject]@{
            resolved = [bool]$outcome.merged
            diagnosis = $outcome.diagnosis
            prUrl = if ($pr.url) { $pr.url } else { "" }
        }
    } finally {
        if (Test-Path -LiteralPath $repairOutputFile) {
            Remove-Item -LiteralPath $repairOutputFile -Force
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

    try {
        Ensure-DefaultBranchReady -RemoteName $RemoteName -DefaultBranch $defaultBranch
        Wait-ForDefaultBranchCi -DefaultBranch $defaultBranch -PollSeconds $CiPollSeconds
        Ensure-DefaultBranchReady -RemoteName $RemoteName -DefaultBranch $defaultBranch
        } catch {
            $preflightFailureFile = [System.IO.Path]::GetTempFileName()
            try {
                Set-Content -LiteralPath $preflightFailureFile -Value $_.Exception.Message -Encoding UTF8
                $repair = Invoke-RepairAttempt -RepoRoot $repoRoot -DefaultBranch $defaultBranch -RemoteName $RemoteName -FailureOutputFile $preflightFailureFile -Diagnosis $_.Exception.Message -PollSeconds $CiPollSeconds -MaxWaitMinutes $PrWaitMinutes
            } finally {
                if (Test-Path -LiteralPath $preflightFailureFile) {
                    Remove-Item -LiteralPath $preflightFailureFile -Force
                }
            }
            if (-not $repair.resolved -and (Test-DefaultBranchReady -RemoteName $RemoteName -DefaultBranch $defaultBranch -PollSeconds $CiPollSeconds)) {
                $repair = [pscustomobject]@{
                    resolved = $true
                    diagnosis = "Default branch CI recovered while the repair path was evaluating."
                }
            }
            if (-not $repair.resolved) {
                Send-GitHubNotification -Handle $NotificationHandle -Message @"
human attention is required for the autonomous Ralph loop.

Loop:
- iteration $loopCount of $MaxLoops

Diagnosis:
- $($repair.diagnosis)

Repository:
- $($repoInfo.nameWithOwner)
- branch: $defaultBranch
"@
            throw "Autonomous loop blocked before task start. A GitHub notification was posted."
        }
        continue
    }

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

            if ($assessment.retryRecommended -and -not $assessment.humanRequired) {
                Start-Sleep -Seconds $RetryDelaySeconds
                Ensure-DefaultBranchReady -RemoteName $RemoteName -DefaultBranch $defaultBranch
                continue
            }

            $repair = Invoke-RepairAttempt -RepoRoot $repoRoot -DefaultBranch $defaultBranch -RemoteName $RemoteName -FailureOutputFile $runOutputFile -Diagnosis $lastDiagnosis -PollSeconds $CiPollSeconds -MaxWaitMinutes $PrWaitMinutes
            $lastDiagnosis = $repair.diagnosis
            if ($repair.resolved) {
                $success = $true
                break
            }
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
