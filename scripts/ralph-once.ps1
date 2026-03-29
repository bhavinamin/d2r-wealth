[CmdletBinding()]
param(
    [string]$PrdPath = "PRD.md",
    [string]$ProgressPath = "progress.txt",
    [string]$AgentCommandTemplate = "",
    [string]$VerificationCommand = ".\\scripts\\verify.ps1",
    [string]$CommitPrefix = "ralph",
    [string]$RemoteName = "origin",
    [string]$ReviewTriggerComment = "",
    [bool]$EnableAutoMerge = $true,
    [string]$NotificationHandle = "",
    [int]$PrPollSeconds = 20,
    [int]$PrWaitMinutes = 60,
    [switch]$ShowPrompt
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

function Assert-CleanTrackedWorktree {
    $status = git status --porcelain --untracked-files=no
    if ($status) {
        throw @"
Refusing to run with tracked modifications in the worktree.
Commit, stash, or clean tracked changes first so this script can create one issue-backed branch cleanly.
"@
    }
}

function Get-StatusPaths {
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

function Assert-OnDefaultBranch([string]$DefaultBranch) {
    $currentBranch = Get-CurrentBranch
    if ($currentBranch -ne $DefaultBranch) {
        throw "Start this automation from the default branch '$DefaultBranch'. Current branch: '$currentBranch'."
    }
}

function Sync-DefaultBranch([string]$RemoteName, [string]$DefaultBranch) {
    git fetch $RemoteName $DefaultBranch | Out-Null
    git pull --ff-only $RemoteName $DefaultBranch | Out-Null
}

function Get-CompletedTasks([string]$ProgressFile) {
    $completed = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    if (-not (Test-Path -LiteralPath $ProgressFile)) {
        return $completed
    }

    foreach ($line in Get-Content -LiteralPath $ProgressFile) {
        if ($line -match '^\s*(?:\[[^\]]+\]\s+)?TASK:\s*(.+?)\s*$') {
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
            $alreadyCompleted = $false
            if ($CompletedTasks) {
                $alreadyCompleted = @($CompletedTasks | Where-Object { $_ -eq $task }).Count -gt 0
            }
            if (-not $isDone -and -not $alreadyCompleted) {
                return $task
            }
        }
    }

    throw "No incomplete markdown checkbox task was found in $PrdFile after filtering completed progress entries."
}

function Convert-ToSlug([string]$Value) {
    $slug = $Value.ToLowerInvariant()
    $slug = $slug -replace '[^a-z0-9]+', '-'
    $slug = $slug.Trim('-')
    if (-not $slug) {
        $slug = "task"
    }
    if ($slug.Length -gt 48) {
        $slug = $slug.Substring(0, 48).Trim('-')
    }
    return $slug
}

function Find-OpenIssueByTitle([string]$Task) {
    $searchQuery = "$Task in:title"
    $issuesJson = gh issue list --state open --search $searchQuery --json number,title,url --limit 100
    $issues = @()
    if ($issuesJson) {
        $issues = $issuesJson | ConvertFrom-Json
    }
    return $issues | Where-Object { $_.title -eq $Task } | Select-Object -First 1
}

function New-IssueBody([string]$Task, [string]$PrdFile) {
    return @"
Generated from the PRD by the Ralph once-runner.

Task:
- $Task

Source:
- PRD: $PrdFile

Workflow contract:
- Implement exactly this task on its own branch.
- Run local verification before pushing.
- Open a PR that references and closes this issue on merge.
- Mark the PR ready for review and enable auto-merge after successful CI unless human follow-up is required.
- Treat unresolved GitHub review findings as merge blockers; address code review feedback before a PR is merged.
"@
}

function Get-IssueNumberFromUrl([string]$Url) {
    if ($Url -match '/(?<num>\d+)$') {
        return [int]$matches['num']
    }
    throw "Unable to parse issue number from URL: $Url"
}

function Ensure-Issue([string]$Task, [string]$PrdFile) {
    $issue = Find-OpenIssueByTitle -Task $Task
    if ($issue) {
        return $issue
    }

    $issueBody = New-IssueBody -Task $Task -PrdFile $PrdFile
    $issueUrl = "$(gh issue create --title $Task --body $issueBody)".Trim()
    return [pscustomobject]@{
        number = Get-IssueNumberFromUrl -Url $issueUrl
        title  = $Task
        url    = $issueUrl
    }
}

function Ensure-TaskBranch([string]$RemoteName, [int]$IssueNumber, [string]$Task) {
    $branchName = "task/$IssueNumber-$(Convert-ToSlug -Value $Task)"
    $localBranch = "$(git branch --list $branchName)".Trim()
    if ($localBranch) {
        git switch $branchName | Out-Null
        return $branchName
    }

    $remoteBranch = git ls-remote --heads $RemoteName $branchName
    if ($remoteBranch) {
        git switch -c $branchName --track "$RemoteName/$branchName" | Out-Null
        return $branchName
    }

    git switch -c $branchName | Out-Null
    return $branchName
}

function Read-ContextFile([string]$PathValue, [string]$Heading) {
    $content = Get-Content -LiteralPath $PathValue -Raw
    return @"
===== $Heading =====
$content
"@
}

function Get-VerificationCommand([string]$RepoRoot, [string]$ExplicitCommand) {
    if ($ExplicitCommand) {
        return $ExplicitCommand
    }
    return ".\\scripts\\verify.ps1"
}

function New-RalphPrompt {
    param(
        [string]$RepoRoot,
        [string]$PrdFile,
        [string]$ProgressFile,
        [string]$Task,
        [int]$IssueNumber,
        [string]$IssueUrl,
        [string]$BranchName,
        [string]$VerificationCommand
    )

    $verificationLine = if ($VerificationCommand) {
        "Local verification required before push: $VerificationCommand"
    } else {
        "No local verification command is configured by the wrapper; if you add tests, leave the repo in a state where the operator can run them."
    }

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

Tracking:
- GitHub issue: #$IssueNumber
- Issue URL: $IssueUrl
- Working branch: $BranchName

Execution contract:
1. Read the PRD and progress context below.
2. Implement only the selected task above and keep the work scoped to issue #$IssueNumber.
3. Do not start a second task, even if the first one finishes quickly.
4. Follow the agent and workflow guidance below when making changes.
5. Add or update focused tests when the repo already has a relevant test harness; otherwise keep the change buildable and note any verification gaps.
6. Do not create issues, switch branches, commit, push, open PRs, or update progress.txt; the wrapper script owns that workflow.
7. $verificationLine
8. If GitHub review findings already exist on the branch or PR, address them before considering the work ready for merge.
9. If you need human help, end stdout with exactly this machine-readable section:
NOTES
HUMAN_REQUIRED: yes
HUMAN_REASON: <short reason>

If no human help is needed, end stdout with:
NOTES
HUMAN_REQUIRED: no

Task selection rule used by the wrapper:
- first unchecked markdown checkbox task in the PRD
- excluding tasks already logged as completed in progress.txt

Project context:

$($contextBlocks -join "`n`n")
"@
}

function Invoke-ExternalCommand([string]$CommandText, [string]$FailureMessage) {
    Write-Host "Running: $CommandText"
    & cmd.exe /d /s /c $CommandText
    if ($LASTEXITCODE -ne 0) {
        throw $FailureMessage
    }
}

function Invoke-Ralph([string]$CommandTemplate, [string]$RepoRoot, [string]$PromptFile, [string]$OutputFile) {
    if ($CommandTemplate) {
        $expanded = $CommandTemplate.Replace("{REPO_ROOT}", $RepoRoot).Replace("{PROMPT_FILE}", $PromptFile)
        Invoke-ExternalCommand -CommandText $expanded -FailureMessage "Agent command failed with exit code $LASTEXITCODE."
        return
    }

    Write-Host "Running: codex exec - -C `"$RepoRoot`" --dangerously-bypass-approvals-and-sandbox"
    Get-Content -LiteralPath $PromptFile -Raw | codex exec - -C $RepoRoot --dangerously-bypass-approvals-and-sandbox | Tee-Object -FilePath $OutputFile
    if ($LASTEXITCODE -ne 0) {
        throw "Codex command failed with exit code $LASTEXITCODE."
    }
}

function Invoke-Verification([string]$VerificationCommand) {
    if (-not $VerificationCommand) {
        return
    }

    $trimmed = $VerificationCommand.Trim()
    if ($trimmed -match '(^|[\\/])[^\\/]+\.ps1($|\s)') {
        Write-Host "Running: powershell -ExecutionPolicy Bypass -File $trimmed"
        powershell -ExecutionPolicy Bypass -File $trimmed
        if ($LASTEXITCODE -ne 0) {
            throw "Verification command failed with exit code $LASTEXITCODE."
        }
        return
    }

    Invoke-ExternalCommand -CommandText $VerificationCommand -FailureMessage "Verification command failed with exit code $LASTEXITCODE."
}

function Get-ChangedPaths([string[]]$BaselinePaths) {
    $baseline = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $BaselinePaths) {
        if ($path) {
            [void]$baseline.Add($path)
        }
    }

    $newPaths = @()
    foreach ($path in (Get-StatusPaths)) {
        if (-not $baseline.Contains($path)) {
            $newPaths += $path
        }
    }

    return $newPaths | Sort-Object -Unique
}

function New-CommitMessage([string]$Prefix, [int]$IssueNumber, [string]$Task) {
    $sanitized = ($Task -replace '\s+', ' ').Trim()
    return "$Prefix(#$IssueNumber): $sanitized"
}

function Append-ProgressEntry {
    param(
        [string]$ProgressFile,
        [string]$Task,
        [int]$IssueNumber,
        [string]$IssueUrl,
        [string]$BranchName,
        [string]$VerificationCommand,
        [string[]]$ChangedPaths
    )

    if (-not (Test-Path -LiteralPath $ProgressFile)) {
        New-Item -ItemType File -Path $ProgressFile | Out-Null
    }

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    $entryLines = @(
        "[$timestamp] TASK: $Task"
        "ISSUE: #$IssueNumber $IssueUrl"
        "BRANCH: $BranchName"
    )

    if ($VerificationCommand) {
        $entryLines += "VERIFY: $VerificationCommand"
    }

    if ($ChangedPaths.Count -gt 0) {
        $entryLines += "FILES:"
        $entryLines += $ChangedPaths | ForEach-Object { " - $_" }
    }

    $entryLines += ""
    Add-Content -LiteralPath $ProgressFile -Value $entryLines
}

function Find-OpenPrForBranch([string]$BranchName) {
    $prsJson = gh pr list --state open --head $BranchName --json number,url,title --limit 20
    $prs = @()
    if ($prsJson) {
        $prs = $prsJson | ConvertFrom-Json
    }
    return $prs | Select-Object -First 1
}

function New-PrBody([int]$IssueNumber, [string]$Task, [string]$VerificationCommand) {
    $verificationText = if ($VerificationCommand) {
        "- Local verification: ``$VerificationCommand``"
    } else {
        "- Local verification: no explicit command configured"
    }

    return @"
## Summary
- Implement PRD task: $Task

## Tracking
- Closes #$IssueNumber
$verificationText
- Merge rule: resolve GitHub review findings before merge
"@
}

function Ensure-Pr([string]$RemoteName, [string]$BaseBranch, [string]$BranchName, [string]$Title, [int]$IssueNumber, [string]$Task, [string]$VerificationCommand) {
    $existingPr = Find-OpenPrForBranch -BranchName $BranchName
    if ($existingPr) {
        return $existingPr
    }

    $prBody = New-PrBody -IssueNumber $IssueNumber -Task $Task -VerificationCommand $VerificationCommand
    $prUrl = "$(gh pr create --base $BaseBranch --head $BranchName --title $Title --body $prBody)".Trim()
    return [pscustomobject]@{
        url   = $prUrl
        title = $Title
    }
}

function Invoke-PrReviewTrigger([string]$BranchName, [string]$ReviewTriggerComment) {
    if (-not $ReviewTriggerComment) {
        return
    }

    $escaped = $ReviewTriggerComment.Replace('"', '\"')
    Invoke-ExternalCommand -CommandText "gh pr comment $BranchName --body ""$escaped""" -FailureMessage "Failed to post PR review trigger comment."
}

function Get-PrReviewStatus([string]$BranchName) {
    $prJson = gh pr view $BranchName --json url,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,reviewRequests
    $pr = $prJson | ConvertFrom-Json

    $requestedReviewers = @()
    if ($pr.reviewRequests) {
        foreach ($reviewRequest in $pr.reviewRequests) {
            if ($reviewRequest.login) {
                $requestedReviewers += $reviewRequest.login
            }
            elseif ($reviewRequest.name) {
                $requestedReviewers += $reviewRequest.name
            }
        }
    }

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

    $mergeBlockedByReview = $pr.reviewDecision -eq "CHANGES_REQUESTED"
    $mergeBlockedByChecks = $checksState -eq "failing" -or $checksState -eq "pending"
    $mergeReady = (-not $pr.isDraft) -and (-not $mergeBlockedByReview) -and (-not $mergeBlockedByChecks)

    return [pscustomobject]@{
        url = $pr.url
        isDraft = [bool]$pr.isDraft
        reviewDecision = [string]$pr.reviewDecision
        mergeStateStatus = [string]$pr.mergeStateStatus
        checksState = $checksState
        requestedReviewers = ($requestedReviewers | Sort-Object -Unique)
        mergeReady = $mergeReady
    }
}

function Set-PrAutoMerge([string]$BranchName) {
    gh pr ready $BranchName | Out-Null
    gh pr merge $BranchName --auto --squash --delete-branch | Out-Null
}

function Get-PrCompletionStatus([string]$BranchName) {
    $prJson = gh pr view $BranchName --json url,state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,reviewRequests,mergedAt,closed
    $pr = $prJson | ConvertFrom-Json
    $reviewStatus = Get-PrReviewStatus -BranchName $BranchName

    return [pscustomobject]@{
        url = [string]$pr.url
        state = [string]$pr.state
        closed = [bool]$pr.closed
        mergedAt = [string]$pr.mergedAt
        isDraft = [bool]$pr.isDraft
        reviewDecision = [string]$pr.reviewDecision
        mergeStateStatus = [string]$pr.mergeStateStatus
        checksState = [string]$reviewStatus.checksState
        requestedReviewers = $reviewStatus.requestedReviewers
    }
}

function Wait-ForPrCompletion([string]$BranchName, [int]$PollSeconds, [int]$MaxWaitMinutes) {
    $deadline = (Get-Date).AddMinutes($MaxWaitMinutes)

    while ($true) {
        $prStatus = Get-PrCompletionStatus -BranchName $BranchName

        if ($prStatus.mergedAt) {
            return $prStatus
        }

        if ($prStatus.state -eq "CLOSED" -or ($prStatus.closed -and -not $prStatus.mergedAt)) {
            throw "PR closed without merge: $($prStatus.url)"
        }

        if ($prStatus.reviewDecision -eq "CHANGES_REQUESTED") {
            throw "PR review is requesting changes: $($prStatus.url)"
        }

        if ($prStatus.checksState -eq "failing") {
            throw "PR checks are failing: $($prStatus.url)"
        }

        if ((Get-Date) -gt $deadline) {
            throw "Timed out waiting for PR completion: $($prStatus.url)"
        }

        Write-Host "Waiting for PR checks/merge: $($prStatus.url) (checks=$($prStatus.checksState), mergeState=$($prStatus.mergeStateStatus))"
        Start-Sleep -Seconds $PollSeconds
    }
}

function Get-AgentHumanRequirement([string]$OutputFile) {
    $result = [pscustomobject]@{
        required = $false
        reason = ""
    }

    if (-not (Test-Path -LiteralPath $OutputFile)) {
        return $result
    }

    $content = Get-Content -LiteralPath $OutputFile -Raw
    $notesMatch = [regex]::Match($content, '(?ms)^NOTES\s*(.+)$')
    if (-not $notesMatch.Success) {
        return $result
    }

    $notes = $notesMatch.Groups[1].Value
    $requiredMatch = [regex]::Match($notes, '(?im)^\s*HUMAN_REQUIRED:\s*(yes|no)\s*$')
    if ($requiredMatch.Success -and $requiredMatch.Groups[1].Value.ToLowerInvariant() -eq "yes") {
        $result.required = $true
    }

    $reasonMatch = [regex]::Match($notes, '(?im)^\s*HUMAN_REASON:\s*(.+?)\s*$')
    if ($reasonMatch.Success) {
        $result.reason = $reasonMatch.Groups[1].Value.Trim()
    }

    return $result
}

function Get-HumanNotificationMessage($AgentHumanRequirement, $ReviewStatus, [string]$Handle, [string]$Task, [string]$BranchName) {
    $reasons = New-Object System.Collections.Generic.List[string]

    if ($AgentHumanRequirement.required) {
        $reasonText = if ($AgentHumanRequirement.reason) { $AgentHumanRequirement.reason } else { "Codex flagged human follow-up." }
        [void]$reasons.Add("Codex requested human follow-up: $reasonText")
    }

    if ($ReviewStatus.reviewDecision -eq "CHANGES_REQUESTED") {
        [void]$reasons.Add("GitHub review is requesting changes.")
    }

    if ($ReviewStatus.checksState -eq "failing") {
        [void]$reasons.Add("PR checks are failing.")
    }

    if ($reasons.Count -eq 0) {
        return $null
    }

    $mentionPrefix = if ($Handle) { "@$Handle " } else { "" }
    return @"
$mentionPrefix human attention is required for this autonomous task.

Task:
- $Task

Branch:
- $BranchName

Reasons:
$($reasons | ForEach-Object { "- $_" } | Out-String)
"@.Trim()
}

function Send-HumanNotification([string]$BranchName, [string]$Message) {
    if (-not $Message) {
        return
    }

    $tempMessageFile = Join-Path ([System.IO.Path]::GetTempPath()) ("ralph-once-notify-" + [System.Guid]::NewGuid().ToString() + ".txt")
    try {
        Set-Content -LiteralPath $tempMessageFile -Value $Message -Encoding UTF8
        gh pr comment $BranchName --body-file $tempMessageFile | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to post human notification comment."
        }
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
$prdFile = Resolve-ExistingPath -RepoRoot $repoRoot -PathValue $PrdPath -Label "PRD file"
$progressFile = Resolve-PathInRepo -RepoRoot $repoRoot -PathValue $ProgressPath

Assert-CleanTrackedWorktree
$baselinePaths = Get-StatusPaths

$repoInfo = Get-RepoInfo
$defaultBranch = $repoInfo.defaultBranchRef.name
if (-not $NotificationHandle) {
    $NotificationHandle = Get-GitHubLogin
}
Assert-OnDefaultBranch -DefaultBranch $defaultBranch
Sync-DefaultBranch -RemoteName $RemoteName -DefaultBranch $defaultBranch

$completedTasks = Get-CompletedTasks -ProgressFile $progressFile
$task = Get-NextTask -PrdFile $prdFile -CompletedTasks $completedTasks
$issue = Ensure-Issue -Task $task -PrdFile $prdFile
$branchName = Ensure-TaskBranch -RemoteName $RemoteName -IssueNumber $issue.number -Task $task
$verificationToRun = Get-VerificationCommand -RepoRoot $repoRoot -ExplicitCommand $VerificationCommand

$prompt = New-RalphPrompt -RepoRoot $repoRoot -PrdFile $prdFile -ProgressFile $progressFile -Task $task -IssueNumber $issue.number -IssueUrl $issue.url -BranchName $branchName -VerificationCommand $verificationToRun

if ($ShowPrompt) {
    Write-Host $prompt
}

$tempPromptFile = Join-Path ([System.IO.Path]::GetTempPath()) ("ralph-once-" + [System.Guid]::NewGuid().ToString() + ".txt")
$tempOutputFile = Join-Path ([System.IO.Path]::GetTempPath()) ("ralph-once-output-" + [System.Guid]::NewGuid().ToString() + ".txt")
Set-Content -LiteralPath $tempPromptFile -Value $prompt -Encoding UTF8

try {
    Invoke-Ralph -CommandTemplate $AgentCommandTemplate -RepoRoot $repoRoot -PromptFile $tempPromptFile -OutputFile $tempOutputFile

    $changedPaths = Get-ChangedPaths -BaselinePaths $baselinePaths
    if (-not $changedPaths -or $changedPaths.Count -eq 0) {
        throw "Ralph completed without producing any file changes."
    }

    Invoke-Verification -VerificationCommand $verificationToRun

    Append-ProgressEntry -ProgressFile $progressFile -Task $task -IssueNumber $issue.number -IssueUrl $issue.url -BranchName $branchName -VerificationCommand $verificationToRun -ChangedPaths $changedPaths

    $commitMessage = New-CommitMessage -Prefix $CommitPrefix -IssueNumber $issue.number -Task $task
    git add -- $changedPaths
    git add -- $progressFile
    git commit -m $commitMessage | Out-Null
    git push -u $RemoteName $branchName | Out-Null

    $pr = Ensure-Pr -RemoteName $RemoteName -BaseBranch $defaultBranch -BranchName $branchName -Title $commitMessage -IssueNumber $issue.number -Task $task -VerificationCommand $verificationToRun
    Invoke-PrReviewTrigger -BranchName $branchName -ReviewTriggerComment $ReviewTriggerComment
    if ($EnableAutoMerge) {
        Set-PrAutoMerge -BranchName $branchName
    }
    $reviewStatus = Get-PrReviewStatus -BranchName $branchName
    $agentHumanRequirement = Get-AgentHumanRequirement -OutputFile $tempOutputFile
    $notificationMessage = Get-HumanNotificationMessage -AgentHumanRequirement $agentHumanRequirement -ReviewStatus $reviewStatus -Handle $NotificationHandle -Task $task -BranchName $branchName
    Send-HumanNotification -BranchName $branchName -Message $notificationMessage
    $completionStatus = Wait-ForPrCompletion -BranchName $branchName -PollSeconds $PrPollSeconds -MaxWaitMinutes $PrWaitMinutes

    Write-Host "Completed task: $task"
    Write-Host "Issue: #$($issue.number) $($issue.url)"
    Write-Host "Branch: $branchName"
    Write-Host "PR: $($pr.url)"
    Write-Host "PR draft: $($reviewStatus.isDraft)"
    Write-Host "PR review decision: $($reviewStatus.reviewDecision)"
    Write-Host "PR checks: $($reviewStatus.checksState)"
    if ($reviewStatus.requestedReviewers.Count -gt 0) {
        Write-Host "PR pending reviewers: $($reviewStatus.requestedReviewers -join ', ')"
    }
    Write-Host "Auto-merge enabled: $EnableAutoMerge"
    Write-Host "Human follow-up required: $($agentHumanRequirement.required)"
    if ($agentHumanRequirement.reason) {
        Write-Host "Human follow-up reason: $($agentHumanRequirement.reason)"
    }
    Write-Host "Merge ready: $($reviewStatus.mergeReady)"
    Write-Host "PR merged at: $($completionStatus.mergedAt)"
} finally {
    if (Test-Path -LiteralPath $tempPromptFile) {
        Remove-Item -LiteralPath $tempPromptFile -Force
    }
    if (Test-Path -LiteralPath $tempOutputFile) {
        Remove-Item -LiteralPath $tempOutputFile -Force
    }
}
