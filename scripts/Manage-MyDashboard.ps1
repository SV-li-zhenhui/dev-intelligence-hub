[CmdletBinding()]
param(
    [ValidateSet("Start", "Stop", "Restart", "Status", "Restore")]
    [string]$Action = "Status",
    [string]$BackupId,
    [switch]$OpenBrowser,
    [ValidateRange(5, 120)]
    [int]$TimeoutSeconds = 45
)

$ErrorActionPreference = "Stop"
$convertFromJsonPreservesDates = (Get-Command ConvertFrom-Json).Parameters.ContainsKey(
    "DateKind"
)

function ConvertFrom-ExactJson {
    param([Parameter(Mandatory = $true)][string]$Json)
    if ($convertFromJsonPreservesDates) {
        return $Json | ConvertFrom-Json -DateKind String
    }
    return $Json | ConvertFrom-Json
}

$isWindowsRuntime = $env:OS -eq "Windows_NT"
$pathComparer = if ($isWindowsRuntime) {
    [StringComparer]::OrdinalIgnoreCase
} else {
    [StringComparer]::Ordinal
}
$lexicalProjectDirectory = [System.IO.Path]::GetFullPath(
    (Split-Path -Parent $PSScriptRoot)
)
$lexicalLauncherScript = [System.IO.Path]::GetFullPath(
    (Join-Path $lexicalProjectDirectory "scripts/launch-mydashboard-process.mjs")
)
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop
$nodePath = [System.IO.Path]::GetFullPath($nodeCommand.Source)
$runtimeInfoText = & $nodePath $lexicalLauncherScript --runtime-info | Out-String
if ($LASTEXITCODE -ne 0) {
    throw "Unable to resolve the MyDashboard private runtime identity."
}
$runtimeInfo = ConvertFrom-ExactJson -Json $runtimeInfoText
$runtimeProperties = @($runtimeInfo.PSObject.Properties.Name | Sort-Object)
if (
    (Compare-Object `
        -ReferenceObject @(
            "projectDigest",
            "projectDirectory",
            "runtimeDirectory",
            "schemaVersion"
        ) `
        -DifferenceObject $runtimeProperties) -or
    $runtimeInfo.schemaVersion -ne 1 -or
    [string]$runtimeInfo.projectDigest -notmatch '^[a-f0-9]{64}$' -or
    -not [System.IO.Path]::IsPathRooted([string]$runtimeInfo.projectDirectory) -or
    -not [System.IO.Path]::IsPathRooted([string]$runtimeInfo.runtimeDirectory)
) {
    throw "The runtime identity helper returned invalid data."
}

$projectDirectory = [System.IO.Path]::GetFullPath(
    [string]$runtimeInfo.projectDirectory
)
$projectDigest = [string]$runtimeInfo.projectDigest
$runtimeDirectory = [System.IO.Path]::GetFullPath(
    [string]$runtimeInfo.runtimeDirectory
)
$serverScript = [System.IO.Path]::GetFullPath(
    (Join-Path $projectDirectory "src/server.js")
)
$launcherScript = [System.IO.Path]::GetFullPath(
    (Join-Path $projectDirectory "scripts/launch-mydashboard-process.mjs")
)
$managedEntryScript = [System.IO.Path]::GetFullPath(
    (Join-Path $projectDirectory "scripts/run-managed-dashboard.mjs")
)
$offlineRestoreScript = [System.IO.Path]::GetFullPath(
    (Join-Path $projectDirectory "scripts/manage-offline-restore.mjs")
)
$dataDirectory = [System.IO.Path]::GetFullPath(
    (Join-Path $projectDirectory "data")
)
$restoreControlDirectory = [System.IO.Path]::GetFullPath(
    (Join-Path $projectDirectory "restore-control")
)
$controlFile = [System.IO.Path]::GetFullPath(
    (Join-Path $runtimeDirectory "mydashboard-server-process.json")
)
$baseConfigFile = [System.IO.Path]::GetFullPath(
    (Join-Path $projectDirectory "config.json")
)
$exampleConfigFile = [System.IO.Path]::GetFullPath(
    (Join-Path $projectDirectory "config.example.json")
)
$configurationStateFile = [System.IO.Path]::GetFullPath(
    (Join-Path $dataDirectory "configuration-state.json")
)
$runtimeLogDirectory = [System.IO.Path]::GetFullPath(
    (Join-Path $runtimeDirectory "logs")
)

if (
    -not $pathComparer.Equals(
        [System.IO.Path]::GetFileName($runtimeDirectory),
        $projectDigest
    ) -or
    -not (Test-Path -LiteralPath $launcherScript -PathType Leaf) -or
    -not (Test-Path -LiteralPath $managedEntryScript -PathType Leaf) -or
    -not (Test-Path -LiteralPath $serverScript -PathType Leaf)
) {
    throw "The resolved project runtime identity is inconsistent."
}
if ($isWindowsRuntime) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw "LOCALAPPDATA is required for the private runtime directory."
    }
    $expectedRuntimeRoot = [System.IO.Path]::GetFullPath(
        (Join-Path $env:LOCALAPPDATA "MyDashboard\runtime")
    )
    if (-not $pathComparer.Equals(
        [System.IO.Path]::GetDirectoryName($runtimeDirectory),
        $expectedRuntimeRoot
    )) {
        throw "The private runtime directory is outside LOCALAPPDATA."
    }
}

$mutexName = if ($isWindowsRuntime) {
    "Local\MyDashboard.ProcessManager.$($projectDigest.Substring(0, 32))"
} else {
    "MyDashboard.ProcessManager.$($projectDigest.Substring(0, 32))"
}

function Assert-DirectChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Child
    )
    $resolvedParent = [System.IO.Path]::GetFullPath($Parent)
    $resolvedChild = [System.IO.Path]::GetFullPath($Child)
    if (-not $pathComparer.Equals(
        [System.IO.Path]::GetDirectoryName($resolvedChild),
        $resolvedParent
    )) {
        throw "Managed path is outside its configured parent."
    }
    return $resolvedChild
}

function Assert-NotReparseDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Get-Item -LiteralPath $Path -Force
    if (
        -not $item.PSIsContainer -or
        (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    ) {
        throw "Private runtime path is not a regular directory: $Path"
    }
}

