$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectDirectory "logs"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

$maximumLogBytes = 5MB
$maximumArchives = 5

function Get-ConfiguredPort {
    $baseConfigFile = Join-Path $projectDirectory "config.json"
    $exampleConfigFile = Join-Path $projectDirectory "config.example.json"
    $configurationStateFile = Join-Path $projectDirectory "data\configuration-state.json"
    $configSource = if (Test-Path -LiteralPath $baseConfigFile -PathType Leaf) {
        $baseConfigFile
    } elseif (Test-Path -LiteralPath $exampleConfigFile -PathType Leaf) {
        $exampleConfigFile
    } else {
        throw "Neither private nor example configuration is available."
    }
    $base = Get-Content -LiteralPath $configSource -Raw | ConvertFrom-Json
    $port = $base.port
    if (Test-Path -LiteralPath $configurationStateFile -PathType Leaf) {
        $state = Get-Content -LiteralPath $configurationStateFile -Raw | ConvertFrom-Json
        if ($null -ne $state.activeVersion) {
            $active = @($state.versions | Where-Object {
                $_.version -eq $state.activeVersion
            })
            if ($active.Count -ne 1) {
                throw "Active configuration state is inconsistent."
            }
            $port = $active[0].configuration.port
        }
    }
    if ($port -isnot [int] -and $port -isnot [long]) {
        throw "Configured port is not an integer."
    }
    $port = [int]$port
    if ($port -lt 1 -or $port -gt 65535) {
        throw "Configured port is outside the supported range."
    }
    return $port
}

function Assert-LogPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $resolvedLogDirectory = [System.IO.Path]::GetFullPath($logDirectory)
    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    if ([System.IO.Path]::GetDirectoryName($resolvedPath) -ne $resolvedLogDirectory) {
        throw "Log path is outside the configured log directory."
    }
    return $resolvedPath
}

function Rotate-LogFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $safePath = Assert-LogPath -Path $Path
    if (-not (Test-Path -LiteralPath $safePath -PathType Leaf)) {
        return
    }
    $logInfo = Get-Item -LiteralPath $safePath
    if ($logInfo.Length -lt $maximumLogBytes) {
        return
    }

    for ($index = $maximumArchives; $index -ge 2; $index -= 1) {
        $older = Assert-LogPath -Path "$safePath.$($index - 1)"
        $newer = Assert-LogPath -Path "$safePath.$index"
        if (Test-Path -LiteralPath $older -PathType Leaf) {
            Move-Item -LiteralPath $older -Destination $newer -Force
        }
    }
    Move-Item -LiteralPath $safePath -Destination (Assert-LogPath -Path "$safePath.1") -Force
}

function Write-RefreshLog {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Record
    )

    $logFile = Assert-LogPath -Path (Join-Path $logDirectory "scheduled-refresh.log")
    Rotate-LogFile -Path $logFile
    $boundedRecord = [ordered]@{
        at = [DateTime]::UtcNow.ToString("o")
        status = [string]$Record.status
        refreshedAt = if ($null -eq $Record.refreshedAt) { $null } else { [string]$Record.refreshedAt }
        itemCount = if ($null -eq $Record.itemCount) { 0 } else { [int]$Record.itemCount }
        errorCount = if ($null -eq $Record.errorCount) { 0 } else { [int]$Record.errorCount }
        code = if ($null -eq $Record.code) { $null } else { [string]$Record.code }
    }
    $boundedRecord | ConvertTo-Json -Compress | Add-Content -LiteralPath $logFile -Encoding utf8
}

Push-Location $projectDirectory
try {
    $configuredPort = Get-ConfiguredPort
    $baseUrl = "http://127.0.0.1:$configuredPort"
    $serverAvailable = $false
    try {
        $liveness = Invoke-RestMethod -Uri "$baseUrl/api/live" -TimeoutSec 3
        $serverAvailable = $liveness.live -eq $true -and
            $liveness.service -eq "mydashboard"
    } catch {
        $serverAvailable = $false
    }

    if (-not $serverAvailable) {
        Write-RefreshLog -Record @{
            status = "skipped"
            code = "SERVER_UNAVAILABLE"
        }
        exit 1
    }

    try {
        $headers = @{
            Origin = $baseUrl
            "X-MyDashboard-Action" = "1"
        }
        $result = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/refresh?notify=1" -Headers $headers -TimeoutSec 600
        Write-RefreshLog -Record @{
            status = "completed"
            refreshedAt = $result.refreshedAt
            itemCount = @($result.items).Count
            errorCount = @($result.errors).Count
        }
        exit 0
    } catch {
        $failureCode = if ($null -ne $_.Exception.Response.StatusCode) {
            "HTTP_$([int]$_.Exception.Response.StatusCode)"
        } else {
            "REFRESH_REQUEST_FAILED"
        }
        Write-RefreshLog -Record @{
            status = "failed"
            code = $failureCode
        }
        exit 1
    }
} finally {
    Pop-Location
}
