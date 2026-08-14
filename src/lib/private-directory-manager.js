import { execFile, spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

const WINDOWS_SYSTEM_SID = "S-1-5-18";
const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";
const WINDOWS_PARENT_DANGEROUS_RIGHTS =
  2n | 4n | 16n | 64n | 256n | 65_536n | 262_144n | 524_288n |
  268_435_456n | 1_073_741_824n;
const WINDOWS_FULL_CONTROL = 2_032_127n;

function unavailable() {
  return Object.assign(new Error("Private directory trust is unavailable"), {
    code: "STRUCTURED_PROVIDER_UNAVAILABLE",
  });
}

function cleanupFailed() {
  return Object.assign(new Error("Private cleanup could not be proven"), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
}

export function productionSupervisedCliPlatformSupported(
  platform = process.platform,
  architecture = process.arch,
) {
  return platform === "win32" && architecture === "x64";
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? unavailable();
}

function canonicalPath(value) {
  const resolved = path.resolve(value).replace(/^\\\\\?\\/u, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function directoryIdentity(details, directory) {
  if (!details.isDirectory() || details.isSymbolicLink()) throw unavailable();
  return Object.freeze({
    path: directory,
    device: details.dev.toString(),
    inode: details.ino.toString(),
  });
}

function sameIdentity(identity, details) {
  return details.isDirectory() &&
    !details.isSymbolicLink() &&
    details.dev.toString() === identity.device &&
    details.ino.toString() === identity.inode;
}

function runPowerShell(script, environment, signal) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const executable = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      {
        windowsHide: true,
        ...(signal === null || signal === undefined ? {} : { signal }),
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        env: {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          ...environment,
        },
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
  });
}

const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($env:MYDASHBOARD_PRIVATE_PATH)
)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentSid = $identity.User.Value
$acl = Get-Acl -LiteralPath $target
try {
  $ownerSid = ([Security.Principal.NTAccount]$acl.Owner).Translate(
    [Security.Principal.SecurityIdentifier]
  ).Value
} catch {
  $ownerSid = ([Security.Principal.SecurityIdentifier]$acl.Owner).Value
}
$raw = [Security.AccessControl.RawSecurityDescriptor]::new(
  $acl.GetSecurityDescriptorSddlForm(
    [Security.AccessControl.AccessControlSections]::All
  )
)
$rules = @($raw.DiscretionaryAcl | ForEach-Object {
  $common = $_ -is [Security.AccessControl.CommonAce]
  [pscustomobject]@{
    common = $common
    sid = if ($_ -is [Security.AccessControl.KnownAce]) {
      $_.SecurityIdentifier.Value
    } else { $null }
    rights = if ($_ -is [Security.AccessControl.KnownAce]) {
      [int64]$_.AccessMask
    } else { 0 }
    qualifier = if ($common) { $_.AceQualifier.ToString() } else { $null }
    callback = if ($common) { $_.IsCallback } else { $false }
    flags = $_.AceFlags.ToString()
  }
})
[pscustomobject]@{
  currentSid = $currentSid
  ownerSid = $ownerSid
  protected = $acl.AreAccessRulesProtected
  rules = $rules
} | ConvertTo-Json -Depth 4 -Compress
`;

const WINDOWS_CREATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($env:MYDASHBOARD_PRIVATE_PATH)
)
$parent = [Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($env:MYDASHBOARD_PRIVATE_PARENT)
)
$leaf = [Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($env:MYDASHBOARD_PRIVATE_LEAF)
)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

public static class MyDashboardPrivateDirectory {
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

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
    string descriptor, uint revision, out IntPtr securityDescriptor, out uint size);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(
    string name, uint access, uint share, IntPtr security,
    uint creation, uint flags, IntPtr template);

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

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(
    Microsoft.Win32.SafeHandles.SafeFileHandle handle,
    out BY_HANDLE_FILE_INFORMATION information);

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

  [DllImport("ntdll.dll")]
  private static extern int NtCreateFile(
    out Microsoft.Win32.SafeHandles.SafeFileHandle fileHandle,
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
  private static extern uint RtlNtStatusToDosError(int status);

  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);

  private static bool AllowedParentSid(SecurityIdentifier value, string currentSid) {
    string sid = value == null ? null : value.Value;
    return sid == currentSid || sid == "S-1-5-18" || sid == "S-1-5-32-544";
  }

  private static void ValidateParentTrust(
    Microsoft.Win32.SafeHandles.SafeFileHandle handle,
    string currentSid) {
    const int SE_FILE_OBJECT = 1;
    const uint OWNER_SECURITY_INFORMATION = 0x00000001;
    const uint DACL_SECURITY_INFORMATION = 0x00000004;
    const uint DANGEROUS_RIGHTS =
      0x00000002 | 0x00000004 | 0x00000010 | 0x00000040 |
      0x00000100 | 0x00010000 | 0x00040000 | 0x00080000 |
      0x10000000 | 0x40000000;
    IntPtr owner;
    IntPtr group;
    IntPtr dacl;
    IntPtr sacl;
    IntPtr descriptor;
    uint status = GetSecurityInfo(
      handle.DangerousGetHandle(),
      SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      out owner,
      out group,
      out dacl,
      out sacl,
      out descriptor);
    if (status != 0) throw new Win32Exception((int)status);
    try {
      SecurityIdentifier ownerSid = new SecurityIdentifier(owner);
      if (!AllowedParentSid(ownerSid, currentSid)) {
        throw new InvalidOperationException("parent owner is not trusted");
      }
      uint descriptorLength = GetSecurityDescriptorLength(descriptor);
      if (descriptorLength == 0 || descriptorLength > 65536) {
        throw new InvalidOperationException("parent DACL is invalid");
      }
      byte[] bytes = new byte[descriptorLength];
      Marshal.Copy(descriptor, bytes, 0, checked((int)descriptorLength));
      RawSecurityDescriptor raw = new RawSecurityDescriptor(bytes, 0);
      if (raw.DiscretionaryAcl == null) {
        throw new InvalidOperationException("parent DACL is absent");
      }
      foreach (GenericAce generic in raw.DiscretionaryAcl) {
        CommonAce ace = generic as CommonAce;
        if (
          ace == null || ace.IsCallback ||
          ace.AceQualifier != AceQualifier.AccessAllowed ||
          ace.SecurityIdentifier == null
        ) {
          throw new InvalidOperationException("parent ACE is unsupported");
        }
        uint rights = unchecked((uint)ace.AccessMask);
        if (
          !AllowedParentSid(ace.SecurityIdentifier, currentSid) &&
          (rights & DANGEROUS_RIGHTS) != 0
        ) {
          throw new InvalidOperationException("parent ACE can mutate children");
        }
      }
    } finally {
      LocalFree(descriptor);
    }
  }

  public static void Create(
    string parent, string leaf, string sid,
    ulong expectedDevice, ulong expectedInode) {
    const uint FILE_READ_ATTRIBUTES = 0x00000080;
    const uint READ_CONTROL = 0x00020000;
    const uint SHARE_READ_WRITE = 0x00000003;
    const uint OPEN_EXISTING = 3;
    const uint OPEN_REPARSE_POINT = 0x00200000;
    const uint BACKUP_SEMANTICS = 0x02000000;
    const uint DIRECTORY_ATTRIBUTE = 0x00000010;
    const uint REPARSE_ATTRIBUTE = 0x00000400;
    string descriptor = "O:" + sid + "G:" + sid +
      "D:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
    IntPtr securityDescriptor;
    uint size;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptor(
      descriptor, 1, out securityDescriptor, out size)) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    try {
      using (Microsoft.Win32.SafeHandles.SafeFileHandle parentHandle = CreateFile(
        parent,
        FILE_READ_ATTRIBUTES | READ_CONTROL,
        SHARE_READ_WRITE,
        IntPtr.Zero,
        OPEN_EXISTING,
        OPEN_REPARSE_POINT | BACKUP_SEMANTICS,
        IntPtr.Zero)) {
        if (parentHandle.IsInvalid) {
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        BY_HANDLE_FILE_INFORMATION information;
        if (!GetFileInformationByHandle(parentHandle, out information)) {
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        ulong inode = ((ulong)information.FileIndexHigh << 32) |
          information.FileIndexLow;
        if (
          information.VolumeSerialNumber != expectedDevice ||
          inode != expectedInode ||
          (information.FileAttributes & DIRECTORY_ATTRIBUTE) == 0 ||
          (information.FileAttributes & REPARSE_ATTRIBUTE) != 0
        ) {
          throw new InvalidOperationException("parent identity changed");
        }
        string testSignal = Environment.GetEnvironmentVariable(
          "MYDASHBOARD_TEST_NATIVE_PARENT_OPENED");
        if (!String.IsNullOrEmpty(testSignal)) {
          string signalPath = System.Text.Encoding.UTF8.GetString(
            Convert.FromBase64String(testSignal));
          System.IO.File.WriteAllText(signalPath, "parent-opened");
        }
        ValidateParentTrust(parentHandle, sid);
        if (
          String.IsNullOrEmpty(leaf) ||
          leaf == "." || leaf == ".." ||
          leaf.IndexOfAny(new char[] {'\\', '/'}) >= 0
        ) {
          throw new InvalidOperationException("invalid relative leaf");
        }
        IntPtr leafBuffer = Marshal.StringToHGlobalUni(leaf);
        IntPtr unicodePointer = IntPtr.Zero;
        try {
          UNICODE_STRING unicode = new UNICODE_STRING {
            Length = checked((ushort)(leaf.Length * 2)),
            MaximumLength = checked((ushort)((leaf.Length + 1) * 2)),
            Buffer = leafBuffer
          };
          unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
          Marshal.StructureToPtr(unicode, unicodePointer, false);
          OBJECT_ATTRIBUTES objectAttributes = new OBJECT_ATTRIBUTES {
            Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),
            RootDirectory = parentHandle.DangerousGetHandle(),
            ObjectName = unicodePointer,
            Attributes = 0x00000040,
            SecurityDescriptor = securityDescriptor,
            SecurityQualityOfService = IntPtr.Zero
          };
          IO_STATUS_BLOCK ioStatus = new IO_STATUS_BLOCK();
          Microsoft.Win32.SafeHandles.SafeFileHandle created;
          int status = NtCreateFile(
            out created,
            0x001F01FF,
            ref objectAttributes,
            ref ioStatus,
            IntPtr.Zero,
            0x00000080,
            0x00000007,
            2,
            0x00200021,
            IntPtr.Zero,
            0);
          using (created) {
            if (status < 0) {
              throw new Win32Exception((int)RtlNtStatusToDosError(status));
            }
          }
        } finally {
          if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
          Marshal.FreeHGlobal(leafBuffer);
        }
      }
    } finally {
      LocalFree(securityDescriptor);
    }
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
[MyDashboardPrivateDirectory]::Create(
  $parent,
  $leaf,
  $sid,
  [uint64]$env:MYDASHBOARD_PRIVATE_PARENT_DEVICE,
  [uint64]$env:MYDASHBOARD_PRIVATE_PARENT_INODE
)
`;

const WINDOWS_CLEANUP_SESSION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$plan = [Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($env:MYDASHBOARD_CLEANUP_PLAN)
) | ConvertFrom-Json
$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public sealed class MyDashboardExpectedRoot {
  public string Path;
  public ulong Device;
  public ulong Inode;
}

public sealed class MyDashboardCleanupSession : IDisposable {
  private sealed class Node {
    public SafeFileHandle Handle;
    public bool Directory;
    public int Depth;
  }

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

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFile(
    string name, uint access, uint share, IntPtr security,
    uint creation, uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(
    SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION information);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetFileInformationByHandle(
    SafeFileHandle handle, int informationClass, IntPtr information, uint size);

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
    [MarshalAs(UnmanagedType.Bool)] bool returnSingleEntry,
    IntPtr fileName,
    [MarshalAs(UnmanagedType.Bool)] bool restartScan);

  [DllImport("ntdll.dll")]
  private static extern uint RtlNtStatusToDosError(int status);

  private const uint DELETE = 0x00010000;
  private const uint FILE_LIST_DIRECTORY = 0x00000001;
  private const uint FILE_READ_ATTRIBUTES = 0x00000080;
  private const uint SYNCHRONIZE = 0x00100000;
  private const uint SHARE_READ = 0x00000001;
  private const uint OPEN_EXISTING = 3;
  private const uint OPEN_REPARSE_POINT = 0x00200000;
  private const uint BACKUP_SEMANTICS = 0x02000000;
  private const uint DIRECTORY_ATTRIBUTE = 0x00000010;
  private const uint REPARSE_ATTRIBUTE = 0x00000400;
  private const uint FILE_OPEN = 1;
  private const uint FILE_DIRECTORY_FILE = 0x00000001;
  private const uint FILE_NON_DIRECTORY_FILE = 0x00000040;
  private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
  private const uint FILE_OPEN_REPARSE_POINT = 0x00200000;
  private const int FILE_ID_BOTH_DIRECTORY_INFORMATION = 37;
  private const int STATUS_NO_MORE_FILES = unchecked((int)0x80000006);

  private readonly List<Node> nodes = new List<Node>();
  private readonly int maximumEntries;
  private readonly int maximumEntriesPerRoot;
  private readonly int maximumDepth;
  private readonly ulong maximumBytes;
  private ulong totalBytes;
  private int currentRootEntries;
  private bool committed;

  private MyDashboardCleanupSession(
    int maximumEntries,
    int maximumEntriesPerRoot,
    int maximumDepth,
    ulong maximumBytes) {
    this.maximumEntries = maximumEntries;
    this.maximumEntriesPerRoot = maximumEntriesPerRoot;
    this.maximumDepth = maximumDepth;
    this.maximumBytes = maximumBytes;
  }

  private static ulong Inode(BY_HANDLE_FILE_INFORMATION information) {
    return ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
  }

  private static ulong Size(BY_HANDLE_FILE_INFORMATION information) {
    return ((ulong)information.FileSizeHigh << 32) | information.FileSizeLow;
  }

  private static BY_HANDLE_FILE_INFORMATION Information(SafeFileHandle handle) {
    BY_HANDLE_FILE_INFORMATION information;
    if (!GetFileInformationByHandle(handle, out information)) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    return information;
  }

  private static void ValidateType(
    BY_HANDLE_FILE_INFORMATION information, bool directory) {
    bool actualDirectory =
      (information.FileAttributes & DIRECTORY_ATTRIBUTE) != 0;
    if (
      actualDirectory != directory ||
      (information.FileAttributes & REPARSE_ATTRIBUTE) != 0
    ) {
      throw new InvalidOperationException("unsupported filesystem entry");
    }
  }

  private SafeFileHandle OpenRoot(MyDashboardExpectedRoot expected) {
    SafeFileHandle handle = CreateFile(
      expected.Path,
      DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      SHARE_READ,
      IntPtr.Zero,
      OPEN_EXISTING,
      OPEN_REPARSE_POINT | BACKUP_SEMANTICS,
      IntPtr.Zero);
    if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
    BY_HANDLE_FILE_INFORMATION information = Information(handle);
    ValidateType(information, true);
    if (
      information.VolumeSerialNumber != expected.Device ||
      Inode(information) != expected.Inode
    ) {
      handle.Dispose();
      throw new InvalidOperationException("root identity changed");
    }
    return handle;
  }

  private static SafeFileHandle OpenRelative(
    SafeFileHandle parent, string name, bool directory) {
    if (
      String.IsNullOrEmpty(name) || name == "." || name == ".." ||
      name.IndexOfAny(new char[] {'\\', '/'}) >= 0
    ) {
      throw new InvalidOperationException("invalid child name");
    }
    IntPtr nameBuffer = Marshal.StringToHGlobalUni(name);
    IntPtr unicodePointer = IntPtr.Zero;
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
        RootDirectory = parent.DangerousGetHandle(),
        ObjectName = unicodePointer,
        Attributes = 0x00000040,
        SecurityDescriptor = IntPtr.Zero,
        SecurityQualityOfService = IntPtr.Zero
      };
      IO_STATUS_BLOCK ioStatus = new IO_STATUS_BLOCK();
      SafeFileHandle child;
      int status = NtCreateFile(
        out child,
        DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        ref attributes,
        ref ioStatus,
        IntPtr.Zero,
        0,
        SHARE_READ,
        FILE_OPEN,
        FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT |
          (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE),
        IntPtr.Zero,
        0);
      if (status < 0) {
        if (child != null) child.Dispose();
        throw new Win32Exception((int)RtlNtStatusToDosError(status));
      }
      return child;
    } finally {
      if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
      Marshal.FreeHGlobal(nameBuffer);
    }
  }

  private void AddNode(SafeFileHandle handle, bool directory, int depth) {
    if (
      depth > maximumDepth ||
      nodes.Count >= maximumEntries ||
      currentRootEntries >= maximumEntriesPerRoot
    ) {
      handle.Dispose();
      throw new InvalidOperationException("cleanup bound exceeded");
    }
    BY_HANDLE_FILE_INFORMATION information = Information(handle);
    ValidateType(information, directory);
    if (!directory) {
      if (information.NumberOfLinks != 1) {
        handle.Dispose();
        throw new InvalidOperationException("hard link rejected");
      }
      totalBytes = checked(totalBytes + Size(information));
      if (totalBytes > maximumBytes) {
        handle.Dispose();
        throw new InvalidOperationException("cleanup byte bound exceeded");
      }
    }
    nodes.Add(new Node { Handle = handle, Directory = directory, Depth = depth });
    currentRootEntries = checked(currentRootEntries + 1);
  }

  private void Enumerate(Node directory, uint expectedDevice) {
    const int bufferSize = 64 * 1024;
    IntPtr buffer = Marshal.AllocHGlobal(bufferSize);
    try {
      bool restart = true;
      while (true) {
        IO_STATUS_BLOCK ioStatus = new IO_STATUS_BLOCK();
        int status = NtQueryDirectoryFile(
          directory.Handle,
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
        int offset = 0;
        while (true) {
          IntPtr entry = IntPtr.Add(buffer, offset);
          uint nextOffset = unchecked((uint)Marshal.ReadInt32(entry, 0));
          uint attributes = unchecked((uint)Marshal.ReadInt32(entry, 56));
          int nameLength = Marshal.ReadInt32(entry, 60);
          string name = Marshal.PtrToStringUni(IntPtr.Add(entry, 104), nameLength / 2);
          if (name != "." && name != "..") {
            if ((attributes & REPARSE_ATTRIBUTE) != 0) {
              throw new InvalidOperationException("reparse entry rejected");
            }
            bool childDirectory = (attributes & DIRECTORY_ATTRIBUTE) != 0;
            SafeFileHandle child = OpenRelative(directory.Handle, name, childDirectory);
            BY_HANDLE_FILE_INFORMATION information = Information(child);
            if (information.VolumeSerialNumber != expectedDevice) {
              child.Dispose();
              throw new InvalidOperationException("cross-volume entry rejected");
            }
            AddNode(child, childDirectory, directory.Depth + 1);
          }
          if (nextOffset == 0) break;
          offset = checked(offset + (int)nextOffset);
        }
      }
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }

  private void PreflightRoot(MyDashboardExpectedRoot expected) {
    currentRootEntries = 0;
    SafeFileHandle root = OpenRoot(expected);
    AddNode(root, true, 0);
    int cursor = nodes.Count - 1;
    while (cursor < nodes.Count) {
      Node node = nodes[cursor++];
      if (node.Directory) Enumerate(node, checked((uint)expected.Device));
    }
  }

  public static MyDashboardCleanupSession Prepare(
    MyDashboardExpectedRoot[] roots,
    int maximumEntries,
    int maximumEntriesPerRoot,
    int maximumDepth,
    ulong maximumBytes) {
    if (
      roots == null || roots.Length == 0 ||
      maximumEntries < 1 ||
      maximumEntriesPerRoot < 1 ||
      maximumEntriesPerRoot > maximumEntries ||
      maximumDepth < 0
    ) {
      throw new ArgumentException("cleanup plan is invalid");
    }
    MyDashboardCleanupSession session = new MyDashboardCleanupSession(
      maximumEntries,
      maximumEntriesPerRoot,
      maximumDepth,
      maximumBytes);
    try {
      foreach (MyDashboardExpectedRoot root in roots) session.PreflightRoot(root);
      return session;
    } catch {
      session.Dispose();
      throw;
    }
  }

  private static void MarkDelete(SafeFileHandle handle) {
    IntPtr disposition = Marshal.AllocHGlobal(1);
    try {
      Marshal.WriteByte(disposition, 1);
      if (!SetFileInformationByHandle(handle, 4, disposition, 1)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
    } finally {
      Marshal.FreeHGlobal(disposition);
    }
  }

  public void Commit() {
    if (committed) throw new InvalidOperationException("cleanup already committed");
    committed = true;
    nodes.Sort(delegate(Node left, Node right) {
      int depth = right.Depth.CompareTo(left.Depth);
      if (depth != 0) return depth;
      return left.Directory.CompareTo(right.Directory);
    });
    foreach (Node node in nodes) {
      MarkDelete(node.Handle);
      node.Handle.Dispose();
    }
    nodes.Clear();
  }

  public void Dispose() {
    foreach (Node node in nodes) node.Handle.Dispose();
    nodes.Clear();
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$roots = New-Object 'MyDashboardExpectedRoot[]' @($plan.roots).Count
for ($index = 0; $index -lt @($plan.roots).Count; $index += 1) {
  $value = @($plan.roots)[$index]
  $root = [MyDashboardExpectedRoot]::new()
  $root.Path = [string]$value.path
  $root.Device = [uint64]$value.device
  $root.Inode = [uint64]$value.inode
  $roots[$index] = $root
}
$session = $null
try {
  $session = [MyDashboardCleanupSession]::Prepare(
    $roots,
    [int]$plan.maximumEntries,
    [int]$plan.maximumEntriesPerRoot,
    [int]$plan.maximumDepth,
    [uint64]$plan.maximumBytes
  )
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  $command = [Console]::In.ReadLine()
  if ($command -ne 'COMMIT') { throw 'cleanup commit was not authorized' }
  $session.Commit()
  [Console]::Out.WriteLine('DONE')
  [Console]::Out.Flush()
} finally {
  if ($null -ne $session) { $session.Dispose() }
}
`;

async function inspectWindowsTrust(directory, { privateLeaf, signal }) {
  const output = await runPowerShell(
    WINDOWS_ACL_SCRIPT,
    {
      MYDASHBOARD_PRIVATE_PATH: Buffer.from(directory, "utf8").toString("base64"),
    },
    signal,
  );
  const acl = JSON.parse(output);
  const allowed = new Set([
    acl.currentSid,
    WINDOWS_SYSTEM_SID,
    WINDOWS_ADMINISTRATORS_SID,
  ]);
  const supportedRule = (rule) =>
    rule.common === true &&
    rule.callback === false &&
    rule.qualifier === "AccessAllowed" &&
    typeof rule.sid === "string" &&
    typeof rule.flags === "string";
  if (privateLeaf) {
    return acl.ownerSid === acl.currentSid &&
      acl.protected === true &&
      acl.rules.length === allowed.size &&
      [...allowed].every((sid) => acl.rules.some((rule) =>
        supportedRule(rule) &&
        rule.sid === sid &&
        BigInt(rule.rights) === WINDOWS_FULL_CONTROL));
  }
  return allowed.has(acl.ownerSid) && acl.rules.every((rule) =>
    supportedRule(rule) &&
    (allowed.has(rule.sid) ||
      (BigInt(rule.rights) & WINDOWS_PARENT_DANGEROUS_RIGHTS) === 0n));
}

export function createPrivateDirectoryManager(options = {}) {
  const fileSystem = options.fileSystem ?? { chmod, lstat, mkdir, realpath };
  const inspectDirectoryTrust = options.inspectDirectoryTrust ??
    (process.platform === "win32"
      ? (directory, details, context) => inspectWindowsTrust(directory, context)
      : async () => false);
  const createDirectoryAt = options.createDirectoryAt ??
    (options.fileSystem === undefined
      ? createWindowsDirectoryAt
      : async ({ directory, signal }) => {
          await fileSystem.mkdir(directory, { recursive: false, mode: 0o700 });
          throwIfAborted(signal);
          if (process.platform !== "win32") await fileSystem.chmod(directory, 0o700);
        });

  async function inspect(directory, { privateLeaf, signal }) {
    throwIfAborted(signal);
    const details = await fileSystem.lstat(directory, { bigint: true });
    throwIfAborted(signal);
    const resolved = await fileSystem.realpath(directory);
    throwIfAborted(signal);
    if (canonicalPath(resolved) !== canonicalPath(directory)) throw unavailable();
    const identity = directoryIdentity(details, resolved);
    if (!await inspectDirectoryTrust(resolved, details, { privateLeaf, signal })) {
      throw unavailable();
    }
    return identity;
  }

  return Object.freeze({
    async prepare({ directory, signal = null, validateLocation }) {
      if (typeof validateLocation !== "function") throw new TypeError("validateLocation is required");
      throwIfAborted(signal);
      try {
        const existing = await inspect(directory, { privateLeaf: true, signal });
        await validateLocation();
        const final = await inspect(directory, { privateLeaf: true, signal });
        if (existing.device !== final.device || existing.inode !== final.inode) {
          throw unavailable();
        }
        return final;
      } catch (error) {
        if (error?.code !== "ENOENT") throw unavailable();
      }

      const parent = path.dirname(directory);
      if (parent === directory) throw unavailable();
      const initialParent = await inspect(parent, {
        privateLeaf: false,
        signal,
      });
      await validateLocation();
      const finalParentDetails = await fileSystem.lstat(parent, { bigint: true });
      throwIfAborted(signal);
      if (!sameIdentity(initialParent, finalParentDetails)) throw unavailable();
      await createDirectoryAt({
        directory,
        leafName: path.basename(directory),
        parentIdentity: initialParent,
        signal,
      });
      throwIfAborted(signal);
      await validateLocation();
      return inspect(directory, { privateLeaf: true, signal });
    },
  });
}

async function createWindowsDirectoryAt({
  directory,
  leafName,
  parentIdentity,
  signal,
  nativeParentOpenedSignal = null,
}) {
  if (
    path.basename(directory) !== leafName ||
    path.dirname(directory) !== parentIdentity.path
  ) {
    throw unavailable();
  }
  if (!productionSupervisedCliPlatformSupported()) throw unavailable();
  if (
    nativeParentOpenedSignal !== null &&
    (
      typeof nativeParentOpenedSignal !== "string" ||
      !path.isAbsolute(nativeParentOpenedSignal)
    )
  ) {
    throw new TypeError("native parent-opened signal is invalid");
  }
  await runPowerShell(
    WINDOWS_CREATE_SCRIPT,
    {
      MYDASHBOARD_PRIVATE_PATH: Buffer.from(directory, "utf8").toString("base64"),
      MYDASHBOARD_PRIVATE_PARENT: Buffer.from(parentIdentity.path, "utf8").toString("base64"),
      MYDASHBOARD_PRIVATE_LEAF: Buffer.from(leafName, "utf8").toString("base64"),
      MYDASHBOARD_PRIVATE_PARENT_DEVICE: parentIdentity.device,
      MYDASHBOARD_PRIVATE_PARENT_INODE: parentIdentity.inode,
      ...(nativeParentOpenedSignal === null
        ? {}
        : {
            MYDASHBOARD_TEST_NATIVE_PARENT_OPENED: Buffer.from(
              nativeParentOpenedSignal,
              "utf8",
            ).toString("base64"),
          }),
    },
    signal,
  );
}

export function createTestSynchronizedWindowsPrivateDirectoryManager({
  beforeParentTrustInspection,
  afterParentTrustInspection,
  nativeParentOpenedSignal,
} = {}) {
  if (
    typeof beforeParentTrustInspection !== "function" ||
    typeof afterParentTrustInspection !== "function" ||
    typeof nativeParentOpenedSignal !== "string" ||
    !path.isAbsolute(nativeParentOpenedSignal)
  ) {
    throw new TypeError("Windows private-directory test synchronization is invalid");
  }
  if (!productionSupervisedCliPlatformSupported()) throw unavailable();
  return createPrivateDirectoryManager({
    async inspectDirectoryTrust(directory, details, context) {
      if (context.privateLeaf) {
        return inspectWindowsTrust(directory, context);
      }
      await beforeParentTrustInspection();
      try {
        return await inspectWindowsTrust(directory, context);
      } finally {
        await afterParentTrustInspection();
      }
    },
    async createDirectoryAt(options) {
      try {
        await createWindowsDirectoryAt({
          ...options,
          nativeParentOpenedSignal,
        });
      } catch {
        throw unavailable();
      }
    },
  });
}

const WINDOWS_PRIVATE_DIRECTORY_MANAGER = createPrivateDirectoryManager();

export const PRODUCTION_PRIVATE_DIRECTORY_MANAGER = Object.freeze({
  prepare(options) {
    if (!productionSupervisedCliPlatformSupported()) throw unavailable();
    return WINDOWS_PRIVATE_DIRECTORY_MANAGER.prepare(options);
  },
});

export async function prepareCleanupTreesByIdentity(roots, options = {}) {
  const maximumEntriesPerRoot =
    options.maximumEntriesPerRoot ?? options.maximumEntries;
  if (!productionSupervisedCliPlatformSupported()) throw unavailable();
  if (
    !Array.isArray(roots) || roots.length === 0 ||
    roots.some((root) =>
      root === null ||
      typeof root !== "object" ||
      typeof root.path !== "string" ||
      typeof root.device !== "string" ||
      typeof root.inode !== "string") ||
    !Number.isSafeInteger(options.maximumEntries) ||
    options.maximumEntries < 1 ||
    !Number.isSafeInteger(maximumEntriesPerRoot) ||
    maximumEntriesPerRoot < 1 ||
    maximumEntriesPerRoot > options.maximumEntries ||
    !Number.isSafeInteger(options.maximumDepth) ||
    options.maximumDepth < 0 ||
    !Number.isSafeInteger(options.maximumBytes) ||
    options.maximumBytes < 0 ||
    !(options.signal instanceof AbortSignal)
  ) {
    throw new TypeError("cleanup plan is invalid");
  }
  throwIfAborted(options.signal);
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const executable = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const compressedScript = gzipSync(
    Buffer.from(WINDOWS_CLEANUP_SESSION_SCRIPT, "utf8"),
  ).toString("base64");
  const encodedPlan = Buffer.from(JSON.stringify({
    roots,
    maximumEntries: options.maximumEntries,
    maximumEntriesPerRoot,
    maximumDepth: options.maximumDepth,
    maximumBytes: options.maximumBytes,
  }), "utf8").toString("base64");
  const child = spawn(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$b=[Convert]::FromBase64String($env:MYDASHBOARD_CLEANUP_SCRIPT);" +
        "$m=[IO.MemoryStream]::new($b);" +
        "$g=[IO.Compression.GzipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);" +
        "$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);iex $r.ReadToEnd()",
    ],
    {
      windowsHide: true,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        MYDASHBOARD_CLEANUP_SCRIPT: compressedScript,
        MYDASHBOARD_CLEANUP_PLAN: encodedPlan,
      },
    },
  );
  let output = "";
  let ready = false;
  let done = false;
  let committed = false;
  let resolveReady;
  let rejectReady;
  let resolveDone;
  let rejectDone;
  let resolveClosed;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const donePromise = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  void donePromise.catch(() => {});
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const rejectSession = () => {
    const failure = cleanupFailed();
    if (!ready) rejectReady(failure);
    if (!done) rejectDone(failure);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-1_024);
    if (!ready && output.includes("READY")) {
      ready = true;
      resolveReady();
    }
    if (!done && output.includes("DONE")) {
      done = true;
      resolveDone();
    }
  });
  child.stderr.resume();
  child.stdin.on("error", rejectSession);
  child.on("error", rejectSession);
  child.on("exit", (code) => {
    if (code !== 0 || !done) rejectSession();
  });
  child.on("close", resolveClosed);
  try {
    await readyPromise;
  } catch (error) {
    await closedPromise;
    throw error;
  }
  if (options.signal.aborted) {
    await closedPromise;
    throwIfAborted(options.signal);
  }
  return Object.freeze({
    async commit() {
      if (committed) throw cleanupFailed();
      committed = true;
      if (options.signal.aborted) {
        await closedPromise;
        throwIfAborted(options.signal);
      }
      child.stdin.end("COMMIT\n");
      try {
        await donePromise;
      } catch (error) {
        await closedPromise;
        throw error;
      }
      await closedPromise;
      if (options.signal.aborted) {
        throwIfAborted(options.signal);
      }
    },
    async close() {
      if (!committed) {
        committed = true;
        child.stdin.end();
      }
      await closedPromise;
    },
  });
}