function Assert-RegularManagedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description,
        [ValidateRange(1, 65536)][long]$MaximumBytes = 16384
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description is not a regular file."
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Description cannot be a symbolic link or reparse point."
    }
    if ($item.Length -gt $MaximumBytes) {
        throw "$Description exceeds its size limit."
    }
}

function Get-DirectorySecurityDescriptor {
    param([Parameter(Mandatory = $true)][string]$Path)
    $directory = New-Object System.IO.DirectoryInfo($Path)
    $extensions = [Type]::GetType(
        "System.IO.FileSystemAclExtensions, System.IO.FileSystem.AccessControl",
        $false
    )
    if ($null -ne $extensions) {
        return [System.IO.FileSystemAclExtensions]::GetAccessControl($directory)
    }
    return [System.IO.Directory]::GetAccessControl($Path)
}

function Set-DirectorySecurityDescriptor {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Security
    )
    $directory = New-Object System.IO.DirectoryInfo($Path)
    $extensions = [Type]::GetType(
        "System.IO.FileSystemAclExtensions, System.IO.FileSystem.AccessControl",
        $false
    )
    if ($null -ne $extensions) {
        [System.IO.FileSystemAclExtensions]::SetAccessControl(
            $directory,
            $Security
        )
        return
    }
    [System.IO.Directory]::SetAccessControl($Path, $Security)
}

function Set-NewWindowsRuntimeAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = New-Object System.Security.Principal.SecurityIdentifier(
        "S-1-5-18"
    )
    $administratorsSid = New-Object System.Security.Principal.SecurityIdentifier(
        "S-1-5-32-544"
    )
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetOwner($currentSid)
    $security.SetAccessRuleProtection($true, $false)
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        [void]$security.AddAccessRule($rule)
    }
    Set-DirectorySecurityDescriptor -Path $Path -Security $security
}

