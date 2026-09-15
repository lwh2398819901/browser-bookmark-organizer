[CmdletBinding()]
param(
    [ValidateSet('Edge', 'Chrome')]
    [string]$Browser = 'Edge',
    [string]$ExtensionRoot,
    [switch]$UpdateExtension,
    [switch]$OpenExtensionsPage
)

$ErrorActionPreference = 'Stop'

function Write-Status([string]$Message) { Write-Host "[Bookmark Organizer] $Message" -ForegroundColor Cyan }
function Write-WarningStatus([string]$Message) { Write-Warning "[Bookmark Organizer] $Message" }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$skillSource = Join-Path $repoRoot '.agents\skills\bookmark-organizer'
$extensionSource = Join-Path $repoRoot 'extension\edge-bookmark-organizer'
if (-not (Test-Path -LiteralPath (Join-Path $skillSource 'SKILL.md') -PathType Leaf)) { throw "Skill source is missing: $skillSource" }
if (-not (Test-Path -LiteralPath (Join-Path $extensionSource 'manifest.json') -PathType Leaf)) { throw "Extension source is missing: $extensionSource" }

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { throw 'Python 3.10+ is required but was not found.' }
& $python.Source --version
$auditScript = Join-Path $skillSource 'scripts\audit_bookmarks.py'
& $python.Source $auditScript --help | Out-Null
Write-Status 'Python and audit script checks passed.'

$sharedSkills = Join-Path $env:USERPROFILE '.agents\skills'
$skillTarget = Join-Path $sharedSkills 'bookmark-organizer'
New-Item -ItemType Directory -Path $sharedSkills -Force | Out-Null
if (Test-Path -LiteralPath $skillTarget) {
    Write-WarningStatus "Shared skill already exists; it was not overwritten: $skillTarget"
} else {
    try {
        New-Item -ItemType Junction -Path $skillTarget -Target $skillSource | Out-Null
        Write-Status "Created shared skill junction: $skillTarget"
    } catch {
        Copy-Item -LiteralPath $skillSource -Destination $skillTarget -Recurse
        Write-WarningStatus 'Junction creation was unavailable, so the skill was copied. Copy it again after future repository updates.'
    }
}

if (-not $ExtensionRoot) {
    $browserFolder = if ($Browser -eq 'Edge') { 'Microsoft-Edge' } else { 'Google-Chrome' }
    $ExtensionRoot = if (Test-Path -LiteralPath 'D:\') {
        Join-Path "D:\$browserFolder" 'Local-Extensions'
    } else {
        Join-Path $env:LOCALAPPDATA "BrowserLocalExtensions\$browserFolder"
    }
}
$extensionTarget = Join-Path $ExtensionRoot 'bookmark-organizer'
New-Item -ItemType Directory -Path $ExtensionRoot -Force | Out-Null
if (Test-Path -LiteralPath $extensionTarget) {
    if ($UpdateExtension) {
        Get-ChildItem -LiteralPath $extensionSource -Force | Copy-Item -Destination $extensionTarget -Recurse -Force
        Write-Status "Updated extension source: $extensionTarget"
    } else {
        Write-WarningStatus "Extension directory already exists and was not overwritten: $extensionTarget. Pass -UpdateExtension to update it."
    }
} else {
    Copy-Item -LiteralPath $extensionSource -Destination $extensionTarget -Recurse
    Write-Status "Copied extension source: $extensionTarget"
}

$manifest = Get-Content -LiteralPath (Join-Path $extensionTarget 'manifest.json') -Encoding utf8 -Raw | ConvertFrom-Json
if ($manifest.manifest_version -ne 3 -or -not $manifest.permissions.Contains('bookmarks')) { throw 'Extension manifest validation failed.' }
Write-Status "Extension validated: $($manifest.name) v$($manifest.version)"

Write-Host "`nManual browser confirmation is still required:" -ForegroundColor Yellow
Write-Host '1. Open edge://extensions (or chrome://extensions).'
Write-Host '2. Enable Developer mode.'
Write-Host "3. Choose Load unpacked and select: $extensionTarget"
Write-Host '4. After updating source, select Reload on the extension card.'

if ($OpenExtensionsPage) {
    $extensionsUrl = if ($Browser -eq 'Edge') { 'edge://extensions/' } else { 'chrome://extensions/' }
    $browserCommand = if ($Browser -eq 'Edge') { 'msedge.exe' } else { 'chrome.exe' }
    try {
        Start-Process -FilePath $browserCommand -ArgumentList $extensionsUrl
        Write-Status "Opened $extensionsUrl"
    } catch {
        Write-WarningStatus "Could not open the extensions page. Open it manually: $extensionsUrl"
    }
}
