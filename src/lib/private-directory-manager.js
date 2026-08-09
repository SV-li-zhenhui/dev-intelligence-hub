import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

const WINDOWS_SYSTEM_SID = "S-1-5-18";
const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";
const WINDOWS_PARENT_DANGEROUS_RIGHTS =
  64n | 65_536n | 262_144n | 524_288n;

function unavailable() {
  return Object.assign(new Error("Private directory trust is unavailable"), {
    code: "STRUCTURED_PROVIDER_UNAVAILABLE",
  });
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
        signal,
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
$rules = @($acl.GetAccessRules(
  $true,
  $true,
  [Security.Principal.SecurityIdentifier]
) | ForEach-Object {
  [pscustomobject]@{
    sid = $_.IdentityReference.Value
    rights = [int64]$_.FileSystemRights
    type = $_.AccessControlType.ToString()
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
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class MyDashboardPrivateDirectory {
  [StructLayout(LayoutKind.Sequential)]
  private struct SECURITY_ATTRIBUTES {
    public int nLength;
    public IntPtr lpSecurityDescriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
    string descriptor, uint revision, out IntPtr securityDescriptor, out uint size);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateDirectory(string path, ref SECURITY_ATTRIBUTES attributes);

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

  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);

  public static void Create(
    string path, string parent, string sid,
    ulong expectedDevice, ulong expectedInode) {
    const uint FILE_READ_ATTRIBUTES = 0x00000080;
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
        FILE_READ_ATTRIBUTES,
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
        SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES {
          nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),
          lpSecurityDescriptor = securityDescriptor,
          bInheritHandle = false
        };
        if (!CreateDirectory(path, ref attributes)) {
          throw new Win32Exception(Marshal.GetLastWin32Error());
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
  $target,
  $parent,
  $sid,
  [uint64]$env:MYDASHBOARD_PRIVATE_PARENT_DEVICE,
  [uint64]$env:MYDASHBOARD_PRIVATE_PARENT_INODE
)
`;

const WINDOWS_DELETE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$node = [Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($env:MYDASHBOARD_CLEANUP_NODE)
) | ConvertFrom-Json
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class MyDashboardIdentityDelete {
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

  public static void Delete(
    string path, ulong expectedDevice, ulong expectedInode,
    ulong expectedLinks, ulong expectedSize, bool directory) {
    const uint DELETE = 0x00010000;
    const uint FILE_READ_ATTRIBUTES = 0x00000080;
    const uint SHARE_ALL = 0x00000007;
    const uint OPEN_EXISTING = 3;
    const uint OPEN_REPARSE_POINT = 0x00200000;
    const uint BACKUP_SEMANTICS = 0x02000000;
    const uint DIRECTORY_ATTRIBUTE = 0x00000010;
    const uint REPARSE_ATTRIBUTE = 0x00000400;
    using (SafeFileHandle handle = CreateFile(
      path,
      DELETE | FILE_READ_ATTRIBUTES,
      SHARE_ALL,
      IntPtr.Zero,
      OPEN_EXISTING,
      OPEN_REPARSE_POINT | BACKUP_SEMANTICS,
      IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      BY_HANDLE_FILE_INFORMATION information;
      if (!GetFileInformationByHandle(handle, out information)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      ulong inode = ((ulong)information.FileIndexHigh << 32) |
        information.FileIndexLow;
      ulong size = ((ulong)information.FileSizeHigh << 32) |
        information.FileSizeLow;
      bool actualDirectory =
        (information.FileAttributes & DIRECTORY_ATTRIBUTE) != 0;
      if (
        information.VolumeSerialNumber != expectedDevice ||
        inode != expectedInode ||
        actualDirectory != directory ||
        (!directory && (
          information.NumberOfLinks != expectedLinks || size != expectedSize)) ||
        (information.FileAttributes & REPARSE_ATTRIBUTE) != 0
      ) {
        throw new InvalidOperationException("filesystem identity changed");
      }
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
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
[MyDashboardIdentityDelete]::Delete(
  [string]$node.path,
  [uint64]$node.device,
  [uint64]$node.inode,
  [uint64]$node.links,
  [uint64]$node.size,
  [bool]$node.directory
)
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
  if (privateLeaf) {
    return acl.ownerSid === acl.currentSid &&
      acl.protected === true &&
      acl.rules.some((rule) =>
        rule.sid === acl.currentSid &&
        rule.type === "Allow" &&
        (BigInt(rule.rights) & 2_032_127n) === 2_032_127n) &&
      acl.rules.every((rule) =>
        rule.type !== "Allow" || allowed.has(rule.sid));
  }
  return allowed.has(acl.ownerSid) && acl.rules.every((rule) =>
    rule.type !== "Allow" ||
    allowed.has(rule.sid) ||
    (BigInt(rule.rights) & WINDOWS_PARENT_DANGEROUS_RIGHTS) === 0n);
}

function inspectPosixTrust(details, { privateLeaf }) {
  if (typeof process.getuid !== "function") return false;
  if (details.uid !== BigInt(process.getuid())) return false;
  const forbidden = privateLeaf ? 0o077n : 0o022n;
  return (details.mode & forbidden) === 0n;
}

export function createPrivateDirectoryManager(options = {}) {
  const fileSystem = options.fileSystem ?? { chmod, lstat, mkdir, realpath };
  const inspectDirectoryTrust = options.inspectDirectoryTrust ??
    (process.platform === "win32"
      ? (directory, details, context) => inspectWindowsTrust(directory, context)
      : (_directory, details, context) => inspectPosixTrust(details, context));
  const createDirectoryAt = options.createDirectoryAt ??
    (options.fileSystem === undefined
      ? createProductionDirectoryAt
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

async function createProductionDirectoryAt({
  directory,
  leafName,
  parentIdentity,
  signal,
}) {
  if (
    path.basename(directory) !== leafName ||
    path.dirname(directory) !== parentIdentity.path
  ) {
    throw unavailable();
  }
  if (process.platform === "win32") {
    await runPowerShell(
      WINDOWS_CREATE_SCRIPT,
      {
        MYDASHBOARD_PRIVATE_PATH: Buffer.from(directory, "utf8").toString("base64"),
        MYDASHBOARD_PRIVATE_PARENT: Buffer.from(parentIdentity.path, "utf8").toString("base64"),
        MYDASHBOARD_PRIVATE_PARENT_DEVICE: parentIdentity.device,
        MYDASHBOARD_PRIVATE_PARENT_INODE: parentIdentity.inode,
      },
      signal,
    );
    return;
  }
  const parentHandle = await open(
    parentIdentity.path,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    throwIfAborted(signal);
    const details = await parentHandle.stat({ bigint: true });
    if (!sameIdentity(parentIdentity, details)) throw unavailable();
    const descriptorRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
    const anchoredPath = path.join(descriptorRoot, String(parentHandle.fd), leafName);
    await mkdir(anchoredPath, { recursive: false, mode: 0o700 });
    throwIfAborted(signal);
  } finally {
    if (!signal?.aborted) await parentHandle.close();
  }
}

export const PRODUCTION_PRIVATE_DIRECTORY_MANAGER =
  createPrivateDirectoryManager();

function sameNodeIdentity(node, details) {
  const identityMatches = !details.isSymbolicLink() &&
    details.dev.toString() === node.device &&
    details.ino.toString() === node.inode &&
    details.isDirectory() === node.directory &&
    details.isFile() === node.file;
  return identityMatches &&
    (node.directory ||
      (details.nlink.toString() === node.links.toString() &&
        details.size.toString() === node.size.toString()));
}

async function deleteWindowsNode(node, signal) {
  throwIfAborted(signal);
  await runPowerShell(
    WINDOWS_DELETE_SCRIPT,
    {
      MYDASHBOARD_CLEANUP_NODE: Buffer.from(JSON.stringify({
        path: node.path,
        device: node.device,
        inode: node.inode,
        links: node.links.toString(),
        size: node.size.toString(),
        directory: node.directory,
      }), "utf8").toString("base64"),
    },
    signal,
  );
  throwIfAborted(signal);
}

async function deletePosixNode(node, signal) {
  if (node.parent === null) throw unavailable();
  throwIfAborted(signal);
  const parentHandle = await open(
    node.parent.path,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    throwIfAborted(signal);
    const parentDetails = await parentHandle.stat({ bigint: true });
    if (!sameIdentity(node.parent, parentDetails)) throw unavailable();
    throwIfAborted(signal);
    const descriptorRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
    const anchoredPath = path.join(
      descriptorRoot,
      String(parentHandle.fd),
      path.basename(node.path),
    );
    const details = await lstat(anchoredPath, { bigint: true });
    if (!sameNodeIdentity(node, details)) throw unavailable();
    throwIfAborted(signal);
    if (node.file) await unlink(anchoredPath);
    else await rmdir(anchoredPath);
    throwIfAborted(signal);
  } finally {
    if (!signal?.aborted) await parentHandle.close();
  }
}

export async function deleteInventoryByIdentity(nodes, signal = null) {
  for (const node of nodes) {
    throwIfAborted(signal);
    if (process.platform === "win32") await deleteWindowsNode(node, signal);
    else await deletePosixNode(node, signal);
  }
}