function Assert-WindowsRuntimeAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $allowedSids = @{
        $currentSid.Value = $true
        "S-1-5-18" = $true
        "S-1-5-32-544" = $true
    }
    $security = Get-DirectorySecurityDescriptor -Path $Path
    $ownerSid = $security.GetOwner(
        [System.Security.Principal.SecurityIdentifier]
    )
    if ($ownerSid.Value -ne $currentSid.Value) {
        throw "Private runtime directory is not owned by the current user."
    }
    if (-not $security.AreAccessRulesProtected) {
        throw "Private runtime directory inherits access rules; refusing it."
    }
    $rules = $security.GetAccessRules(
        $true,
        $true,
        [System.Security.Principal.SecurityIdentifier]
    )
    $broadWriteMask = [int][System.Security.AccessControl.FileSystemRights]::Write -bor `
        [int][System.Security.AccessControl.FileSystemRights]::Delete -bor `
        [int][System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor `
        [int][System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor `
        [int][System.Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $rules) {
        if (
            $rule.AccessControlType -eq `
                [System.Security.AccessControl.AccessControlType]::Allow -and
            (([int]$rule.FileSystemRights -band $broadWriteMask) -ne 0) -and
            -not $allowedSids.ContainsKey($rule.IdentityReference.Value)
        ) {
            throw "Private runtime directory grants broad write access to another identity."
        }
    }
}

function Initialize-PrivateRuntimeDirectory {
    $runtimeRoot = [System.IO.Path]::GetDirectoryName($runtimeDirectory)
    $applicationRoot = [System.IO.Path]::GetDirectoryName($runtimeRoot)
    New-Item -ItemType Directory -Path $applicationRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    Assert-NotReparseDirectory -Path $applicationRoot
    Assert-NotReparseDirectory -Path $runtimeRoot
    $alreadyExists = Test-Path -LiteralPath $runtimeDirectory
    if ($alreadyExists -and -not (Test-Path -LiteralPath $runtimeDirectory -PathType Container)) {
        throw "Private runtime path already exists and is not a directory."
    }
    if (-not $alreadyExists) {
        New-Item -ItemType Directory -Path $runtimeDirectory | Out-Null
        if ($isWindowsRuntime) {
            Set-NewWindowsRuntimeAcl -Path $runtimeDirectory
        } else {
            & chmod 700 -- $runtimeDirectory
            if ($LASTEXITCODE -ne 0) {
                throw "Unable to set private runtime directory permissions."
            }
        }
    }
    Assert-NotReparseDirectory -Path $runtimeDirectory
    if ($isWindowsRuntime) {
        Assert-WindowsRuntimeAcl -Path $runtimeDirectory
    } else {
        & $nodePath $launcherScript --verify-runtime
        if ($LASTEXITCODE -ne 0) {
            throw "Private runtime directory verification failed."
        }
    }
}

function Get-ConfiguredPort {
    $configSource = if (Test-Path -LiteralPath $baseConfigFile -PathType Leaf) {
        $baseConfigFile
    } elseif (Test-Path -LiteralPath $exampleConfigFile -PathType Leaf) {
        $exampleConfigFile
    } else {
        throw "Neither private nor example configuration is available."
    }
    $base = ConvertFrom-ExactJson -Json (
        Get-Content -LiteralPath $configSource -Raw
    )
    $port = $base.port
    if (Test-Path -LiteralPath $configurationStateFile -PathType Leaf) {
        $state = ConvertFrom-ExactJson -Json (
            Get-Content -LiteralPath $configurationStateFile -Raw
        )
        if ($null -ne $state.activeVersion) {
            $activeVersions = @($state.versions | Where-Object {
                $_.version -eq $state.activeVersion
            })
            if ($activeVersions.Count -ne 1) {
                throw "Active configuration state is inconsistent."
            }
            $port = $activeVersions[0].configuration.port
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

function New-ControlToken {
    $bytes = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    } finally {
        $generator.Dispose()
    }
    return [Convert]::ToBase64String($bytes)
}

function Get-HmacBase64 {
    param(
        [Parameter(Mandatory = $true)][string]$Token,
        [Parameter(Mandatory = $true)][string]$Payload
    )
    try {
        $key = [Convert]::FromBase64String($Token)
    } catch {
        throw "Managed control token is not valid base64."
    }
    if (
        $key.Length -ne 32 -or
        [Convert]::ToBase64String($key) -ne $Token
    ) {
        throw "Managed control token is not 256 bits."
    }
    $hmac = New-Object System.Security.Cryptography.HMACSHA256(,$key)
    try {
        $digest = $hmac.ComputeHash(
            [System.Text.Encoding]::UTF8.GetBytes($Payload)
        )
        return [Convert]::ToBase64String($digest)
    } finally {
        $hmac.Dispose()
    }
}

function Test-FixedTimeString {
    param(
        [AllowEmptyString()][Parameter(Mandatory = $true)][string]$Left,
        [AllowEmptyString()][Parameter(Mandatory = $true)][string]$Right
    )
    $leftBytes = [System.Text.Encoding]::UTF8.GetBytes($Left)
    $rightBytes = [System.Text.Encoding]::UTF8.GetBytes($Right)
    $difference = $leftBytes.Length -bxor $rightBytes.Length
    $maximum = [Math]::Max($leftBytes.Length, $rightBytes.Length)
    for ($index = 0; $index -lt $maximum; $index += 1) {
        $leftByte = if ($index -lt $leftBytes.Length) { $leftBytes[$index] } else { 0 }
        $rightByte = if ($index -lt $rightBytes.Length) { $rightBytes[$index] } else { 0 }
        $difference = $difference -bor ($leftByte -bxor $rightByte)
    }
    return $difference -eq 0
}

function Get-LaunchPayload {
    param([Parameter(Mandatory = $true)]$Launch)
    return @(
        "launch-v1",
        [string]$Launch.processId,
        [string]$Launch.instanceId,
        [string]$Launch.startIdentity,
        [string]$Launch.projectDigest
    ) -join "`n"
}

function Get-ControlPayload {
    param([Parameter(Mandatory = $true)]$State)
    return @(
        "control-v1",
        [string]$State.processId,
        [string]$State.instanceId,
        [string]$State.startIdentity,
        [string]$State.processStartTimeUtcTicks,
        [string]$State.port,
        [string]$State.projectDigest
    ) -join "`n"
}

function Get-ReceiptPayload {
    param([Parameter(Mandatory = $true)]$Receipt)
    $errorCode = if ($null -eq $Receipt.errorCode) {
        ""
    } else {
        [string]$Receipt.errorCode
    }
    return @(
        "receipt-v1",
        [string]$Receipt.phase,
        [string]$Receipt.status,
        [string]$Receipt.processId,
        [string]$Receipt.instanceId,
        [string]$Receipt.startIdentity,
        [string]$Receipt.atUnixMilliseconds,
        $errorCode
    ) -join "`n"
}

function Assert-ControlState {
    param([Parameter(Mandatory = $true)]$Value)
    $properties = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @(
        "controlHmac",
        "controlToken",
        "instanceId",
        "nodePath",
        "port",
        "processId",
        "processStartTimeUtcTicks",
        "projectDigest",
        "projectDirectory",
        "schemaVersion",
        "serverScript",
        "startIdentity"
    )
    if (Compare-Object -ReferenceObject $expected -DifferenceObject $properties) {
        throw "Process control state has an invalid shape."
    }
    if (
        $Value.schemaVersion -ne 2 -or
        ($Value.processId -isnot [int] -and $Value.processId -isnot [long]) -or
        [int]$Value.processId -lt 1 -or
        ($Value.port -isnot [int] -and $Value.port -isnot [long]) -or
        [int]$Value.port -lt 1 -or
        [int]$Value.port -gt 65535 -or
        [string]$Value.instanceId -notmatch `
            '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or
        [string]$Value.startIdentity -notmatch '^[a-f0-9]{64}$' -or
        [string]$Value.controlHmac -notmatch '^[A-Za-z0-9+/]{43}=$' -or
        [string]$Value.projectDigest -ne $projectDigest -or
        -not $pathComparer.Equals(
            [System.IO.Path]::GetFullPath([string]$Value.projectDirectory),
            $projectDirectory
        ) -or
        -not $pathComparer.Equals(
            [System.IO.Path]::GetFullPath([string]$Value.serverScript),
            $serverScript
        ) -or
        -not $pathComparer.Equals(
            [System.IO.Path]::GetFullPath([string]$Value.nodePath),
            $nodePath
        )
    ) {
        throw "Process control state is invalid."
    }
    if ([string]$Value.processStartTimeUtcTicks -notmatch '^[1-9][0-9]{16,18}$') {
        throw "Process control start time is invalid."
    }
    $expectedHmac = Get-HmacBase64 `
        -Token ([string]$Value.controlToken) `
        -Payload (Get-ControlPayload -State $Value)
    if (-not (Test-FixedTimeString `
        -Left $expectedHmac `
        -Right ([string]$Value.controlHmac))) {
        throw "Process control authentication failed."
    }
}

function Read-ControlStateFromPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    Assert-RegularManagedFile `
        -Path $Path `
        -Description "Process control state"
    $value = ConvertFrom-ExactJson -Json (
        Get-Content -LiteralPath $Path -Raw
    )
    Assert-ControlState -Value $value
    return $value
}

function Read-ControlState {
    if (-not (Test-Path -LiteralPath $controlFile)) {
        return $null
    }
    return Read-ControlStateFromPath -Path $controlFile
}

function Test-SameControlIdentity {
    param(
        [Parameter(Mandatory = $true)]$Left,
        [Parameter(Mandatory = $true)]$Right
    )
    return (
        [int]$Left.processId -eq [int]$Right.processId -and
        [string]$Left.instanceId -eq [string]$Right.instanceId -and
        [string]$Left.startIdentity -eq [string]$Right.startIdentity -and
        [string]$Left.processStartTimeUtcTicks -eq `
            [string]$Right.processStartTimeUtcTicks -and
        (Test-FixedTimeString `
            -Left ([string]$Left.controlHmac) `
            -Right ([string]$Right.controlHmac))
    )
}

function Write-ControlState {
    param([Parameter(Mandatory = $true)]$State)
    Assert-ControlState -Value ([pscustomobject]$State)
    $safeControlFile = Assert-DirectChildPath `
        -Parent $runtimeDirectory `
        -Child $controlFile
    if (Test-Path -LiteralPath $safeControlFile) {
        throw "Process control state already exists; refusing to replace it."
    }
    $temporary = Assert-DirectChildPath `
        -Parent $runtimeDirectory `
        -Child (Join-Path $runtimeDirectory "control-$PID-$([guid]::NewGuid().ToString('N')).tmp")
    $json = ([pscustomobject]$State) | ConvertTo-Json -Depth 3 -Compress
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($json)
    $stream = $null
    try {
        $stream = New-Object System.IO.FileStream(
            $temporary,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None,
            4096,
            [System.IO.FileOptions]::WriteThrough
        )
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        [System.IO.File]::Move($temporary, $safeControlFile)
        $readback = Get-Content -LiteralPath $safeControlFile -Raw
        if ($readback -ne $json) {
            throw "Process control durable readback did not match."
        }
        $verified = Read-ControlState
        if (-not (Test-SameControlIdentity -Left $verified -Right ([pscustomobject]$State))) {
            throw "Process control identity changed during durable publication."
        }
    } finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Remove-ControlState {
    param([Parameter(Mandatory = $true)]$ExpectedState)
    if (-not (Test-Path -LiteralPath $controlFile)) {
        return
    }
    $tombstone = Assert-DirectChildPath `
        -Parent $runtimeDirectory `
        -Child (Join-Path $runtimeDirectory "control-remove-$PID-$([guid]::NewGuid().ToString('N')).tmp")
    [System.IO.File]::Move($controlFile, $tombstone)
    try {
        $removed = Read-ControlStateFromPath -Path $tombstone
        if (-not (Test-SameControlIdentity -Left $removed -Right $ExpectedState)) {
            if (-not (Test-Path -LiteralPath $controlFile)) {
                [System.IO.File]::Move($tombstone, $controlFile)
            }
            throw "Process control identity changed; refusing to remove it."
        }
        Remove-Item -LiteralPath $tombstone -Force
    } catch {
        if (
            (Test-Path -LiteralPath $tombstone -PathType Leaf) -and
            -not (Test-Path -LiteralPath $controlFile)
        ) {
            [System.IO.File]::Move($tombstone, $controlFile)
        }
        throw
    }
}

function Get-ManagedProcess {
    param([Parameter(Mandatory = $true)]$State)
    $process = Get-Process -Id ([int]$State.processId) -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $null
    }
    if (
        [string]::IsNullOrWhiteSpace($process.Path) -or
        -not $pathComparer.Equals(
            [System.IO.Path]::GetFullPath($process.Path),
            [System.IO.Path]::GetFullPath([string]$State.nodePath)
        ) -or
        [string]($process.StartTime.ToUniversalTime().Ticks) -ne `
            [string]$State.processStartTimeUtcTicks
    ) {
        throw "Recorded PID belongs to a different process; refusing to control it."
    }
    return $process
}

function Test-LoopbackTcpListener {
    param([Parameter(Mandatory = $true)][int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    $operation = $null
    $waitHandle = $null
    try {
        $operation = $client.BeginConnect(
            [System.Net.IPAddress]::Loopback,
            $Port,
            $null,
            $null
        )
        $waitHandle = $operation.AsyncWaitHandle
        if (-not $waitHandle.WaitOne(500)) {
            return $false
        }
        $client.EndConnect($operation)
        return $client.Connected
    } catch {
        return $false
    } finally {
        if ($null -ne $waitHandle) {
            $waitHandle.Dispose()
        }
        $client.Dispose()
    }
}

function Wait-ForBoundedAsyncOperation {
    param(
        [Parameter(Mandatory = $true)][System.IAsyncResult]$Operation,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )
    $remaining = [int][Math]::Ceiling(
        ($Deadline - [DateTime]::UtcNow).TotalMilliseconds
    )
    if ($remaining -le 0 -or -not $Operation.AsyncWaitHandle.WaitOne($remaining)) {
        throw "The loopback HTTP request exceeded its fixed deadline."
    }
}

function Invoke-BoundedLoopbackJsonGet {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateRange(100, 10000)][int]$TimeoutMilliseconds,
        [ValidateRange(1, 1048576)][int]$MaximumBytes
    )
    if ($Path -notmatch '^/[a-z0-9/-]+$') {
        throw "The loopback HTTP path is invalid."
    }
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    $uri = New-Object System.Uri("http://127.0.0.1:$Port$Path")
    $request = [System.Net.HttpWebRequest]::CreateHttp($uri)
    $request.Method = "GET"
    $request.Accept = "application/json"
    $request.AllowAutoRedirect = $false
    $request.AutomaticDecompression = [System.Net.DecompressionMethods]::None
    $request.Credentials = $null
    $request.KeepAlive = $false
    $request.MaximumResponseHeadersLength = 16
    $request.PreAuthenticate = $false
    $request.Proxy = $null
    $request.ReadWriteTimeout = $TimeoutMilliseconds
    $request.Timeout = $TimeoutMilliseconds
    $response = $null
    $stream = $null
    try {
        $responseOperation = $request.BeginGetResponse($null, $null)
        try {
            Wait-ForBoundedAsyncOperation `
                -Operation $responseOperation `
                -Deadline $deadline
            $response = $request.EndGetResponse($responseOperation)
        } finally {
            $responseOperation.AsyncWaitHandle.Dispose()
        }
        if (
            [int]$response.StatusCode -ne 200 -or
            [string]$response.ContentType -notmatch `
                '^\s*application/json(?:\s*;|\s*$)' -or
            $response.ContentLength -gt $MaximumBytes
        ) {
            throw "The loopback HTTP response is not an accepted bounded JSON response."
        }
        $stream = $response.GetResponseStream()
        $bytes = New-Object byte[] ($MaximumBytes + 1)
        $total = 0
        while ($true) {
            $readOperation = $stream.BeginRead(
                $bytes,
                $total,
                $bytes.Length - $total,
                $null,
                $null
            )
            try {
                Wait-ForBoundedAsyncOperation `
                    -Operation $readOperation `
                    -Deadline $deadline
                $read = $stream.EndRead($readOperation)
            } finally {
                $readOperation.AsyncWaitHandle.Dispose()
            }
            if ($read -eq 0) {
                break
            }
            $total += $read
            if ($total -gt $MaximumBytes) {
                throw "The loopback HTTP response exceeded its size limit."
            }
        }
        $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
        return ConvertFrom-ExactJson -Json $utf8.GetString($bytes, 0, $total)
    } catch {
        $request.Abort()
        throw
    } finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        if ($null -ne $response) {
            $response.Dispose()
        }
    }
}

