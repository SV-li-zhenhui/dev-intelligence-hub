$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$MaximumPacketBytes = 384 * 1024
$MaximumCredentialBytes = 65536
$MaximumPrivateFileBytes = 192 * 1024
$MaximumNameBytes = 128
$Utf8 = [Text.UTF8Encoding]::new($false, $true)
[Console]::InputEncoding = $Utf8
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Write-Response {
  param(
    [Parameter(Mandatory = $true)][string]$Status,
    [byte[]]$Bytes = $null
  )
  if ($null -eq $Bytes) {
    $packet = '{"schemaVersion":1,"status":"' + $Status + '"}'
  } else {
    $packet = '{"schemaVersion":1,"status":"' + $Status +
      '","bytesBase64":"' + [Convert]::ToBase64String($Bytes) + '"}'
  }
  $packetBytes = $Utf8.GetByteCount($packet)
  if ($packetBytes -lt 1 -or $packetBytes -gt $MaximumPacketBytes) {
    throw 'response packet is outside the fixed bound'
  }
  [Console]::Out.Write($packet)
  [Console]::Out.Flush()
}

function Read-RequestPacket {
  $inputStream = [Console]::OpenStandardInput()
  $memory = [IO.MemoryStream]::new()
  $buffer = New-Object byte[] 4096
  try {
    while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      if ($memory.Length + $count -gt $MaximumPacketBytes) {
        throw 'request packet is outside the fixed bound'
      }
      $memory.Write($buffer, 0, $count)
    }
    if ($memory.Length -lt 1) { throw 'request packet is empty' }
    return $Utf8.GetString($memory.ToArray())
  } finally {
    $memory.Dispose()
  }
}

function Assert-ExactKeys {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string[]]$Expected
  )
  if ($null -eq $Value -or $Value -isnot [Management.Automation.PSCustomObject]) {
    throw 'protocol record is invalid'
  }
  $actual = @($Value.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
  $wanted = @($Expected | Sort-Object)
  if ($actual.Count -ne $wanted.Count) { throw 'protocol keys are invalid' }
  for ($index = 0; $index -lt $wanted.Count; $index += 1) {
    if ($actual[$index] -cne $wanted[$index]) { throw 'protocol keys are invalid' }
  }
}

function Decode-CanonicalBase64 {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][int]$MaximumBytes
  )
  if (
    $Value -isnot [string] -or
    $Value.Length -lt 4 -or
    $Value -notmatch '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
  ) {
    throw 'base64 value is invalid'
  }
  $bytes = [Convert]::FromBase64String($Value)
  if (
    $bytes.Length -lt 1 -or
    $bytes.Length -gt $MaximumBytes -or
    [Convert]::ToBase64String($bytes) -cne $Value
  ) {
    throw 'base64 value is invalid'
  }
  return $bytes
}

function Decode-Path {
  param([Parameter(Mandatory = $true)]$Value)
  $bytes = Decode-CanonicalBase64 $Value 131068
  $decoded = $Utf8.GetString($bytes)
  if ($decoded.Length -lt 3 -or $decoded.Length -gt 32767) {
    throw 'path is invalid'
  }
  return $decoded
}

function Read-UnsignedIdentity {
  param([Parameter(Mandatory = $true)]$Value)
  if ($Value -isnot [string] -or $Value -notmatch '^(?:0|[1-9][0-9]*)$') {
    throw 'identity is invalid'
  }
  [uint64]$parsed = 0
  if (-not [uint64]::TryParse($Value, [ref]$parsed)) {
    throw 'identity is invalid'
  }
  return $parsed
}

function Read-Directory {
  param([Parameter(Mandatory = $true)]$Value)
  Assert-ExactKeys $Value @('path', 'device', 'inode')
  if (
    $Value.path -isnot [string] -or
    $Value.path.Length -lt 3 -or
    $Value.path.Length -gt 32767
  ) {
    throw 'directory path is invalid'
  }
  return @{
    Path = [string]$Value.path
    Device = Read-UnsignedIdentity $Value.device
    Inode = Read-UnsignedIdentity $Value.inode
  }
}

function Read-Name {
  param([Parameter(Mandatory = $true)]$Value)
  if (
    $Value -isnot [string] -or
    $Utf8.GetByteCount($Value) -lt 1 -or
    $Utf8.GetByteCount($Value) -gt $MaximumNameBytes -or
    $Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or
    $Value.Contains('..') -or
    $Value.EndsWith('.') -or
    $Value.EndsWith(' ')
  ) {
    throw 'direct child name is invalid'
  }
  $stem = $Value.Split('.')[0].ToUpperInvariant()
  if ($stem -match '^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') {
    throw 'direct child name is invalid'
  }
  return $Value
}

function Read-Maximum {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][int]$UpperBound
  )
  if (
    ($Value -isnot [int] -and $Value -isnot [long]) -or
    [int64]$Value -lt 1 -or
    [int64]$Value -gt $UpperBound
  ) {
    throw 'maximum byte count is invalid'
  }
  return [int]$Value
}

$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public sealed class CodexSourceMissingException : Exception {
  public CodexSourceMissingException() : base("source missing") {}
}

public sealed class CodexSourceUnsafeException : Exception {
  public CodexSourceUnsafeException() : base("source unsafe") {}
}

public sealed class CodexPrivateFileException : Exception {
  public CodexPrivateFileException() : base("private file operation failed") {}
}

