param(
    [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"
$manager = Join-Path $PSScriptRoot "Manage-MyDashboard.ps1"
& $manager -Action Start -OpenBrowser:$OpenBrowser