function Get-Liveness {
    param([Parameter(Mandatory = $true)][int]$Port)
    try {
        return Invoke-RestMethod `
            -Uri "http://127.0.0.1:$Port/api/live" `
            -TimeoutSec 3
    } catch {
        return $null
    }
}

function Test-MatchingLiveness {
    param(
        [AllowNull()][Parameter(Mandatory = $true)]$Liveness,
        [Parameter(Mandatory = $true)]$State,
        [AllowNull()][string]$LifecycleState = $null
    )
    if (
        $null -eq $Liveness -or
        $Liveness.live -ne $true -or
        $Liveness.service -ne "mydashboard" -or
        $Liveness.managed -ne $true -or
        [int]$Liveness.processId -ne [int]$State.processId -or
        [string]$Liveness.instanceId -ne [string]$State.instanceId -or
        [string]$Liveness.startIdentity -ne [string]$State.startIdentity
    ) {
        return $false
    }
    return (
        [string]::IsNullOrEmpty($LifecycleState) -or
        [string]$Liveness.lifecycleState -eq $LifecycleState
    )
}

function Test-ReadySystemStatus {
    param([AllowNull()][Parameter(Mandatory = $true)]$Value)
    if ($null -eq $Value -or $Value -isnot [pscustomobject]) {
        return $false
    }
    $schemaVersion = $Value.PSObject.Properties["schemaVersion"]
    $readiness = $Value.PSObject.Properties["readiness"]
    if (
        $null -eq $schemaVersion -or
        (
            $schemaVersion.Value -isnot [int] -and
            $schemaVersion.Value -isnot [long]
        ) -or
        [long]$schemaVersion.Value -ne 1 -or
        $null -eq $readiness -or
        $readiness.Value -isnot [pscustomobject]
    ) {
        return $false
    }
    $ready = $readiness.Value.PSObject.Properties["ready"]
    return (
        $null -ne $ready -and
        $ready.Value -is [bool] -and
        $ready.Value -eq $true
    )
}

