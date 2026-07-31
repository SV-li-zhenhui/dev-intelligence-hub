param(
    [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectDirectory "logs"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

$existing = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue
if (-not $existing) {
    Start-Process `
        -FilePath "C:\Program Files\nodejs\node.exe" `
        -ArgumentList "src/server.js" `
        -WorkingDirectory $projectDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDirectory "server.log") `
        -RedirectStandardError (Join-Path $logDirectory "server-error.log")
}

if ($OpenBrowser) {
    Start-Process "http://127.0.0.1:4173"
}