public static class MyDashboardCodexCredentialFile {
  private const uint FILE_READ_DATA = 0x00000001;
  private const uint FILE_WRITE_DATA = 0x00000002;
  private const uint FILE_APPEND_DATA = 0x00000004;
  private const uint FILE_READ_EA = 0x00000008;
  private const uint FILE_WRITE_EA = 0x00000010;
  private const uint FILE_EXECUTE = 0x00000020;
  private const uint FILE_READ_ATTRIBUTES = 0x00000080;
  private const uint FILE_WRITE_ATTRIBUTES = 0x00000100;
  private const uint DELETE = 0x00010000;
  private const uint READ_CONTROL = 0x00020000;
  private const uint WRITE_DAC = 0x00040000;
  private const uint WRITE_OWNER = 0x00080000;
  private const uint SYNCHRONIZE = 0x00100000;
  private const uint GENERIC_ALL = 0x10000000;
  private const uint GENERIC_EXECUTE = 0x20000000;
  private const uint GENERIC_WRITE = 0x40000000;
  private const uint GENERIC_READ = 0x80000000;
  private const uint FILE_ALL_ACCESS = 0x001F01FF;
  private const uint FILE_GENERIC_READ =
    READ_CONTROL | FILE_READ_DATA | FILE_READ_ATTRIBUTES | FILE_READ_EA |
    SYNCHRONIZE;
  private const uint FILE_GENERIC_WRITE =
    READ_CONTROL | FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES | FILE_WRITE_EA |
    FILE_APPEND_DATA | SYNCHRONIZE;
  private const uint FILE_GENERIC_EXECUTE =
    READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_EXECUTE | SYNCHRONIZE;
  private const uint DANGEROUS_RIGHTS =
    FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA |
    FILE_WRITE_ATTRIBUTES | DELETE | WRITE_DAC | WRITE_OWNER;
  private const uint PRIVATE_RIGHTS = FILE_ALL_ACCESS;
  private const uint FILE_SHARE_READ = 0x00000001;
  private const uint FILE_SHARE_WRITE = 0x00000002;
  private const uint OPEN_EXISTING = 3;
  private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
  private const uint FILE_ATTRIBUTE_DEVICE = 0x00000040;
  private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
  private const uint FILE_TYPE_DISK = 0x00000001;
  private const int FILE_ATTRIBUTE_TAG_INFO_CLASS = 9;
  private const int FILE_ID_INFO_CLASS = 18;
  private const int SE_FILE_OBJECT = 1;
  private const uint OWNER_SECURITY_INFORMATION = 0x00000001;
  private const uint DACL_SECURITY_INFORMATION = 0x00000004;
  private const uint FILE_OPEN = 1;
  private const uint FILE_CREATE = 2;
  private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
  private const uint FILE_NON_DIRECTORY_FILE = 0x00000040;
  private const uint FILE_OPEN_REPARSE_POINT = 0x00200000;
  private const uint OBJ_CASE_INSENSITIVE = 0x00000040;
  private const int FILE_DISPOSITION_INFO_CLASS = 4;
  private const int FILE_ID_BOTH_DIRECTORY_INFORMATION = 37;
  private const int STATUS_NO_MORE_FILES = unchecked((int)0x80000006);
  private const uint MOVEFILE_REPLACE_EXISTING = 0x00000001;
  private const uint MOVEFILE_WRITE_THROUGH = 0x00000008;
  private const int ERROR_FILE_NOT_FOUND = 2;
  private const int ERROR_PATH_NOT_FOUND = 3;
  private const int MAXIMUM_TEMPORARY_ENTRIES = 32;
  private const long MAXIMUM_TEMPORARY_BYTES = 256 * 1024;
  private const int MAXIMUM_CREDENTIAL_BYTES = 65536;
  private const int MAXIMUM_PRIVATE_FILE_BYTES = 192 * 1024;
  private const int MUTATION_LOCK_TIMEOUT_MILLISECONDS = 30000;

  private static readonly string SystemSid = "S-1-5-18";
  private static readonly string AdministratorsSid = "S-1-5-32-544";
  private static readonly string WorldSid = "S-1-1-0";
  private static readonly string AuthenticatedUsersSid = "S-1-5-11";
  private static readonly Regex TemporaryName = new Regex(
    @"^state\.tmp\.[0-9]+\.[0-9a-f]{32}$",
    RegexOptions.CultureInvariant);