function Test-ManagedReadiness {
    param([Parameter(Mandatory = $true)]$State)
    try {
        $status = Invoke-BoundedLoopbackJsonGet `
            -Port ([int]$State.port) `
            -Path "/api/system/status" `
            -TimeoutMilliseconds 3000 `
            -MaximumBytes 65536
        if (-not (Test-ReadySystemStatus -Value $status)) {
            return $false
        }
        if ($null -eq (Get-ManagedProcess -State $State)) {
            return $false
        }
        $liveness = Get-Liveness -Port ([int]$State.port)
        return Test-MatchingLiveness -Liveness $liveness -State $State
    } catch {
        return $false
    }
}

function Wait-ForMatchingLiveness {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$LifecycleState
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($null -eq (Get-ManagedProcess -State $State)) {
            throw "MyDashboard exited before becoming live."
        }
        $liveness = Get-Liveness -Port ([int]$State.port)
        if (Test-MatchingLiveness `
            -Liveness $liveness `
            -State $State `
            -LifecycleState $LifecycleState) {
            return $liveness
        }
        Start-Sleep -Milliseconds 200
    }
    throw "MyDashboard did not reach $LifecycleState before the timeout."
}

function Get-ControlHeaders {
    param([Parameter(Mandatory = $true)]$State)
    return @{
        Origin = "http://127.0.0.1:$($State.port)"
        "X-MyDashboard-Action" = "1"
        "X-MyDashboard-Control-Token" = [string]$State.controlToken
        "X-MyDashboard-Process-Id" = [string]$State.processId
        "X-MyDashboard-Instance-Id" = [string]$State.instanceId
        "X-MyDashboard-Start-Identity" = [string]$State.startIdentity
    }
}

function Invoke-ManagedClaim {
    param([Parameter(Mandatory = $true)]$State)
    $lastError = $null
    for ($attempt = 0; $attempt -lt 2; $attempt += 1) {
        try {
            $response = Invoke-RestMethod `
                -Method Post `
                -Uri "http://127.0.0.1:$($State.port)/api/system/claim" `
                -Headers (Get-ControlHeaders -State $State) `
                -TimeoutSec 10
            if ($response.claimed -eq $true) {
                return
            }
            $lastError = New-Object System.InvalidOperationException(
                "MyDashboard did not acknowledge the managed claim."
            )
        } catch {
            $lastError = $_.Exception
            $liveness = Get-Liveness -Port ([int]$State.port)
            if (Test-MatchingLiveness `
                -Liveness $liveness `
                -State $State `
                -LifecycleState "running") {
                return
            }
        }
        Start-Sleep -Milliseconds 150
    }
    throw $lastError
}

function Get-ReceiptPath {
    param(
        [Parameter(Mandatory = $true)]$State,
        [ValidateSet("requested", "terminal")][string]$Phase
    )
    return Assert-DirectChildPath `
        -Parent $runtimeDirectory `
        -Child (Join-Path $runtimeDirectory "mydashboard-shutdown-$($State.instanceId)-$Phase.json")
}

function Read-ShutdownReceipt {
    param(
        [Parameter(Mandatory = $true)]$State,
        [ValidateSet("requested", "terminal")][string]$Phase
    )
    $path = Get-ReceiptPath -State $State -Phase $Phase
    if (-not (Test-Path -LiteralPath $path)) {
        return $null
    }
    Assert-RegularManagedFile -Path $path -Description "Shutdown receipt"
    $receipt = ConvertFrom-ExactJson -Json (
        Get-Content -LiteralPath $path -Raw
    )
    $properties = @($receipt.PSObject.Properties.Name | Sort-Object)
    if (
        (Compare-Object `
            -ReferenceObject @(
                "atUnixMilliseconds",
                "errorCode",
                "hmac",
                "instanceId",
                "phase",
                "processId",
                "schemaVersion",
                "startIdentity",
                "status"
            ) `
            -DifferenceObject $properties) -or
        $receipt.schemaVersion -ne 1 -or
        [string]$receipt.phase -ne $Phase -or
        [int]$receipt.processId -ne [int]$State.processId -or
        [string]$receipt.instanceId -ne [string]$State.instanceId -or
        [string]$receipt.startIdentity -ne [string]$State.startIdentity -or
        [string]$receipt.hmac -notmatch '^[A-Za-z0-9+/]{43}=$' -or
        (
            $Phase -eq "requested" -and
            [string]$receipt.status -ne "unknown"
        ) -or
        (
            $Phase -eq "terminal" -and
            [string]$receipt.status -notin @("success", "failure")
        )
    ) {
        throw "Shutdown receipt identity or shape is invalid."
    }
    if ([string]$receipt.atUnixMilliseconds -notmatch '^[1-9][0-9]{10,15}$') {
        throw "Shutdown receipt timestamp is invalid."
    }
    $expectedHmac = Get-HmacBase64 `
        -Token ([string]$State.controlToken) `
        -Payload (Get-ReceiptPayload -Receipt $receipt)
    if (-not (Test-FixedTimeString `
        -Left $expectedHmac `
        -Right ([string]$receipt.hmac))) {
        throw "Shutdown receipt authentication failed."
    }
    return $receipt
}

