$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectDirectory "logs"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

Push-Location $projectDirectory
try {
    $logFile = Join-Path $logDirectory "scheduled-refresh.log"
    $baseUrl = "http://127.0.0.1:4173"
    $serverAvailable = $false
    try {
        $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 3
        $serverAvailable = $health.ok -eq $true
    } catch {
        $serverAvailable = $false
    }

    if (-not $serverAvailable) {
        "MyDashboard server is unavailable; skipped to preserve the single-writer boundary." | Add-Content -LiteralPath $logFile
        exit 1
    }

    try {
        $headers = @{
            Origin = $baseUrl
            "X-MyDashboard-Action" = "1"
        }
        $result = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/refresh?notify=1" -Headers $headers -TimeoutSec 600
        $result | ConvertTo-Json -Depth 10 | Add-Content -LiteralPath $logFile
        exit 0
    } catch {
        $_ | Out-String | Add-Content -LiteralPath $logFile
        exit 1
    }
} finally {
    Pop-Location
}
