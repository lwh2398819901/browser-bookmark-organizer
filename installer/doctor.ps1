[CmdletBinding()]
param(
    [ValidateSet('Edge', 'Chrome')]
    [string]$Browser = 'Edge',
    [string]$ExtensionRoot
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$skillSource = Join-Path $repoRoot '.agents\skills\bookmark-organizer'
$python = Get-Command python -ErrorAction SilentlyContinue
$sharedSkill = Join-Path (Join-Path $env:USERPROFILE '.agents\skills') 'bookmark-organizer'
$browserFolder = if ($Browser -eq 'Edge') { 'Microsoft-Edge' } else { 'Google-Chrome' }
if (-not $ExtensionRoot) {
    $ExtensionRoot = if (Test-Path -LiteralPath 'D:\') { Join-Path "D:\$browserFolder" 'Local-Extensions' } else { Join-Path $env:LOCALAPPDATA "BrowserLocalExtensions\$browserFolder" }
}
$extensionTarget = Join-Path $ExtensionRoot 'bookmark-organizer'
$failed = $false

function Check([bool]$Condition, [string]$Message) {
    if ($Condition) { Write-Host "[PASS] $Message" -ForegroundColor Green }
    else { Write-Host "[MISSING] $Message" -ForegroundColor Red; $script:failed = $true }
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
        try { $versionValid = ([version]$manifest.version -ge [version]'0.2.0') } catch { $versionValid = $false }
        $permissions = @($manifest.permissions)

        Check ($manifest.name -eq $expectedName) 'Extension name'
        Check ($manifest.manifest_version -eq 3) 'Manifest V3 format'
        Check $versionValid 'Extension version >= 0.2.0'
        Check (($permissions -contains 'bookmarks') -and ($permissions -contains 'downloads')) 'Required permissions: bookmarks, downloads'
    } catch { Check $false 'Manifest JSON format' }
}
if ($python) {
    try { $auditScript = Join-Path $skillSource 'scripts\audit_bookmarks.py'; & $python.Source $auditScript --help | Out-Null; Check $true 'Audit script is runnable' }
    catch { Check $false 'Audit script is runnable' }
}

if ($failed) { exit 1 }
Write-Host 'Checks complete. Confirm extension registration manually on the browser extensions page.' -ForegroundColor Cyan
