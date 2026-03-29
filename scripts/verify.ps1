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

if ($scriptNames -contains "test:parser") {
    Write-Host "Running: npm run test:parser"
    npm run test:parser
    if ($LASTEXITCODE -ne 0) {
        throw "npm run test:parser failed with exit code $LASTEXITCODE."
    }
}

if ($scriptNames -contains "test:integration") {
    Write-Host "Running: npm run test:integration"
    npm run test:integration
    if ($LASTEXITCODE -ne 0) {
        throw "npm run test:integration failed with exit code $LASTEXITCODE."
    }
}

if ($scriptNames -contains "build") {
    Write-Host "Running: npm run build"
    npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "npm run build failed with exit code $LASTEXITCODE."
    }
}

if ($scriptNames -contains "test:e2e") {
    Write-Host "Running: npm run test:e2e"
    npm run test:e2e
    if ($LASTEXITCODE -ne 0) {
        throw "npm run test:e2e failed with exit code $LASTEXITCODE."
    }
}

$nativeProjectPath = Join-Path $PSScriptRoot "..\native-gateway\D2Wealth.Gateway.Win\D2Wealth.Gateway.Win.csproj"
$isWindowsHost = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)
if ($isWindowsHost -and (Test-Path -LiteralPath $nativeProjectPath)) {
    Write-Host "Running: dotnet build $nativeProjectPath -c Release"
    dotnet build $nativeProjectPath -c Release
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet build failed with exit code $LASTEXITCODE."
    }
}