function Invoke-ManagedShutdownRequest {
    param([Parameter(Mandatory = $true)]$State)
    $response = Invoke-RestMethod `
        -Method Post `
        -Uri "http://127.0.0.1:$($State.port)/api/system/shutdown" `
        -Headers (Get-ControlHeaders -State $State) `
        -TimeoutSec 10
    if ($response.accepted -ne $true) {
        throw "MyDashboard did not acknowledge graceful shutdown."
    }
    $requested = Read-ShutdownReceipt -State $State -Phase "requested"
    if ($null -eq $requested) {
        throw "MyDashboard acknowledged shutdown without a durable request receipt."
    }
}

function Wait-ForShutdownOutcome {
    param([Parameter(Mandatory = $true)]$State)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $terminal = Read-ShutdownReceipt -State $State -Phase "terminal"
        if ($null -ne $terminal -and $terminal.status -eq "failure") {
            throw "MyDashboard reported a graceful shutdown failure; control state was retained."
        }
        $process = Get-Process `
            -Id ([int]$State.processId) `
            -ErrorAction SilentlyContinue
        if ($null -eq $process -and $null -ne $terminal) {
            if ($terminal.status -ne "success") {
                throw "MyDashboard shutdown did not produce a success receipt."
            }
            return $terminal
        }
        Start-Sleep -Milliseconds 200
    }
    throw "MyDashboard shutdown outcome is unknown; it was not force-killed and control state was retained."
}

function Remove-ShutdownReceipts {
    param([Parameter(Mandatory = $true)]$State)
    foreach ($phase in @("requested", "terminal")) {
        $path = Get-ReceiptPath -State $State -Phase $phase
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
}

function Complete-SuccessfulShutdown {
    param([Parameter(Mandatory = $true)]$State)
    $terminal = Read-ShutdownReceipt -State $State -Phase "terminal"
    if ($null -eq $terminal -or $terminal.status -ne "success") {
        return $false
    }
    if ($null -ne (Get-Process -Id ([int]$State.processId) -ErrorAction SilentlyContinue)) {
        return $false
    }
    Remove-ControlState -ExpectedState $State
    Remove-ShutdownReceipts -State $State
    return $true
}

function Assert-OfflineRestoreAllowed {
    $state = Read-ControlState
    if ($null -ne $state) {
        if ($null -ne (Get-ManagedProcess -State $state)) {
            throw "MyDashboard must be stopped before offline restore."
        }
        if (-not (Complete-SuccessfulShutdown -State $state)) {
            throw "Managed process outcome is not durably successful; refusing offline restore."
        }
    }
    $port = Get-ConfiguredPort
    if (Test-LoopbackTcpListener -Port $port) {
        throw "The configured port has a listener; refusing offline restore."
    }
}

function Invoke-OfflineRestore {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("Recover", "Activate")]
        [string]$Mode,
        [string]$RequestedBackupId
    )
    if (-not (Test-Path -LiteralPath $offlineRestoreScript -PathType Leaf)) {
        throw "The offline restore helper is unavailable."
    }
    Assert-RegularManagedFile `
        -Path $offlineRestoreScript `
        -Description "Offline restore helper"
    if (
        $Mode -eq "Activate" -and
        [string]$RequestedBackupId -notmatch '^backup-[a-f0-9]{64}$'
    ) {
        throw "BackupId must be one content-addressed backup identifier."
    }
    $environment = @{
        MYDASHBOARD_OFFLINE_RESTORE_PROJECT_DIGEST = $projectDigest
        MYDASHBOARD_OFFLINE_RESTORE_AUTHORITY = "manager-v1"
    }
    $previous = @{}
    foreach ($name in $environment.Keys) {
        $previous[$name] = [Environment]::GetEnvironmentVariable(
            $name,
            [EnvironmentVariableTarget]::Process
        )
        [Environment]::SetEnvironmentVariable(
            $name,
            [string]$environment[$name],
            [EnvironmentVariableTarget]::Process
        )
    }
    $output = ""
    $helperExitCode = -1
    try {
        $arguments = if ($Mode -eq "Recover") {
            @($offlineRestoreScript, "--recover")
        } else {
            @($offlineRestoreScript, "--activate", $RequestedBackupId)
        }
        $output = & $nodePath @arguments | Out-String
        $helperExitCode = $LASTEXITCODE
    } finally {
        foreach ($name in $environment.Keys) {
            [Environment]::SetEnvironmentVariable(
                $name,
                $previous[$name],
                [EnvironmentVariableTarget]::Process
            )
        }
    }
    try {
        $result = ConvertFrom-ExactJson -Json $output
    } catch {
        throw "The offline restore helper returned invalid data."
    }
    $properties = @($result.PSObject.Properties.Name | Sort-Object)
    if (
        $result.schemaVersion -ne 1 -or
        $result.ok -ne $true -or
        $helperExitCode -ne 0 -or
        (Compare-Object `
            -ReferenceObject @("action", "ok", "result", "schemaVersion") `
            -DifferenceObject $properties)
    ) {
        $code = if (
            $null -ne $result.error -and
            [string]$result.error.code -match '^[A-Z][A-Z0-9_]{2,63}$'
        ) {
            [string]$result.error.code
        } else {
            "OFFLINE_RESTORE_FAILED"
        }
        throw "Offline restore failed safely ($code)."
    }
    return $result
}

