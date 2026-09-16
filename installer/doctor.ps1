[CmdletBinding()]
param(
    [ValidateSet('Edge', 'Chrome', 'Brave')]
    [string]$Browser = 'Edge',
    [string]$ExtensionRoot
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
Write-Host 'Checks complete. Confirm extension registration manually on the browser extensions page.' -ForegroundColor Cyan
