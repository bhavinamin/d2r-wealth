[CmdletBinding()]
param(
    [string]$Runtime = "win-x64",
    [string]$Configuration = "Release",
    [string]$OutputRoot = "",
    [switch]$SkipArchive
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$projectPath = Join-Path $repoRoot "native-gateway\D2Wealth.Gateway.Win\D2Wealth.Gateway.Win.csproj"
$packageJsonPath = Join-Path $repoRoot "package.json"
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$version = [string]$packageJson.version

$resolvedOutputRoot = if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    Join-Path $repoRoot "release\native-gateway"
}
else {
    $OutputRoot
}

$outputRootResolved = [System.IO.Path]::GetFullPath($resolvedOutputRoot)
$bundleRoot = Join-Path $outputRootResolved "D2-Wealth-Gateway-Native"
$archivePath = Join-Path $outputRootResolved ("D2-Wealth-Gateway-Native-{0}-{1}.zip" -f $version, $Runtime)

if (Test-Path -LiteralPath $bundleRoot) {
    Remove-Item -LiteralPath $bundleRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $bundleRoot | Out-Null

Write-Host "Publishing native gateway wrapper..."
dotnet publish $projectPath `
    -c $Configuration `
    -r $Runtime `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -o $bundleRoot

if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE."
}

$nodeCommand = Get-Command node -ErrorAction Stop
$nodeTargetDir = Join-Path $bundleRoot "node"
New-Item -ItemType Directory -Path $nodeTargetDir | Out-Null
Copy-Item -LiteralPath $nodeCommand.Source -Destination (Join-Path $nodeTargetDir "node.exe") -Force

Write-Host "Copying gateway runtime files..."
Copy-Item -LiteralPath (Join-Path $repoRoot "gateway") -Destination (Join-Path $bundleRoot "gateway") -Recurse -Force

$generatedDir = Join-Path $bundleRoot "src\generated"
New-Item -ItemType Directory -Path $generatedDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot "src\generated\market-data.json") -Destination (Join-Path $generatedDir "market-data.json") -Force
Copy-Item -LiteralPath $packageJsonPath -Destination (Join-Path $bundleRoot "package.json") -Force

$moduleTargetDir = Join-Path $bundleRoot "node_modules\@d2runewizard"
New-Item -ItemType Directory -Path $moduleTargetDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot "node_modules\@d2runewizard\d2s") -Destination (Join-Path $moduleTargetDir "d2s") -Recurse -Force

$manifest = @{
    productName = "D2 Wealth Gateway Native"
    version = $version
    runtime = $Runtime
    publishedAt = (Get-Date).ToString("o")
    files = @(
        "D2Wealth.Gateway.Win.exe",
        "node\node.exe",
        "gateway\server.mjs",
        "gateway\service.mjs",
        "gateway\report.mjs",
        "src\generated\market-data.json",
        "node_modules\@d2runewizard\d2s"
    )
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $bundleRoot "bundle-manifest.json")

if (-not $SkipArchive) {
    if (Test-Path -LiteralPath $archivePath) {
        Remove-Item -LiteralPath $archivePath -Force
    }

    Write-Host "Creating native gateway archive..."
    Compress-Archive -Path (Join-Path $bundleRoot "*") -DestinationPath $archivePath
}

Write-Host "Native gateway bundle ready:"
Write-Host "  Bundle:  $bundleRoot"
if (-not $SkipArchive) {
    Write-Host "  Archive: $archivePath"
}
