[CmdletBinding()]
param(
    [ValidateSet('Edge', 'Chrome', 'Brave')]
    [string]$Browser = 'Edge',
    [string]$ExtensionRoot,
    [switch]$RuntimeCheck,
    [switch]$ArchiveTest
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$skillSource = Join-Path $repoRoot '.agents\skills\bookmark-organizer'
$python = Get-Command python -ErrorAction SilentlyContinue
$sharedSkill = Join-Path (Join-Path $env:USERPROFILE '.agents\skills') 'bookmark-organizer'
$browserFolder = switch ($Browser) { 'Edge' { 'Microsoft-Edge' } 'Chrome' { 'Google-Chrome' } 'Brave' { 'Brave' } }
if (-not $ExtensionRoot) {
    $ExtensionRoot = if (Test-Path -LiteralPath 'D:\') { Join-Path "D:\$browserFolder" 'Local-Extensions' } else { Join-Path $env:LOCALAPPDATA "BrowserLocalExtensions\$browserFolder" }
}
$extensionTarget = Join-Path $ExtensionRoot 'bookmark-organizer'
$extensionSource = Join-Path $repoRoot 'extension\edge-bookmark-organizer'
$failed = $false

function Check([bool]$Condition, [string]$Message) {
    if ($Condition) { Write-Host "[PASS] $Message" -ForegroundColor Green }
    else { Write-Host "[MISSING] $Message" -ForegroundColor Red; $script:failed = $true }
}

function Get-ExtensionId([string]$Key) {
    $bytes = [Convert]::FromBase64String($Key)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
    $builder = New-Object Text.StringBuilder
    for ($index = 0; $index -lt 16; $index++) {
        [void]$builder.Append([char](97 + ($hash[$index] -shr 4)))
        [void]$builder.Append([char](97 + ($hash[$index] -band 15)))
    }
    return $builder.ToString()
}

Check (Test-Path -LiteralPath (Join-Path $skillSource 'SKILL.md') -PathType Leaf) 'Skill source in repository'
Check ($null -ne $python) 'Python command'
Check (Test-Path -LiteralPath $sharedSkill -PathType Container) "Shared skill: $sharedSkill"
if (Test-Path -LiteralPath $sharedSkill -PathType Container) {
    $skillDrift = @()
    foreach ($sourceFile in (Get-ChildItem -LiteralPath $skillSource -File -Recurse | Where-Object { $_.Extension -ne '.pyc' })) {
        $relative = $sourceFile.FullName.Substring($skillSource.Length).TrimStart('\', '/')
        $targetFile = Join-Path $sharedSkill $relative
        if (-not (Test-Path -LiteralPath $targetFile -PathType Leaf)) { $skillDrift += $relative }
        elseif ((Get-FileHash -LiteralPath $sourceFile.FullName).Hash -ne (Get-FileHash -LiteralPath $targetFile).Hash) { $skillDrift += $relative }
    }
    Check ($skillDrift.Count -eq 0) 'Deployed skill files match repository source'
}
Check (Test-Path -LiteralPath (Join-Path $extensionTarget 'manifest.json') -PathType Leaf) "Extension directory: $extensionTarget"

if (Test-Path -LiteralPath (Join-Path $extensionTarget 'manifest.json') -PathType Leaf) {
    try {
        $manifest = Get-Content -LiteralPath (Join-Path $extensionTarget 'manifest.json') -Encoding utf8 -Raw | ConvertFrom-Json
        $expectedName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('5pS26JeP5aS55pW055CG5Yqp5omL77yI5pys5Zyw77yJ'))
        $versionValid = $false
        try { $versionValid = ([version]$manifest.version -ge [version]'2.0.1') } catch { $versionValid = $false }
        $permissions = @($manifest.permissions)

        Check ($manifest.name -eq $expectedName) 'Extension name'
        Check ($manifest.manifest_version -eq 3) 'Manifest V3 format'
        Check $versionValid 'Extension version >= 2.0.1'
        Check (($permissions -contains 'bookmarks') -and ($permissions -contains 'downloads') -and
            ($permissions -contains 'activeTab') -and ($permissions -contains 'storage')) 'Required permissions: bookmarks, downloads, activeTab, storage'
        Check ($manifest.background.service_worker -eq 'bridge.js') 'Local Agent bridge service worker'
        Check ($null -ne $manifest.key) 'Stable extension ID key'
        $matches = @($manifest.externally_connectable.matches)
        Check (($matches -contains 'http://127.0.0.1/*') -and ($matches -contains 'http://localhost/*')) 'Local-only external message origins'
    } catch { Check $false 'Manifest JSON format' }
}
if ((Test-Path -LiteralPath $extensionSource -PathType Container) -and (Test-Path -LiteralPath $extensionTarget -PathType Container)) {
    $mismatchedFiles = @()
    foreach ($sourceFile in (Get-ChildItem -LiteralPath $extensionSource -File)) {
        if ($sourceFile.Name -eq 'bridge-config.js') { continue }
        $deployedFile = Join-Path $extensionTarget $sourceFile.Name
        if (-not (Test-Path -LiteralPath $deployedFile -PathType Leaf)) {
            $mismatchedFiles += "$($sourceFile.Name) (missing in deployed copy)"
        } else {
            $sourceHash = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash
            $deployedHash = (Get-FileHash -LiteralPath $deployedFile -Algorithm SHA256).Hash
            if ($sourceHash -ne $deployedHash) { $mismatchedFiles += $sourceFile.Name }
        }
    }
    if ($mismatchedFiles.Count -gt 0) {
        Write-Host "  Differs from repo source: $($mismatchedFiles -join ', ')" -ForegroundColor Yellow
    }
    Check ($mismatchedFiles.Count -eq 0) 'Deployed extension files match repository source (excluding bridge-config.js)'
}
if ($python) {
    try { $auditScript = Join-Path $skillSource 'scripts\audit_bookmarks.py'; & $python.Source $auditScript --help | Out-Null; Check $true 'Audit script is runnable' }
    catch { Check $false 'Audit script is runnable' }
    try { $bridgeScript = Join-Path $skillSource 'scripts\bookmarkctl.py'; & $python.Source $bridgeScript --help | Out-Null; Check $true 'bookmarkctl is runnable' }
    catch { Check $false 'bookmarkctl is runnable' }
}

$bridgeConfig = Join-Path $env:USERPROFILE '.bookmark-organizer\bridge.json'
Check (Test-Path -LiteralPath $bridgeConfig -PathType Leaf) "Local bridge config: $bridgeConfig"
if ((Test-Path -LiteralPath $bridgeConfig -PathType Leaf) -and ($null -ne $manifest)) {
    try {
        $localConfig = Get-Content -LiteralPath $bridgeConfig -Encoding utf8 -Raw | ConvertFrom-Json
        $expectedExtensionId = Get-ExtensionId $manifest.key
        Check ($localConfig.extensionId -eq $expectedExtensionId) 'Bridge config extension ID matches manifest key'
        Check (-not [string]::IsNullOrWhiteSpace($localConfig.token)) 'Bridge config token is present'

        $extensionBridgeConfig = Join-Path $extensionTarget 'bridge-config.js'
        Check (Test-Path -LiteralPath $extensionBridgeConfig -PathType Leaf) 'Deployed extension bridge config'
        if (Test-Path -LiteralPath $extensionBridgeConfig -PathType Leaf) {
            $source = Get-Content -LiteralPath $extensionBridgeConfig -Encoding utf8 -Raw
            $match = [regex]::Match($source, 'Object\.freeze\((\{.*\})\)\s*;?')
            $deployedConfig = if ($match.Success) { $match.Groups[1].Value | ConvertFrom-Json } else { $null }
            Check ($null -ne $deployedConfig) 'Deployed bridge config format'
            if ($null -ne $deployedConfig) {
                Check (-not [string]::IsNullOrWhiteSpace($deployedConfig.token)) 'Deployed extension token is present'
                Check ($deployedConfig.token -eq $localConfig.token) 'CLI and extension bridge tokens match'
            }
        }
    } catch { Check $false 'Bridge configuration consistency' }
}

if ($failed) { exit 1 }
Write-Host 'Static installation checks complete; this does not prove runtime or archive health.' -ForegroundColor Cyan
if ($RuntimeCheck -or $ArchiveTest) {
    $runtimeFile = Join-Path ([IO.Path]::GetTempPath()) ('bookmark-doctor-' + [guid]::NewGuid().ToString() + '.json')
    & $python.Source $bridgeScript --browser $Browser.ToLowerInvariant() --output $runtimeFile status
    if ($LASTEXITCODE -ne 0) { Check $false "Runtime connection failed; see $runtimeFile" }
    else {
        $runtimeResult = Get-Content -LiteralPath $runtimeFile -Raw -Encoding utf8 | ConvertFrom-Json
        Check ($runtimeResult.extensionVersion -eq $manifest.version) 'Loaded runtime version matches deployed manifest'
    }
    if ($ArchiveTest -and -not $failed) {
        & $python.Source $bridgeScript --browser $Browser.ToLowerInvariant() --output $runtimeFile backup
        Check ($LASTEXITCODE -eq 0) "Explicit archive test (creates an HTML backup); result: $runtimeFile"
    }
} else { Write-Host 'Runtime not checked. Use -RuntimeCheck; -ArchiveTest additionally creates a backup.' }
if ($failed) { exit 1 }
