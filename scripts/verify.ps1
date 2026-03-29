[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$packageJsonPath = Join-Path $PSScriptRoot "..\\package.json"
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$scriptNames = @()
if ($packageJson.scripts) {
    $scriptNames = $packageJson.scripts.PSObject.Properties.Name
}

if ($scriptNames -contains "test") {
    Write-Host "Running: npm test"
    npm test
    if ($LASTEXITCODE -ne 0) {
        throw "npm test failed with exit code $LASTEXITCODE."
    }
}

if ($scriptNames -contains "build") {
    Write-Host "Running: npm run build"
    npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "npm run build failed with exit code $LASTEXITCODE."
    }
}