  [StructLayout(LayoutKind.Sequential)]
  private struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct FILE_ATTRIBUTE_TAG_INFO {
    public uint FileAttributes;
    public uint ReparseTag;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct FILE_ID_INFO {
    public ulong VolumeSerialNumber;
    public ulong FileIdLow;
    public ulong FileIdHigh;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct UNICODE_STRING {
    public ushort Length;
    public ushort MaximumLength;
    public IntPtr Buffer;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct OBJECT_ATTRIBUTES {
    public int Length;
    public IntPtr RootDirectory;
    public IntPtr ObjectName;
    public uint Attributes;
    public IntPtr SecurityDescriptor;
    public IntPtr SecurityQualityOfService;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IO_STATUS_BLOCK {
    public IntPtr Status;
    public IntPtr Information;
  }

  private sealed class Snapshot {
    public uint Attributes;
    public uint ReparseTag;
    public uint Volume;
    public ulong Index;
    public ulong Size;
    public uint Links;
    public ulong StableVolume;
    public ulong StableIdLow;
    public ulong StableIdHigh;
  }

  private sealed class MutationLock : IDisposable {
    private Mutex mutex;
    private bool held;

    public MutationLock(Mutex value, bool acquired) {
      mutex = value;
      held = acquired;
    }

    public void Dispose() {
      if (mutex == null) return;
      try {
        if (held) mutex.ReleaseMutex();
      } finally {
        held = false;
        mutex.Dispose();
        mutex = null;
      }
    }
  }

  private sealed class OpenedPath : IDisposable {
    public string Path;
    public SafeFileHandle Handle;
    public Snapshot Initial;

    public void Dispose() {
      if (Handle != null) Handle.Dispose();
    }
  }

  private sealed class DirectoryEntry {
    public string Name;
    public uint Attributes;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(
    string name,
    uint desiredAccess,
    uint shareMode,
    IntPtr securityAttributes,
    uint creationDisposition,
    uint flagsAndAttributes,
    IntPtr templateFile);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(
    SafeFileHandle handle,
    out BY_HANDLE_FILE_INFORMATION information);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(
    SafeFileHandle handle,
    int informationClass,
    out FILE_ATTRIBUTE_TAG_INFO information,
    uint bufferSize);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(
    SafeFileHandle handle,
    int informationClass,
    out FILE_ID_INFO information,
    uint bufferSize);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint GetFileType(SafeFileHandle handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool ReadFile(
    SafeFileHandle handle,
    byte[] buffer,
    uint bytesToRead,
    out uint bytesRead,
    IntPtr overlapped);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool WriteFile(
    SafeFileHandle handle,
    byte[] buffer,
    uint bytesToWrite,
    out uint bytesWritten,
    IntPtr overlapped);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool FlushFileBuffers(SafeFileHandle handle);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool ReplaceFileW(
    string replacedFileName,
    string replacementFileName,
    string backupFileName,
    uint replaceFlags,
    IntPtr exclude,
    IntPtr reserved);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool MoveFileExW(
    string existingFileName,
    string newFileName,
    uint flags);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetFileInformationByHandle(
    SafeFileHandle handle,
    int fileInformationClass,
    IntPtr fileInformation,
    uint bufferSize);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint GetSecurityInfo(
    IntPtr handle,
    int objectType,
    uint securityInformation,
    out IntPtr owner,
    out IntPtr group,
    out IntPtr dacl,
    out IntPtr sacl,
    out IntPtr securityDescriptor);

  [DllImport("advapi32.dll")]
  private static extern uint GetSecurityDescriptorLength(
    IntPtr securityDescriptor);

  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);

  [DllImport("ntdll.dll")]
  private static extern int NtCreateFile(
    out SafeFileHandle fileHandle,
    uint desiredAccess,
    ref OBJECT_ATTRIBUTES objectAttributes,
    ref IO_STATUS_BLOCK ioStatusBlock,
    IntPtr allocationSize,
    uint fileAttributes,
    uint shareAccess,
    uint createDisposition,
    uint createOptions,
    IntPtr eaBuffer,
    uint eaLength);

  [DllImport("ntdll.dll")]
  private static extern int NtQueryDirectoryFile(
    SafeFileHandle fileHandle,
    IntPtr eventHandle,
    IntPtr apcRoutine,
    IntPtr apcContext,
    ref IO_STATUS_BLOCK ioStatusBlock,
    IntPtr fileInformation,
    uint length,
    int fileInformationClass,
    bool returnSingleEntry,
    IntPtr fileName,
    bool restartScan);

  [DllImport("ntdll.dll")]
  private static extern uint RtlNtStatusToDosError(int status);

  private static bool MissingError(int error) {
    return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
  }

  private static Win32Exception NativeError() {
    return new Win32Exception(Marshal.GetLastWin32Error());
  }

  private static Snapshot Information(SafeFileHandle handle) {
    if (GetFileType(handle) != FILE_TYPE_DISK) {
      throw new InvalidOperationException("not a disk file");
    }
    BY_HANDLE_FILE_INFORMATION information;
    if (!GetFileInformationByHandle(handle, out information)) throw NativeError();
    FILE_ATTRIBUTE_TAG_INFO tag;
    if (!GetFileInformationByHandleEx(
      handle,
      FILE_ATTRIBUTE_TAG_INFO_CLASS,
      out tag,
      (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO)))) {
      throw NativeError();
    }
    FILE_ID_INFO stable;
    if (!GetFileInformationByHandleEx(
      handle,
      FILE_ID_INFO_CLASS,
      out stable,
      (uint)Marshal.SizeOf(typeof(FILE_ID_INFO)))) {
      throw NativeError();
    }
    return new Snapshot {
      Attributes = information.FileAttributes,
      ReparseTag = tag.ReparseTag,
      Volume = information.VolumeSerialNumber,
      Index = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow,
      Size = ((ulong)information.FileSizeHigh << 32) | information.FileSizeLow,
      Links = information.NumberOfLinks,
      StableVolume = stable.VolumeSerialNumber,
      StableIdLow = stable.FileIdLow,
      StableIdHigh = stable.FileIdHigh
    };
  }

  private static bool SameIdentity(Snapshot left, Snapshot right) {
    return left.Volume == right.Volume &&
      left.Index == right.Index &&
      left.StableVolume == right.StableVolume &&
      left.StableIdLow == right.StableIdLow &&
      left.StableIdHigh == right.StableIdHigh;
  }

  private static bool SameFileState(Snapshot left, Snapshot right) {
    return SameIdentity(left, right) &&
      left.Attributes == right.Attributes &&
      left.ReparseTag == right.ReparseTag &&
      left.Size == right.Size &&
      left.Links == right.Links;
  }

  private static void ValidateType(Snapshot snapshot, bool directory) {
    bool isDirectory = (snapshot.Attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    if (
      isDirectory != directory ||
      (snapshot.Attributes & FILE_ATTRIBUTE_DEVICE) != 0 ||
      (snapshot.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
      snapshot.ReparseTag != 0
    ) {
      throw new InvalidOperationException("file type is unsafe");
    }
  }

  private static SafeFileHandle OpenPath(
    string filePath,
    uint access,
    uint share,
    bool directory) {
    uint flags = FILE_FLAG_OPEN_REPARSE_POINT;
    if (directory) flags |= FILE_FLAG_BACKUP_SEMANTICS;
    SafeFileHandle handle = CreateFileW(
      filePath,
      access,
      share,
      IntPtr.Zero,
      OPEN_EXISTING,
      flags,
      IntPtr.Zero);
    if (handle.IsInvalid) {
      int error = Marshal.GetLastWin32Error();
      handle.Dispose();
      throw new Win32Exception(error);
    }
    return handle;
  }

  private static OpenedPath OpenCheckedPath(
    string filePath,
    uint access,
    uint share,
    bool directory) {
    SafeFileHandle handle = OpenPath(filePath, access, share, directory);
    try {
      Snapshot snapshot = Information(handle);
      ValidateType(snapshot, directory);
      return new OpenedPath {
        Path = filePath,
        Handle = handle,
        Initial = snapshot
      };
    } catch {
      handle.Dispose();
      throw;
    }
  }

  private static List<OpenedPath> OpenAncestors(string filePath) {
    string full = Path.GetFullPath(filePath);
    string root = Path.GetPathRoot(full);
    if (
      String.IsNullOrEmpty(root) ||
      root.Length != 3 ||
      root[1] != ':' ||
      root[2] != '\\' ||
      full.IndexOf(':', 2) >= 0
    ) {
      throw new InvalidOperationException("source path is not a local drive path");
    }
    string relative = full.Substring(root.Length);
    string[] parts = relative.Split(new char[] { '\\' }, StringSplitOptions.RemoveEmptyEntries);
    if (parts.Length < 1) throw new InvalidOperationException("source file is absent");

    List<OpenedPath> ancestors = new List<OpenedPath>();
    string current = root;
    try {
      ancestors.Add(OpenCheckedPath(
        current,
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ,
        true));
      for (int index = 0; index < parts.Length - 1; index += 1) {
        current = Path.Combine(current, parts[index]);
        ancestors.Add(OpenCheckedPath(
          current,
          FILE_READ_ATTRIBUTES,
          FILE_SHARE_READ,
          true));
      }
      return ancestors;
    } catch {
      foreach (OpenedPath ancestor in ancestors) ancestor.Dispose();
      throw;
    }
  }

  private static uint MapGenericRights(uint mask) {
    uint mapped = mask;
    if ((mapped & GENERIC_ALL) != 0) mapped |= FILE_ALL_ACCESS;
    if ((mapped & GENERIC_READ) != 0) mapped |= FILE_GENERIC_READ;
    if ((mapped & GENERIC_WRITE) != 0) mapped |= FILE_GENERIC_WRITE;
    if ((mapped & GENERIC_EXECUTE) != 0) mapped |= FILE_GENERIC_EXECUTE;
    return mapped & ~(GENERIC_ALL | GENERIC_READ | GENERIC_WRITE | GENERIC_EXECUTE);
  }

  private static bool AllowedDangerousSid(string sid, string currentSid) {
    return sid == currentSid || sid == SystemSid || sid == AdministratorsSid;
  }

  private static bool AceAppliesToTrustee(string aceSid, string trusteeSid) {
    return aceSid == trusteeSid ||
      aceSid == WorldSid ||
      aceSid == AuthenticatedUsersSid;
  }

  private static uint EffectiveDangerousRights(
    RawAcl dacl,
    string trusteeSid) {
    uint remaining = DANGEROUS_RIGHTS;
    uint granted = 0;
    foreach (GenericAce generic in dacl) {
      CommonAce ace = generic as CommonAce;
      if (
        ace == null ||
        ace.IsCallback ||
        (ace.AceFlags & AceFlags.InheritOnly) != 0 ||
        ace.SecurityIdentifier == null ||
        !AceAppliesToTrustee(ace.SecurityIdentifier.Value, trusteeSid)
      ) {
        continue;
      }
      uint applicable = MapGenericRights(unchecked((uint)ace.AccessMask)) & remaining;
      if (ace.AceQualifier == AceQualifier.AccessDenied) {
        remaining &= ~applicable;
      } else if (ace.AceQualifier == AceQualifier.AccessAllowed) {
        granted |= applicable;
        remaining &= ~applicable;
      }
      if (remaining == 0) break;
    }
    return granted;
  }

  private static void ValidateSecurity(SafeFileHandle handle, bool strictPrivate) {
    IntPtr owner;
    IntPtr group;
    IntPtr daclPointer;
    IntPtr sacl;
    IntPtr descriptor;
    uint status = GetSecurityInfo(
      handle.DangerousGetHandle(),
      SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      out owner,
      out group,
      out daclPointer,
      out sacl,
      out descriptor);
    if (status != 0) throw new Win32Exception((int)status);
    try {
      string currentSid = WindowsIdentity.GetCurrent().User.Value;
      SecurityIdentifier ownerSid = new SecurityIdentifier(owner);
      if (ownerSid.Value != currentSid) {
        throw new InvalidOperationException("owner is unsafe");
      }
      uint descriptorLength = GetSecurityDescriptorLength(descriptor);
      if (descriptorLength == 0 || descriptorLength > 65536) {
        throw new InvalidOperationException("security descriptor is invalid");
      }
      byte[] bytes = new byte[descriptorLength];
      Marshal.Copy(descriptor, bytes, 0, checked((int)descriptorLength));
      RawSecurityDescriptor raw = new RawSecurityDescriptor(bytes, 0);
      if (raw.DiscretionaryAcl == null) {
        throw new InvalidOperationException("DACL is absent");
      }
      HashSet<string> trustees = new HashSet<string>(StringComparer.Ordinal);
      foreach (GenericAce generic in raw.DiscretionaryAcl) {
        CommonAce ace = generic as CommonAce;
        if (ace == null || ace.IsCallback) {
          throw new InvalidOperationException("ACE is unsupported");
        }
        if (
          ace.AceQualifier != AceQualifier.AccessAllowed &&
          ace.AceQualifier != AceQualifier.AccessDenied
        ) {
          throw new InvalidOperationException("ACE qualifier is unsupported");
        }
        if (
          ace.AceQualifier == AceQualifier.AccessAllowed &&
          ace.SecurityIdentifier != null &&
          !AllowedDangerousSid(ace.SecurityIdentifier.Value, currentSid)
        ) {
          if (
            strictPrivate &&
            (MapGenericRights(unchecked((uint)ace.AccessMask)) & PRIVATE_RIGHTS) != 0
          ) {
            throw new InvalidOperationException("private ACL permits an unauthorized principal");
          }
          if (!strictPrivate && (ace.AceFlags & AceFlags.InheritOnly) == 0) {
            trustees.Add(ace.SecurityIdentifier.Value);
          }
        }
      }
      if (!strictPrivate) {
        foreach (string trustee in trustees) {
          if (EffectiveDangerousRights(raw.DiscretionaryAcl, trustee) != 0) {
            throw new InvalidOperationException("effective file rights are unsafe");
          }
        }
      }
    } finally {
      LocalFree(descriptor);
    }
  }

  private static void ValidateSourceSecurity(SafeFileHandle handle) {
    ValidateSecurity(handle, false);
  }

  private static void ValidatePrivateSecurity(SafeFileHandle handle) {
    ValidateSecurity(handle, true);
  }

  private static byte[] ReadExact(
    SafeFileHandle handle,
    Snapshot expected,
    int maximumBytes) {
    if (
      expected.Size < 1 ||
      expected.Size > (ulong)maximumBytes ||
      expected.Size > Int32.MaxValue
    ) {
      throw new InvalidOperationException("file size is unsafe");
    }
    byte[] bytes = new byte[checked((int)expected.Size)];
    int offset = 0;
    while (offset < bytes.Length) {
      int remaining = bytes.Length - offset;
      byte[] chunk = new byte[Math.Min(remaining, 16384)];
      uint read;
      if (!ReadFile(handle, chunk, (uint)chunk.Length, out read, IntPtr.Zero)) {
        throw NativeError();
      }
      if (read == 0) throw new InvalidOperationException("short read");
      Buffer.BlockCopy(chunk, 0, bytes, offset, checked((int)read));
      offset = checked(offset + (int)read);
    }
    byte[] extra = new byte[1];
    uint extraRead;
    if (!ReadFile(handle, extra, 1, out extraRead, IntPtr.Zero)) throw NativeError();
    if (extraRead != 0) throw new InvalidOperationException("file grew during read");
    return bytes;
  }

  private static void VerifyAncestors(List<OpenedPath> ancestors) {
    foreach (OpenedPath ancestor in ancestors) {
      Snapshot after = Information(ancestor.Handle);
      ValidateType(after, true);
      if (!SameIdentity(ancestor.Initial, after)) {
        throw new InvalidOperationException("ancestor identity changed");
      }
      using (OpenedPath reopened = OpenCheckedPath(
        ancestor.Path,
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ,
        true)) {
        if (!SameIdentity(ancestor.Initial, reopened.Initial)) {
          throw new InvalidOperationException("ancestor path identity changed");
        }
      }
    }
  }

  public static byte[] ReadSource(string filePath, int maximumBytes) {
    if (maximumBytes < 1 || maximumBytes > MAXIMUM_CREDENTIAL_BYTES) {
      throw new CodexSourceUnsafeException();
    }
    List<OpenedPath> ancestors = null;
    try {
      ancestors = OpenAncestors(filePath);
      using (OpenedPath source = OpenCheckedPath(
        Path.GetFullPath(filePath),
        FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_SHARE_READ,
        false)) {
        if (source.Initial.Links != 1) {
          throw new InvalidOperationException("source has multiple links");
        }
        ValidateSourceSecurity(source.Handle);
        byte[] bytes = ReadExact(source.Handle, source.Initial, maximumBytes);
        Snapshot after = Information(source.Handle);
        ValidateType(after, false);
        if (!SameFileState(source.Initial, after)) {
          throw new InvalidOperationException("source changed during read");
        }
        VerifyAncestors(ancestors);
        using (OpenedPath reopened = OpenCheckedPath(
          Path.GetFullPath(filePath),
          FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL,
          FILE_SHARE_READ,
          false)) {
          if (!SameFileState(source.Initial, reopened.Initial)) {
            throw new InvalidOperationException("source path identity changed");
          }
          ValidateSourceSecurity(reopened.Handle);
        }
        return bytes;
      }
    } catch (Win32Exception error) {
      if (MissingError(error.NativeErrorCode)) throw new CodexSourceMissingException();
      throw new CodexSourceUnsafeException();
    } catch (CodexSourceMissingException) {
      throw;
    } catch {
      throw new CodexSourceUnsafeException();
    } finally {
      if (ancestors != null) {
        foreach (OpenedPath ancestor in ancestors) ancestor.Dispose();
      }
    }
  }

  private static SafeFileHandle OpenRelative(
    SafeFileHandle directory,
    string name,
    uint access,
    uint share,
    uint disposition,
    out bool missing) {
    IntPtr nameBuffer = Marshal.StringToHGlobalUni(name);
    IntPtr unicodePointer = IntPtr.Zero;
    missing = false;
    try {
      UNICODE_STRING unicode = new UNICODE_STRING {
        Length = checked((ushort)(name.Length * 2)),
        MaximumLength = checked((ushort)((name.Length + 1) * 2)),
        Buffer = nameBuffer
      };
      unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
      Marshal.StructureToPtr(unicode, unicodePointer, false);
      OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES {
        Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),
        RootDirectory = directory.DangerousGetHandle(),
        ObjectName = unicodePointer,
        Attributes = OBJ_CASE_INSENSITIVE,
        SecurityDescriptor = IntPtr.Zero,
        SecurityQualityOfService = IntPtr.Zero
      };
      IO_STATUS_BLOCK ioStatus = new IO_STATUS_BLOCK();
      SafeFileHandle child;
      int status = NtCreateFile(
        out child,
        access,
        ref attributes,
        ref ioStatus,
        IntPtr.Zero,
        FILE_READ_ATTRIBUTES,
        share,
        disposition,
        FILE_SYNCHRONOUS_IO_NONALERT |
          FILE_OPEN_REPARSE_POINT |
          FILE_NON_DIRECTORY_FILE,
        IntPtr.Zero,
        0);
      if (status < 0) {
        if (child != null) child.Dispose();
        int error = checked((int)RtlNtStatusToDosError(status));
        if (MissingError(error)) {
          missing = true;
          return null;
        }
        throw new Win32Exception(error);
      }
      return child;
    } finally {
      if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
      Marshal.FreeHGlobal(nameBuffer);
    }
  }

  private static OpenedPath OpenPrivateDirectory(
    string directoryPath,
    ulong expectedDevice,
    ulong expectedInode) {
    OpenedPath directory = OpenCheckedPath(
      directoryPath,
      FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      true);
    try {
      if (
        expectedDevice > UInt32.MaxValue ||
        directory.Initial.Volume != (uint)expectedDevice ||
        directory.Initial.Index != expectedInode
      ) {
        throw new InvalidOperationException("private directory identity changed");
      }
      ValidatePrivateSecurity(directory.Handle);
      return directory;
    } catch {
      directory.Dispose();
      throw;
    }
  }

  private static void VerifyPrivateDirectory(
    OpenedPath directory,
    ulong expectedDevice,
    ulong expectedInode) {
    Snapshot after = Information(directory.Handle);
    ValidateType(after, true);
    if (
      expectedDevice > UInt32.MaxValue ||
      after.Volume != (uint)expectedDevice ||
      after.Index != expectedInode ||
      !SameIdentity(directory.Initial, after)
    ) {
      throw new InvalidOperationException("private directory changed");
    }
    ValidatePrivateSecurity(directory.Handle);
    using (OpenedPath reopened = OpenPrivateDirectory(
      directory.Path,
      expectedDevice,
      expectedInode)) {
      if (!SameIdentity(directory.Initial, reopened.Initial)) {
        throw new InvalidOperationException("private directory path changed");
      }
    }
  }

  private static Snapshot ValidatePrivateFile(
    SafeFileHandle handle,
    int maximumBytes) {
    Snapshot snapshot = Information(handle);
    ValidateType(snapshot, false);
    if (
      snapshot.Links != 1 ||
      snapshot.Size < 1 ||
      snapshot.Size > (ulong)maximumBytes
    ) {
      throw new InvalidOperationException("private file state is unsafe");
    }
    ValidatePrivateSecurity(handle);
    return snapshot;
  }

  private static byte[] ReadPrivateHandle(
    SafeFileHandle handle,
    int maximumBytes) {
    Snapshot initial = ValidatePrivateFile(handle, maximumBytes);
    byte[] bytes = ReadExact(handle, initial, maximumBytes);
    Snapshot after = Information(handle);
    ValidateType(after, false);
    if (!SameFileState(initial, after)) {
      throw new InvalidOperationException("private file changed during read");
    }
    return bytes;
  }

  public static byte[] ReadPrivate(
    string directoryPath,
    ulong expectedDevice,
    ulong expectedInode,
    string name,
    int maximumBytes,
    bool required) {
    if (maximumBytes < 1 || maximumBytes > MAXIMUM_PRIVATE_FILE_BYTES) {
      throw new CodexPrivateFileException();
    }
    try {
      using (OpenedPath directory = OpenPrivateDirectory(
        directoryPath,
        expectedDevice,
        expectedInode)) {
        bool missing;
        using (SafeFileHandle child = OpenRelative(
          directory.Handle,
          name,
          FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
          FILE_SHARE_READ,
          FILE_OPEN,
          out missing)) {
          if (missing) {
            if (required) throw new InvalidOperationException("required private file is absent");
            VerifyPrivateDirectory(directory, expectedDevice, expectedInode);
            return null;
          }
          byte[] bytes = ReadPrivateHandle(child, maximumBytes);
          VerifyPrivateDirectory(directory, expectedDevice, expectedInode);
          return bytes;
        }
      }
    } catch {
      throw new CodexPrivateFileException();
    }
  }

  private static void WriteAll(SafeFileHandle handle, byte[] bytes) {
    int offset = 0;
    while (offset < bytes.Length) {
      int count = Math.Min(bytes.Length - offset, 16384);
      byte[] chunk = new byte[count];
      Buffer.BlockCopy(bytes, offset, chunk, 0, count);
      uint written;
      if (!WriteFile(handle, chunk, (uint)count, out written, IntPtr.Zero)) {
        throw NativeError();
      }
      if (written == 0 || written > count) {
        throw new InvalidOperationException("short write");
      }
      offset = checked(offset + (int)written);
    }
  }

  private static void MarkDelete(SafeFileHandle handle) {
    IntPtr disposition = Marshal.AllocHGlobal(1);
    try {
      Marshal.WriteByte(disposition, 1);
      if (!SetFileInformationByHandle(
        handle,
        FILE_DISPOSITION_INFO_CLASS,
        disposition,
        1)) {
        throw NativeError();
      }
    } finally {
      Marshal.FreeHGlobal(disposition);
    }
  }

  private static void CreateAndWrite(
    SafeFileHandle directory,
    string name,
    byte[] bytes) {
    bool missing;
    SafeFileHandle child = OpenRelative(
      directory,
      name,
      FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES |
        READ_CONTROL | DELETE | SYNCHRONIZE,
      FILE_SHARE_READ,
      FILE_CREATE,
      out missing);
    if (child == null || missing) throw new InvalidOperationException("create failed");
    bool complete = false;
    try {
      WriteAll(child, bytes);
      if (!FlushFileBuffers(child)) throw NativeError();
      Snapshot final = ValidatePrivateFile(child, bytes.Length);
      if (final.Size != (ulong)bytes.Length) {
        throw new InvalidOperationException("created file size is invalid");
      }
      complete = true;
    } finally {
      if (!complete) {
        try { MarkDelete(child); } catch {}
      }
      child.Dispose();
    }
  }

  private static bool SameBytes(byte[] left, byte[] right) {
    if (left.Length != right.Length) return false;
    int difference = 0;
    for (int index = 0; index < left.Length; index += 1) {
      difference |= left[index] ^ right[index];
    }
    return difference == 0;
  }

  private static string MutationMutexName(Snapshot directory, string name) {
    string identity = String.Format(
      CultureInfo.InvariantCulture,
      "{0:X16}:{1:X16}:{2:X16}",
      directory.StableVolume,
      directory.StableIdLow,
      directory.StableIdHigh);
    byte[] material = Encoding.UTF8.GetBytes(identity + "\n" + name.ToUpperInvariant());
    byte[] digest;
    using (SHA256 algorithm = SHA256.Create()) {
      digest = algorithm.ComputeHash(material);
    }
    char[] hex = new char[digest.Length * 2];
    const string digits = "0123456789abcdef";
    for (int index = 0; index < digest.Length; index += 1) {
      hex[index * 2] = digits[digest[index] >> 4];
      hex[index * 2 + 1] = digits[digest[index] & 15];
    }
    return "Local\\MyDashboard.CodexCredential." + new string(hex);
  }

  private static MutexSecurity StrictMutationMutexSecurity(string currentSid) {
    MutexSecurity security = new MutexSecurity();
    SecurityIdentifier current = new SecurityIdentifier(currentSid);
    security.SetOwner(current);
    security.SetAccessRuleProtection(true, false);
    foreach (string sid in new string[] { currentSid, SystemSid, AdministratorsSid }) {
      security.AddAccessRule(new MutexAccessRule(
        new SecurityIdentifier(sid),
        MutexRights.FullControl,
        AccessControlType.Allow));
    }
    return security;
  }

  private static void ValidateMutationMutexSecurity(Mutex mutex, string currentSid) {
    MutexSecurity security = mutex.GetAccessControl();
    SecurityIdentifier owner = (SecurityIdentifier)security.GetOwner(
      typeof(SecurityIdentifier));
    if (owner == null || owner.Value != currentSid) {
      throw new InvalidOperationException("mutation mutex owner is unsafe");
    }
    AuthorizationRuleCollection rules = security.GetAccessRules(
      true,
      true,
      typeof(SecurityIdentifier));
    foreach (AuthorizationRule authorization in rules) {
      MutexAccessRule rule = authorization as MutexAccessRule;
      if (rule == null) {
        throw new InvalidOperationException("mutation mutex rule is unsupported");
      }
      SecurityIdentifier sid = rule.IdentityReference as SecurityIdentifier;
      if (
        rule.AccessControlType == AccessControlType.Allow &&
        (sid == null || !AllowedDangerousSid(sid.Value, currentSid)) &&
        rule.MutexRights != 0
      ) {
        throw new InvalidOperationException("mutation mutex permits an unauthorized principal");
      }
    }
  }

  private static MutationLock AcquireMutationLock(Snapshot directory, string name) {
    string currentSid = WindowsIdentity.GetCurrent().User.Value;
    bool created;
    Mutex mutex = new Mutex(
      false,
      MutationMutexName(directory, name),
      out created,
      StrictMutationMutexSecurity(currentSid));
    bool acquired = false;
    try {
      ValidateMutationMutexSecurity(mutex, currentSid);
      try {
        acquired = mutex.WaitOne(MUTATION_LOCK_TIMEOUT_MILLISECONDS);
      } catch (AbandonedMutexException) {
        acquired = true;
      }
      if (!acquired) {
        throw new TimeoutException("private mutation lock timed out");
      }
      return new MutationLock(mutex, true);
    } catch {
      if (acquired) mutex.ReleaseMutex();
      mutex.Dispose();
      throw;
    }
  }

  private static void VerifyRelativeBytes(
    SafeFileHandle directory,
    string name,
    byte[] expected) {
    bool missing;
    using (SafeFileHandle child = OpenRelative(
      directory,
      name,
      FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
      FILE_SHARE_READ,
      FILE_OPEN,
      out missing)) {
      if (missing || child == null) throw new InvalidOperationException("final file is absent");
      byte[] actual = ReadPrivateHandle(child, expected.Length);
      if (!SameBytes(actual, expected)) {
        throw new InvalidOperationException("final bytes differ");
      }
    }
  }

  public static void WriteNewPrivate(
    string directoryPath,
    ulong expectedDevice,
    ulong expectedInode,
    string name,
    byte[] bytes) {
    try {
      if (bytes == null || bytes.Length < 1 || bytes.Length > MAXIMUM_PRIVATE_FILE_BYTES) {
        throw new InvalidOperationException("private bytes are invalid");
      }
      using (OpenedPath directory = OpenPrivateDirectory(
        directoryPath,
        expectedDevice,
        expectedInode)) {
        using (MutationLock mutation = AcquireMutationLock(directory.Initial, name)) {
          CreateAndWrite(directory.Handle, name, bytes);
          VerifyRelativeBytes(directory.Handle, name, bytes);
          VerifyPrivateDirectory(directory, expectedDevice, expectedInode);
        }
      }
    } catch {
      throw new CodexPrivateFileException();
    }
  }

  private static string UniqueTemporaryName() {
    byte[] random = new byte[16];
    using (RandomNumberGenerator generator = RandomNumberGenerator.Create()) {
      generator.GetBytes(random);
    }
    char[] hex = new char[random.Length * 2];
    const string digits = "0123456789abcdef";
    for (int index = 0; index < random.Length; index += 1) {
      hex[index * 2] = digits[random[index] >> 4];
      hex[index * 2 + 1] = digits[random[index] & 15];
    }
    return "state.tmp." +
      System.Diagnostics.Process.GetCurrentProcess().Id.ToString() +
      "." +
      new string(hex);
  }

  private static List<DirectoryEntry> EnumerateDirectory(SafeFileHandle directory) {
    const int bufferSize = 64 * 1024;
    IntPtr buffer = Marshal.AllocHGlobal(bufferSize);
    List<DirectoryEntry> entries = new List<DirectoryEntry>();
    long scanned = 0;
    try {
      bool restart = true;
      while (true) {
        IO_STATUS_BLOCK ioStatus = new IO_STATUS_BLOCK();
        int status = NtQueryDirectoryFile(
          directory,
          IntPtr.Zero,
          IntPtr.Zero,
          IntPtr.Zero,
          ref ioStatus,
          buffer,
          bufferSize,
          FILE_ID_BOTH_DIRECTORY_INFORMATION,
          false,
          IntPtr.Zero,
          restart);
        restart = false;
        if (status == STATUS_NO_MORE_FILES) break;
        if (status < 0) {
          throw new Win32Exception((int)RtlNtStatusToDosError(status));
        }
        int returned = checked((int)ioStatus.Information.ToInt64());
        if (returned < 1 || returned > bufferSize) {
          throw new InvalidOperationException("directory enumeration is invalid");
        }
        scanned = checked(scanned + returned);
        if (scanned > MAXIMUM_TEMPORARY_BYTES) {
          throw new InvalidOperationException("directory scan bound exceeded");
        }
        int offset = 0;
        while (true) {
          if (offset < 0 || offset + 104 > returned) {
            throw new InvalidOperationException("directory entry is invalid");
          }
          IntPtr entry = IntPtr.Add(buffer, offset);
          uint nextOffset = unchecked((uint)Marshal.ReadInt32(entry, 0));
          uint attributes = unchecked((uint)Marshal.ReadInt32(entry, 56));
          int nameLength = Marshal.ReadInt32(entry, 60);
          if (
            nameLength < 0 ||
            (nameLength & 1) != 0 ||
            offset + 104 + nameLength > returned
          ) {
            throw new InvalidOperationException("directory name is invalid");
          }
          string name = Marshal.PtrToStringUni(IntPtr.Add(entry, 104), nameLength / 2);
          if (name != "." && name != "..") {
            entries.Add(new DirectoryEntry { Name = name, Attributes = attributes });
            if (entries.Count > MAXIMUM_TEMPORARY_ENTRIES) {
              throw new InvalidOperationException("directory entry bound exceeded");
            }
          }
          if (nextOffset == 0) break;
          if (nextOffset > Int32.MaxValue) {
            throw new InvalidOperationException("directory offset is invalid");
          }
          offset = checked(offset + (int)nextOffset);
        }
      }
      return entries;
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }

  private static void CleanupTemporaries(SafeFileHandle directory) {
    long bytes = 0;
    foreach (DirectoryEntry entry in EnumerateDirectory(directory)) {
      if (
        (entry.Attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ||
        (entry.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
      ) {
        throw new InvalidOperationException("private directory contains a link or directory");
      }
      bool temporary = TemporaryName.IsMatch(entry.Name);
      bool missing;
      using (SafeFileHandle child = OpenRelative(
        directory,
        entry.Name,
        FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE |
          (temporary ? DELETE : 0),
        FILE_SHARE_READ,
        FILE_OPEN,
        out missing)) {
        if (missing || child == null) {
          throw new InvalidOperationException("private directory entry changed");
        }
        Snapshot snapshot = Information(child);
        ValidateType(snapshot, false);
        if (snapshot.Links != 1) {
          throw new InvalidOperationException("private directory contains a hard link");
        }
        ValidatePrivateSecurity(child);
        if (!temporary) continue;
        bytes = checked(bytes + (long)snapshot.Size);
        if (bytes > MAXIMUM_TEMPORARY_BYTES) {
          throw new InvalidOperationException("temporary byte bound exceeded");
        }
        MarkDelete(child);
      }
    }
  }

  private static bool RelativeFileExistsAndSafe(
    SafeFileHandle directory,
    string name) {
    bool missing;
    using (SafeFileHandle child = OpenRelative(
      directory,
      name,
      FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
      FILE_SHARE_READ,
      FILE_OPEN,
      out missing)) {
      if (missing || child == null) return false;
      ValidatePrivateFile(child, MAXIMUM_PRIVATE_FILE_BYTES);
      return true;
    }
  }

  private static void DeleteOwnedTemporary(
    SafeFileHandle directory,
    string temporaryName) {
    if (!TemporaryName.IsMatch(temporaryName)) return;
    bool missing;
    using (SafeFileHandle child = OpenRelative(
      directory,
      temporaryName,
      FILE_READ_ATTRIBUTES | READ_CONTROL | DELETE | SYNCHRONIZE,
      FILE_SHARE_READ,
      FILE_OPEN,
      out missing)) {
      if (missing || child == null) return;
      ValidatePrivateFile(child, checked((int)MAXIMUM_TEMPORARY_BYTES));
      MarkDelete(child);
    }
  }

  public static void ReplacePrivate(
    string directoryPath,
    ulong expectedDevice,
    ulong expectedInode,
    string name,
    byte[] bytes) {
    string temporaryName = null;
    bool published = false;
    try {
      if (bytes == null || bytes.Length < 1 || bytes.Length > MAXIMUM_PRIVATE_FILE_BYTES) {
        throw new InvalidOperationException("private bytes are invalid");
      }
      using (OpenedPath directory = OpenPrivateDirectory(
        directoryPath,
        expectedDevice,
        expectedInode)) {
        using (MutationLock mutation = AcquireMutationLock(directory.Initial, name)) {
          try {
            CleanupTemporaries(directory.Handle);
            temporaryName = UniqueTemporaryName();
            string temporaryPath = Path.Combine(directoryPath, temporaryName);
            string finalPath = Path.Combine(directoryPath, name);
            CreateAndWrite(directory.Handle, temporaryName, bytes);
            VerifyPrivateDirectory(directory, expectedDevice, expectedInode);
            bool existing = RelativeFileExistsAndSafe(directory.Handle, name);
            bool moved = false;
            if (existing) {
              moved = ReplaceFileW(
                finalPath,
                temporaryPath,
                null,
                0,
                IntPtr.Zero,
                IntPtr.Zero);
            }
            if (!moved) {
              moved = MoveFileExW(
                temporaryPath,
                finalPath,
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
            }
            if (!moved) throw NativeError();
            published = true;
            VerifyRelativeBytes(directory.Handle, name, bytes);
            VerifyPrivateDirectory(directory, expectedDevice, expectedInode);
          } finally {
            if (!published && temporaryName != null) {
              try { DeleteOwnedTemporary(directory.Handle, temporaryName); } catch {}
            }
          }
        }
      }
    } catch {
      throw new CodexPrivateFileException();
    }
  }

  public static void RemovePrivate(
    string directoryPath,
    ulong expectedDevice,
    ulong expectedInode,
    string name) {
    try {
      using (OpenedPath directory = OpenPrivateDirectory(
        directoryPath,
        expectedDevice,
        expectedInode)) {
        using (MutationLock mutation = AcquireMutationLock(directory.Initial, name)) {
          bool missing;
          using (SafeFileHandle child = OpenRelative(
            directory.Handle,
            name,
            FILE_READ_ATTRIBUTES | READ_CONTROL | DELETE | SYNCHRONIZE,
            FILE_SHARE_READ,
            FILE_OPEN,
            out missing)) {
            if (!missing && child != null) {
              ValidatePrivateFile(child, MAXIMUM_PRIVATE_FILE_BYTES);
              MarkDelete(child);
            }
          }
          bool finalMissing;
          using (SafeFileHandle final = OpenRelative(
            directory.Handle,
            name,
            FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ,
            FILE_OPEN,
            out finalMissing)) {
            if (!finalMissing || final != null) {
              throw new InvalidOperationException("private file remains after removal");
            }
          }
          VerifyPrivateDirectory(directory, expectedDevice, expectedInode);
        }
      }
    } catch {
      throw new CodexPrivateFileException();
    }
  }
}
'@

try {
  $requestText = Read-RequestPacket
  $request = $requestText | ConvertFrom-Json
  Assert-ExactKeys $request @(
    switch ([string]$request.operation) {
      'read-source' { 'schemaVersion', 'operation', 'fileBase64', 'maximumBytes' }
      'read-private' { 'schemaVersion', 'operation', 'directory', 'name', 'maximumBytes', 'required' }
      'write-new-private' { 'schemaVersion', 'operation', 'directory', 'name', 'bytesBase64' }
      'replace-private' { 'schemaVersion', 'operation', 'directory', 'name', 'bytesBase64' }
      'remove-private' { 'schemaVersion', 'operation', 'directory', 'name' }
      default { throw 'operation is invalid' }
    }
  )
  if (
    ($request.schemaVersion -isnot [int] -and $request.schemaVersion -isnot [long]) -or
    [int64]$request.schemaVersion -ne 1
  ) {
    throw 'schema version is invalid'
  }

  [void](Add-Type -TypeDefinition $source -Language CSharp)

  switch ([string]$request.operation) {
    'read-source' {
      $file = Decode-Path $request.fileBase64
      $maximum = Read-Maximum $request.maximumBytes $MaximumCredentialBytes
      try {
        $bytes = [MyDashboardCodexCredentialFile]::ReadSource($file, $maximum)
        Write-Response 'ok' $bytes
      } catch [CodexSourceMissingException] {
        Write-Response 'missing'
      } catch [CodexSourceUnsafeException] {
        Write-Response 'source-unsafe'
      }
    }
    'read-private' {
      $directory = Read-Directory $request.directory
      $name = Read-Name $request.name
      $maximum = Read-Maximum $request.maximumBytes $MaximumPrivateFileBytes
      if ($request.required -isnot [bool]) { throw 'required is invalid' }
      try {
        $bytes = [MyDashboardCodexCredentialFile]::ReadPrivate(
          $directory.Path,
          $directory.Device,
          $directory.Inode,
          $name,
          $maximum,
          [bool]$request.required
        )
        if ($null -eq $bytes) { Write-Response 'missing' } else { Write-Response 'ok' $bytes }
      } catch [CodexPrivateFileException] {
        Write-Response 'failed'
      }
    }
    'write-new-private' {
      $directory = Read-Directory $request.directory
      $name = Read-Name $request.name
      $bytes = Decode-CanonicalBase64 $request.bytesBase64 $MaximumPrivateFileBytes
      try {
        [MyDashboardCodexCredentialFile]::WriteNewPrivate(
          $directory.Path,
          $directory.Device,
          $directory.Inode,
          $name,
          $bytes
        )
        Write-Response 'ok'
      } catch [CodexPrivateFileException] {
        Write-Response 'failed'
      }
    }
    'replace-private' {
      $directory = Read-Directory $request.directory
      $name = Read-Name $request.name
      $bytes = Decode-CanonicalBase64 $request.bytesBase64 $MaximumPrivateFileBytes
      try {
        [MyDashboardCodexCredentialFile]::ReplacePrivate(
          $directory.Path,
          $directory.Device,
          $directory.Inode,
          $name,
          $bytes
        )
        Write-Response 'ok'
      } catch [CodexPrivateFileException] {
        Write-Response 'failed'
      }
    }
    'remove-private' {
      $directory = Read-Directory $request.directory
      $name = Read-Name $request.name
      try {
        [MyDashboardCodexCredentialFile]::RemovePrivate(
          $directory.Path,
          $directory.Device,
          $directory.Inode,
          $name
        )
        Write-Response 'ok'
      } catch [CodexPrivateFileException] {
        Write-Response 'failed'
      }
    }
  }
} catch {
  try {
    Write-Response 'failed'
  } catch {
    [Environment]::ExitCode = 1
  }
}