function Invoke-OfflineRestoreRecoveryIfPresent {
    if (-not (Test-Path -LiteralPath $restoreControlDirectory)) {
        return
    }
    Assert-NotReparseDirectory -Path $restoreControlDirectory
    Assert-OfflineRestoreAllowed
    [void](Invoke-OfflineRestore -Mode Recover)
}

function Invoke-Launcher {
    param(
        [Parameter(Mandatory = $true)][string]$ResultPath,
        [Parameter(Mandatory = $true)][string]$Token
    )
    $environment = @{
        MYDASHBOARD_MANAGED_TOKEN = $Token
        MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY = $runtimeDirectory
        MYDASHBOARD_MANAGED_PROJECT_DIGEST = $projectDigest
        MYDASHBOARD_MANAGED_CLAIM_TIMEOUT_MS = [string]([Math]::Max(
            5000,
            $TimeoutSeconds * 1000
        ))
        MYDASHBOARD_MANAGED_LOG_DIRECTORY = $runtimeLogDirectory
    }
    $previous = @{}
    foreach ($name in $environment.Keys) {
        $previous[$name] = [Environment]::GetEnvironmentVariable(
            $name,
            [EnvironmentVariableTarget]::Process
        )
        [Environment]::SetEnvironmentVariable(
            $name,
            [string]$environment[$name],
            [EnvironmentVariableTarget]::Process
        )
    }
    try {
        if ($isWindowsRuntime) {
            $launcherProcess = Start-Process `
                -FilePath $nodePath `
                -ArgumentList @(
                    ('"' + $launcherScript + '"'),
                    ('"' + $ResultPath + '"')
                ) `
                -WorkingDirectory $projectDirectory `
                -WindowStyle Hidden `
                -PassThru
            if (-not $launcherProcess.WaitForExit(10000)) {
                Stop-Process -Id $launcherProcess.Id -ErrorAction SilentlyContinue
                throw "The detached MyDashboard process launcher timed out."
            }
            if ($launcherProcess.ExitCode -ne 0) {
                throw "The detached MyDashboard process launcher failed."
            }
        } else {
            & $nodePath $launcherScript $ResultPath
            if ($LASTEXITCODE -ne 0) {
                throw "The detached MyDashboard process launcher failed."
            }
        }
    } finally {
        foreach ($name in $environment.Keys) {
            [Environment]::SetEnvironmentVariable(
                $name,
                $previous[$name],
                [EnvironmentVariableTarget]::Process
            )
        }
    }
}

function Start-ManagedServer {
    $port = Get-ConfiguredPort
    $existingState = Read-ControlState
    if ($null -ne $existingState) {
        $managed = Get-ManagedProcess -State $existingState
        if ($null -ne $managed) {
            $liveness = Get-Liveness -Port ([int]$existingState.port)
            if (-not (Test-MatchingLiveness `
                -Liveness $liveness `
                -State $existingState `
                -LifecycleState "running")) {
                throw "The managed process is alive but does not expose matching running liveness."
            }
            return [pscustomobject]@{
                Port = [int]$existingState.port
                Message = "MyDashboard is already running at http://127.0.0.1:$($existingState.port)."
            }
        }
        if (-not (Complete-SuccessfulShutdown -State $existingState)) {
            throw "Recorded MyDashboard is dead without a durable success receipt; refusing a new writer."
        }
    }

    if (Test-LoopbackTcpListener -Port $port) {
        throw "Port $port already has an unmanaged listener; refusing to replace it."
    }

    $token = New-ControlToken
    $launchResult = Assert-DirectChildPath `
        -Parent $runtimeDirectory `
        -Child (Join-Path $runtimeDirectory "mydashboard-launch-result-$PID-$([guid]::NewGuid().ToString('N')).json")
    $state = $null
    $controlWritten = $false
    try {
        try {
            Invoke-Launcher -ResultPath $launchResult -Token $token
            if (-not (Test-Path -LiteralPath $launchResult)) {
                throw "The detached MyDashboard process launcher returned no identity."
            }
            Assert-RegularManagedFile `
                -Path $launchResult `
                -Description "Detached launch identity"
            $launch = ConvertFrom-ExactJson -Json (
                Get-Content -LiteralPath $launchResult -Raw
            )
        } finally {
            Remove-Item -LiteralPath $launchResult -Force -ErrorAction SilentlyContinue
        }
        $launchProperties = @($launch.PSObject.Properties.Name | Sort-Object)
        if (
            (Compare-Object `
                -ReferenceObject @(
                    "hmac",
                    "instanceId",
                    "processId",
                    "projectDigest",
                    "schemaVersion",
                    "startIdentity"
                ) `
                -DifferenceObject $launchProperties) -or
            $launch.schemaVersion -ne 2 -or
            ($launch.processId -isnot [int] -and $launch.processId -isnot [long]) -or
            [int]$launch.processId -lt 1 -or
            [string]$launch.instanceId -notmatch `
                '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or
            [string]$launch.startIdentity -notmatch '^[a-f0-9]{64}$' -or
            [string]$launch.hmac -notmatch '^[A-Za-z0-9+/]{43}=$' -or
            [string]$launch.projectDigest -ne $projectDigest
        ) {
            throw "The detached MyDashboard process launcher returned invalid identity."
        }
        $expectedLaunchHmac = Get-HmacBase64 `
            -Token $token `
            -Payload (Get-LaunchPayload -Launch $launch)
        if (-not (Test-FixedTimeString `
            -Left $expectedLaunchHmac `
            -Right ([string]$launch.hmac))) {
            throw "The detached MyDashboard process launcher identity was not authenticated."
        }
        $process = Get-Process -Id ([int]$launch.processId) -ErrorAction Stop
        if (
            [string]::IsNullOrWhiteSpace($process.Path) -or
            -not $pathComparer.Equals(
                [System.IO.Path]::GetFullPath($process.Path),
                $nodePath
            )
        ) {
            throw "The detached MyDashboard process has an unexpected executable."
        }
        $state = [ordered]@{
            schemaVersion = 2
            processId = $process.Id
            processStartTimeUtcTicks = [string]($process.StartTime.ToUniversalTime().Ticks)
            nodePath = $nodePath
            projectDirectory = $projectDirectory
            serverScript = $serverScript
            port = $port
            instanceId = [string]$launch.instanceId
            startIdentity = [string]$launch.startIdentity
            projectDigest = $projectDigest
            controlToken = $token
            controlHmac = ""
        }
        $state.controlHmac = Get-HmacBase64 `
            -Token $token `
            -Payload (Get-ControlPayload -State ([pscustomobject]$state))
        Wait-ForMatchingLiveness `
            -State ([pscustomobject]$state) `
            -LifecycleState "pending_claim" | Out-Null
        Write-ControlState -State $state
        $controlWritten = $true
        Invoke-ManagedClaim -State ([pscustomobject]$state)
        Wait-ForMatchingLiveness `
            -State ([pscustomobject]$state) `
            -LifecycleState "running" | Out-Null
    } catch {
        $startError = $_
        if ($null -ne $state) {
            try {
                Invoke-ManagedShutdownRequest -State ([pscustomobject]$state)
                Wait-ForShutdownOutcome -State ([pscustomobject]$state) | Out-Null
                if ($controlWritten) {
                    Remove-ControlState -ExpectedState ([pscustomobject]$state)
                }
                Remove-ShutdownReceipts -State ([pscustomobject]$state)
            } catch {
                # The child owns a pending-claim watchdog. Never force-kill an
                # identity whose authenticated graceful outcome is unknown.
            }
        }
        throw $startError
    }
    return [pscustomobject]@{
        Port = $port
        Message = "MyDashboard started at http://127.0.0.1:$port."
    }
}

function Stop-ManagedServer {
    $state = Read-ControlState
    if ($null -eq $state) {
        throw "No managed MyDashboard process is recorded; refusing to stop an arbitrary listener."
    }
    $process = Get-ManagedProcess -State $state
    if ($null -eq $process) {
        if (Complete-SuccessfulShutdown -State $state) {
            Write-Output "MyDashboard stopped gracefully."
            return
        }
        $terminal = Read-ShutdownReceipt -State $state -Phase "terminal"
        if ($null -ne $terminal -and $terminal.status -eq "failure") {
            throw "MyDashboard previously reported a shutdown failure; control state was retained."
        }
        throw "MyDashboard is dead without a durable success receipt; control state was retained."
    }
    $liveness = Get-Liveness -Port ([int]$state.port)
    if (-not (Test-MatchingLiveness -Liveness $liveness -State $state)) {
        throw "The recorded process does not expose matching MyDashboard identity; refusing to stop it."
    }
    Invoke-ManagedShutdownRequest -State $state
    Wait-ForShutdownOutcome -State $state | Out-Null
    Remove-ControlState -ExpectedState $state
    Remove-ShutdownReceipts -State $state
    Write-Output "MyDashboard stopped gracefully."
}

function Show-ManagedStatus {
    $state = Read-ControlState
    if ($null -eq $state) {
        $port = Get-ConfiguredPort
        if (Test-LoopbackTcpListener -Port $port) {
            return [pscustomobject]@{
                Code = 4
                Message = "MyDashboard has an unmanaged listener at http://127.0.0.1:$port."
            }
        }
        return [pscustomobject]@{ Code = 3; Message = "MyDashboard is stopped." }
    }
    $process = Get-ManagedProcess -State $state
    if ($null -eq $process) {
        $terminal = Read-ShutdownReceipt -State $state -Phase "terminal"
        $outcome = if ($null -eq $terminal) { "unknown" } else { $terminal.status }
        return [pscustomobject]@{
            Code = 6
            Message = "MyDashboard is stopped with retained $outcome control state."
        }
    }
    $liveness = Get-Liveness -Port ([int]$state.port)
    if (-not (Test-MatchingLiveness -Liveness $liveness -State $state)) {
        return [pscustomobject]@{
            Code = 5
            Message = "MyDashboard process exists but its authenticated identity does not match."
        }
    }
    if (-not (Test-ManagedReadiness -State $state)) {
        return [pscustomobject]@{
            Code = 5
            Message = "MyDashboard is running but readiness could not be confirmed safely."
        }
    }
    return [pscustomobject]@{
        Code = 0
        Message = "MyDashboard is running at http://127.0.0.1:$($state.port) (PID $($process.Id))."
    }
}

if ($Action -ne "Restore" -and -not [string]::IsNullOrWhiteSpace($BackupId)) {
    throw "BackupId is valid only for the Restore action."
}
if ($Action -eq "Restore" -and $OpenBrowser) {
    throw "Restore leaves the service stopped and cannot open a browser."
}

$managerMutex = New-Object System.Threading.Mutex($false, $mutexName)
$managerMutexHeld = $false
$exitCode = 0
try {
    try {
        $managerMutexHeld = $managerMutex.WaitOne(
            [TimeSpan]::FromSeconds($TimeoutSeconds)
        )
    } catch [System.Threading.AbandonedMutexException] {
        $managerMutexHeld = $true
    }
    if (-not $managerMutexHeld) {
        throw "Another MyDashboard process operation did not finish before the timeout."
    }
    Initialize-PrivateRuntimeDirectory

    switch ($Action) {
        "Start" {
            Invoke-OfflineRestoreRecoveryIfPresent
            $started = Start-ManagedServer
            Write-Output $started.Message
            if ($OpenBrowser) {
                Start-Process "http://127.0.0.1:$($started.Port)"
            }
        }
        "Stop" {
            Stop-ManagedServer
        }
        "Restart" {
            Stop-ManagedServer
            Invoke-OfflineRestoreRecoveryIfPresent
            $started = Start-ManagedServer
            Write-Output $started.Message
            if ($OpenBrowser) {
                Start-Process "http://127.0.0.1:$($started.Port)"
            }
        }
        "Status" {
            $status = Show-ManagedStatus
            Write-Output $status.Message
            $exitCode = $status.Code
        }
        "Restore" {
            Assert-OfflineRestoreAllowed
            $restored = Invoke-OfflineRestore `
                -Mode Activate `
                -RequestedBackupId $BackupId
            Write-Output "MyDashboard restored $($restored.result.backupId); the service remains stopped."
        }
    }
} finally {
    if ($managerMutexHeld) {
        $managerMutex.ReleaseMutex()
    }
    $managerMutex.Dispose()
}
exit $exitCode
