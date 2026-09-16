[CmdletBinding()]
param(
    [ValidateSet('Edge', 'Chrome', 'Brave')]
    [string]$Browser = 'Edge',
    [string]$ExtensionRoot,
    [switch]$UpdateExtension,
    [switch]$UpdateSkill,
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

$installScript = Join-Path $PSScriptRoot 'install.py'
$installArgs = @($installScript, '--browser', $Browser.ToLowerInvariant())
if ($ExtensionRoot) { $installArgs += @('--extension-root', $ExtensionRoot) }
if ($UpdateExtension) { $installArgs += '--update-extension' }
if ($UpdateSkill) { $installArgs += '--update-skill' }
& $python.Source @installArgs
if ($LASTEXITCODE -ne 0) { throw 'Cross-platform installer failed.' }
Write-Status 'Skill, extension and local Agent bridge installation completed.'

if ($OpenExtensionsPage) {
    $extensionsUrl = switch ($Browser) { 'Edge' { 'edge://extensions/' } 'Chrome' { 'chrome://extensions/' } 'Brave' { 'brave://extensions/' } }
    $browserCommand = switch ($Browser) { 'Edge' { 'msedge.exe' } 'Chrome' { 'chrome.exe' } 'Brave' { 'brave.exe' } }
    try {
        Start-Process -FilePath $browserCommand -ArgumentList $extensionsUrl
        Write-Status "Opened $extensionsUrl"
    } catch {
        Write-WarningStatus "Could not open the extensions page. Open it manually: $extensionsUrl"
    }
}
