import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  createProductionCodexCredentialFilePort,
  createTestCodexCredentialFilePort,
} from "../src/lib/windows-codex-credential-file.js";

const CREDENTIAL_LIMIT = 65_536;
const PRIVATE_FILE_LIMIT = 192 * 1024;
const PACKET_LIMIT = 384 * 1024;
const WINDOWS_NATIVE_SUPPORTED = process.platform === "win32" && process.arch === "x64";

function ok(bytes = null) {
  return bytes === null
    ? { schemaVersion: 1, status: "ok" }
    : {
        schemaVersion: 1,
        status: "ok",
        bytesBase64: Buffer.from(bytes).toString("base64"),
      };
}

function frozenDirectory(directory) {
  return lstat(directory, { bigint: true }).then((details) => Object.freeze({
    path: directory,
    device: details.dev.toString(),
    inode: details.ino.toString(),
  }));
}

function serializedError(error) {
  return JSON.stringify({
    name: error?.name,
    message: error?.message,
    code: error?.code,
    stack: error?.stack,
    fields: Object.fromEntries(Object.entries(error || {})),
  });
}

function createControlledProcessPort(script) {
  const capture = {
    args: null,
    closed: false,
    env: null,
    executable: null,
    killCount: 0,
    options: null,
    stdin: null,
  };
  let spawnedResolve;
  const spawned = new Promise((resolve) => {
    spawnedResolve = resolve;
  });
  const port = createTestCodexCredentialFilePort({
    spawnProcess(executable, args, options) {
      capture.executable = executable;
      capture.args = args;
      capture.options = options;
      capture.env = options.env;
      const child = spawn(process.execPath, ["-e", script], {
        env: options.env,
        signal: options.signal,
        stdio: options.stdio,
        windowsHide: options.windowsHide,
      });
      const originalEnd = child.stdin.end.bind(child.stdin);
      child.stdin.end = (chunk, ...rest) => {
        capture.stdin = Buffer.from(chunk);
        return originalEnd(chunk, ...rest);
      };
      const originalKill = child.kill.bind(child);
      child.kill = (...args) => {
        capture.killCount += 1;
        return originalKill(...args);
      };
      child.once("close", () => {
        capture.closed = true;
      });
      spawnedResolve(child);
      return child;
    },
  });
  return { capture, port, spawned };
}

function isRedactedFailure(error, expectedCode, markers = []) {
  const serialized = serializedError(error);
  return error?.code === expectedCode &&
    markers.every((marker) => !serialized.includes(marker));
}

function fixturePowerShell(script) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const executable = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return spawnSync(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    },
  );
}

function decodedPathExpression(file) {
  const encoded = Buffer.from(file, "utf8").toString("base64");
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`;
}

function requireFixturePowerShell(script, label) {
  const result = fixturePowerShell(script);
  assert.equal(
    result.status,
    0,
    `${label}: ${[result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n")}`,
  );
}

function protectFixtureDirectory(directory, { inheritedWorldRead = false } = {}) {
  const target = decodedPathExpression(directory);
  requireFixturePowerShell(String.raw`
$ErrorActionPreference = 'Stop'
$target = ${target}
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($current)
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
foreach ($sid in @($current, $system, $administrators)) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow)
  [void]$acl.AddAccessRule($rule)
}
if (${inheritedWorldRead ? "$true" : "$false"}) {
  $world = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
  $read = [Security.AccessControl.FileSystemAccessRule]::new($world, [Security.AccessControl.FileSystemRights]::ReadAndExecute, $inheritance, $propagation, $allow)
  [void]$acl.AddAccessRule($read)
}
[IO.DirectoryInfo]::new($target).SetAccessControl($acl)
`, "protect fixture directory");
}

function addWorldWriteAce(file) {
  const target = decodedPathExpression(file);
  requireFixturePowerShell(String.raw`
$ErrorActionPreference = 'Stop'
$target = ${target}
$world = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$file = [IO.FileInfo]::new($target)
$acl = $file.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
$rule = [Security.AccessControl.FileSystemAccessRule]::new($world, [Security.AccessControl.FileSystemRights]::WriteData, [Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
$file.SetAccessControl($acl)
`, "add fictional dangerous write ACE");
}

function trySetAdministratorsOwner(file) {
  const target = decodedPathExpression(file);
  return fixturePowerShell(String.raw`
$ErrorActionPreference = 'Stop'
$target = ${target}
$administrators = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$file = [IO.FileInfo]::new($target)
$sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
$acl = $file.GetAccessControl($sections)
$acl.SetOwner($administrators)
$file.SetAccessControl($acl)
  `);
}

function ownerFixturePrivilegeDenied(result) {
  if (result.status === 0 || result.error) return false;
  const output = `${result.stdout || ""}\n${result.stderr || ""}`
    .replace(/_x[0-9a-f]{4}_/giu, "")
    .replace(/<[^>]*>/gu, "")
    .replace(/\s+/gu, " ");
  return /(?:UnauthorizedAccessException|PrivilegeNotHeldException|Access is denied|privilege is not held|unauthorized operation|security identifier is not allowed to be the owner of this object)/iu.test(output);
}

function addWorldAllowAce(targetPath, right) {
  const target = decodedPathExpression(targetPath);
  requireFixturePowerShell(String.raw`
$ErrorActionPreference = 'Stop'
$target = ${target}
$world = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$item = Get-Item -LiteralPath $target
$acl = $item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
$rights = [Security.AccessControl.FileSystemRights]::${right}
$rule = [Security.AccessControl.FileSystemAccessRule]::new($world, $rights, [Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
$item.SetAccessControl($acl)
`, `add fictional world ${right} ACE`);
}

function invokeNativeHelper(
  packet,
  helperPath = path.resolve("src/lib/windows-codex-credential-helper.ps1"),
) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const executable = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = spawnSync(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helperPath,
    ],
    {
      encoding: "utf8",
      env: { SystemRoot: systemRoot, WINDIR: systemRoot },
      input: typeof packet === "string" ? packet : JSON.stringify(packet),
      maxBuffer: 512 * 1024,
      timeout: 120_000,
      windowsHide: true,
    },
  );
  assert.equal(
    result.status,
    0,
    [result.error?.message, result.stderr].filter(Boolean).join("\n"),
  );
  return JSON.parse(result.stdout);
}

async function makeNativeBoundHarness(root) {
  const helperPath = path.resolve("src/lib/windows-codex-credential-helper.ps1");
  let harnessSource = (await readFile(helperPath, "utf8")).replaceAll("\r\n", "\n");
  harnessSource = harnessSource.replace(
    "$MaximumPacketBytes = 192 * 1024",
    "$MaximumPacketBytes = 384 * 1024",
  );
  const selectors = [
    {
      operation: "read-source",
      candidates: [
        "$maximum = Read-Maximum $request.maximumBytes $MaximumCredentialBytes",
      ],
    },
    {
      operation: "read-private",
      candidates: [
        "$maximum = Read-Maximum $request.maximumBytes $MaximumCredentialBytes",
        "$maximum = Read-Maximum $request.maximumBytes $MaximumPrivateFileBytes",
      ],
    },
    {
      operation: "write-new-private",
      candidates: [
        "$bytes = Decode-CanonicalBase64 $request.bytesBase64 $MaximumCredentialBytes",
        "$bytes = Decode-CanonicalBase64 $request.bytesBase64 $MaximumPrivateFileBytes",
      ],
    },
    {
      operation: "replace-private",
      candidates: [
        "$bytes = Decode-CanonicalBase64 $request.bytesBase64 $MaximumCredentialBytes",
        "$bytes = Decode-CanonicalBase64 $request.bytesBase64 $MaximumPrivateFileBytes",
      ],
    },
  ];
  for (const { operation, candidates } of selectors) {
    const start = harnessSource.lastIndexOf(`    '${operation}' {`);
    const end = harnessSource.indexOf("\n    '", start + 1);
    if (start < 0 || end < 0) {
      throw new Error(`native bound harness could not isolate ${operation}`);
    }
    const block = harnessSource.slice(start, end);
    const matches = candidates.filter((candidate) => block.includes(candidate));
    if (matches.length !== 1) {
      throw new Error(`native bound harness found an unexpected ${operation} selector`);
    }
    const widenedBlock = block.replace(matches[0], matches[0].replace(
      /\$Maximum(?:Credential|PrivateFile)Bytes/u,
      "(384 * 1024)",
    ));
    harnessSource = harnessSource.slice(0, start) + widenedBlock + harnessSource.slice(end);
  }
  const harnessPath = path.join(root, "native-bound-harness.ps1");
  await writeFile(harnessPath, harnessSource, { encoding: "utf8", flag: "wx" });
  return harnessPath;
}

function queryStableFileIdentity(file) {
  const target = decodedPathExpression(file);
  const result = fixturePowerShell(String.raw`
$ErrorActionPreference = 'Stop'
$target = ${target}
$source = @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class MyDashboardTestFileId {
  [StructLayout(LayoutKind.Sequential)]
  private struct FILE_ID_INFO {
    public ulong VolumeSerialNumber;
    public ulong FileIdLow;
    public ulong FileIdHigh;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(
    string name, uint access, uint share, IntPtr security,
    uint creation, uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(
    SafeFileHandle handle, int informationClass,
    out FILE_ID_INFO information, uint bufferSize);

  public static string Read(string path) {
    using (SafeFileHandle handle = CreateFileW(
      path, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      FILE_ID_INFO information;
      if (!GetFileInformationByHandleEx(
        handle, 18, out information, (uint)Marshal.SizeOf(typeof(FILE_ID_INFO)))) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      return String.Format(
        CultureInfo.InvariantCulture,
        "{0:X16}:{1:X16}:{2:X16}",
        information.VolumeSerialNumber,
        information.FileIdLow,
        information.FileIdHigh);
    }
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
[Console]::Out.Write([MyDashboardTestFileId]::Read($target))
`);
  assert.equal(
    result.status,
    0,
    `FILE_ID_INFO fixture unavailable: ${[
      result.error?.message,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n")}`,
  );
  assert.match(result.stdout, /^[0-9A-F]{16}(?::[0-9A-F]{16}){2}$/u);
  return result.stdout;
}

function mutationMutexName(stableIdentity, name) {
  const digest = createHash("sha256")
    .update(`${stableIdentity}\n${name.toUpperCase()}`, "utf8")
    .digest("hex");
  return `Local\\MyDashboard.CodexCredential.${digest}`;
}

function startMutexHolder(name) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const executable = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const encodedName = Buffer.from(name, "utf8").toString("base64");
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedName}'))
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$security = [Security.AccessControl.MutexSecurity]::new()
$security.SetOwner($current)
$security.SetAccessRuleProtection($true, $false)
foreach ($sid in @(
  $current,
  [Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
  [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
)) {
  $rule = [Security.AccessControl.MutexAccessRule]::new(
    $sid,
    [Security.AccessControl.MutexRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$security.AddAccessRule($rule)
}
[bool]$created = $false
$mutex = [Threading.Mutex]::new($false, $name, [ref]$created, $security)
$acquired = $false
try {
  $acquired = $mutex.WaitOne(30000)
  if (-not $acquired) { throw 'test mutex acquisition timed out' }
  [Console]::Out.WriteLine('ready')
  [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
} finally {
  if ($acquired) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
`;
  const child = spawn(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: { SystemRoot: systemRoot, WINDIR: systemRoot },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const ready = new Promise((resolve, reject) => {
    const checkReady = () => {
      if (stdout.includes("ready")) resolve();
    };
    child.stdout.on("data", checkReady);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!stdout.includes("ready")) {
        reject(new Error(`mutex holder exited ${code}: ${stderr}`));
      }
    });
  });
  const close = new Promise((resolve) => child.once("close", resolve));
  return {
    child,
    close,
    ready,
    release() {
      child.stdin.end("release\n");
    },
  };
}

async function makeNativeRoot(t, suffix) {
  const directory = await mkdtemp(path.join(tmpdir(), `mydashboard-task2-${suffix}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  protectFixtureDirectory(directory);
  return directory;
}

test("credential file port emits exact helper requests for all stable operations", async () => {
  const source = "D:\\fictional-profile\\auth.json";
  const directory = Object.freeze({
    path: "D:\\fictional-private",
    device: "17",
    inode: "29",
  });
  const signal = AbortSignal.timeout(30_000);
  const requests = [];
  const contexts = [];
  const port = createTestCodexCredentialFilePort({
    async invoke(request, context) {
      requests.push(request);
      contexts.push(context);
      return request.operation.startsWith("read-") ? ok("fictional-auth") : ok();
    },
  });

  assert.deepEqual(
    await port.readSource({ file: source, maximumBytes: 65_536, signal }),
    Buffer.from("fictional-auth"),
  );
  assert.deepEqual(
    await port.readPrivate({
      directory,
      name: "state.json",
      maximumBytes: 65_536,
      required: true,
      signal,
    }),
    Buffer.from("fictional-auth"),
  );
  await port.writeNewPrivate({
    directory,
    name: "auth.json",
    bytes: Buffer.from("fictional-new"),
    signal,
  });
  await port.replacePrivate({
    directory,
    name: "state.json",
    bytes: Buffer.from("fictional-next"),
    signal,
  });
  await port.removePrivate({ directory, name: "state.json", signal });

  assert.deepEqual(
    requests.map((request) => Object.keys(request).sort()),
    [
      ["fileBase64", "maximumBytes", "operation", "schemaVersion"],
      ["directory", "maximumBytes", "name", "operation", "required", "schemaVersion"],
      ["bytesBase64", "directory", "name", "operation", "schemaVersion"],
      ["bytesBase64", "directory", "name", "operation", "schemaVersion"],
      ["directory", "name", "operation", "schemaVersion"],
    ],
  );
  assert.equal(
    Buffer.from(requests[0].fileBase64, "base64").toString("utf8"),
    source,
  );
  assert.deepEqual(requests[1].directory, directory);
  assert.equal(requests[2].bytesBase64, Buffer.from("fictional-new").toString("base64"));
  assert.deepEqual(
    requests.map(({ operation }) => operation),
    ["read-source", "read-private", "write-new-private", "replace-private", "remove-private"],
  );
  assert.equal(contexts.every((context) => context.signal === signal), true);
});

test("source bounds and private direct-child names fail before helper invocation", async () => {
  let invocations = 0;
  const port = createTestCodexCredentialFilePort({
    async invoke(request) {
      invocations += 1;
      return request.operation.startsWith("read-") ? ok("x") : ok();
    },
  });
  const signal = AbortSignal.timeout(30_000);
  const directory = Object.freeze({ path: "D:\\fictional", device: "1", inode: "2" });

  for (const maximumBytes of [0, 65_537, 1.5, Number.NaN]) {
    await assert.rejects(
      port.readSource({ file: "D:\\fictional\\auth.json", maximumBytes, signal }),
      { code: "CODEX_CREDENTIAL_FILE_OPERATION_FAILED" },
    );
  }
  for (const maximumBytes of [1, 65_536]) {
    assert.deepEqual(
      await port.readSource({
        file: "D:\\fictional\\auth.json",
        maximumBytes,
        signal,
      }),
      Buffer.from("x"),
    );
  }

  for (const name of [
    "",
    ".",
    "..",
    "../state.json",
    "folder/state.json",
    "folder\\state.json",
    "state.json:stream",
    " state.json",
    `${"a".repeat(129)}.json`,
    "state\u0000.json",
  ]) {
    await assert.rejects(
      port.removePrivate({ directory, name, signal }),
      { code: "CODEX_CREDENTIAL_FILE_OPERATION_FAILED" },
      name,
    );
  }
  await port.removePrivate({ directory, name: "a".repeat(128), signal });
  assert.equal(invocations, 3);
});

test("generic private payloads enforce the raw 192 KiB boundary before invocation", async () => {
  const requests = [];
  const port = createTestCodexCredentialFilePort({
    async invoke(request) {
      requests.push(request);
      return request.operation === "read-private" ? ok("x") : ok();
    },
  });
  const directory = Object.freeze({ path: "D:\\fictional", device: "1", inode: "2" });
  const signal = AbortSignal.timeout(30_000);
  const maximumPayload = Buffer.alloc(PRIVATE_FILE_LIMIT, 0x61);

  assert.deepEqual(
    await port.readPrivate({
      directory,
      name: "state.json",
      maximumBytes: PRIVATE_FILE_LIMIT,
      required: true,
      signal,
    }),
    Buffer.from("x"),
  );
  await port.writeNewPrivate({
    directory,
    name: "auth.json",
    bytes: maximumPayload,
    signal,
  });
  await port.replacePrivate({
    directory,
    name: "state.json",
    bytes: maximumPayload,
    signal,
  });

  for (const maximumBytes of [0, PRIVATE_FILE_LIMIT + 1]) {
    await assert.rejects(
      port.readPrivate({
        directory,
        name: "state.json",
        maximumBytes,
        required: true,
        signal,
      }),
      { code: "CODEX_CREDENTIAL_FILE_OPERATION_FAILED" },
    );
  }
  for (const operation of ["writeNewPrivate", "replacePrivate"]) {
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(PRIVATE_FILE_LIMIT + 1, 0x62)]) {
      await assert.rejects(
        port[operation]({
          directory,
          name: "state.json",
          bytes,
          signal,
        }),
        { code: "CODEX_CREDENTIAL_FILE_OPERATION_FAILED" },
        operation,
      );
    }
  }
  assert.equal(requests.length, 3);
});

test("production transport carries 192 KiB private files within 384 KiB packets", async () => {
  const payload = Buffer.alloc(PRIVATE_FILE_LIMIT, 0x65);
  const directory = Object.freeze({
    path: "D:\\fictional-private-envelope",
    device: "17",
    inode: "29",
  });
  const signal = AbortSignal.timeout(30_000);
  const writer = createControlledProcessPort(
    "process.stdin.resume();process.stdin.once('end',()=>process.stdout.write('{\"schemaVersion\":1,\"status\":\"ok\"}'));",
  );
  await writer.port.writeNewPrivate({
    directory,
    name: "state.json",
    bytes: payload,
    signal,
  });
  assert.equal(writer.capture.stdin.length > 192 * 1024, true);
  assert.equal(writer.capture.stdin.length <= PACKET_LIMIT, true);
  assert.deepEqual(
    Buffer.from(JSON.parse(writer.capture.stdin.toString("utf8")).bytesBase64, "base64"),
    payload,
  );

  const responseScript = `process.stdin.resume();process.stdin.once("end",()=>process.stdout.write(JSON.stringify({schemaVersion:1,status:"ok",bytesBase64:Buffer.alloc(${PRIVATE_FILE_LIMIT},0x65).toString("base64")})));`;
  const reader = createControlledProcessPort(responseScript);
  assert.deepEqual(
    await reader.port.readPrivate({
      directory,
      name: "state.json",
      maximumBytes: PRIVATE_FILE_LIMIT,
      required: true,
      signal,
    }),
    payload,
  );
});

test("production transport uses fixed spawn metadata and bounded stdin", async () => {
  const source = "D:\\FICTIONAL_PROCESS_PRIVATE\\auth.json";
  const response = JSON.stringify({
    schemaVersion: 1,
    status: "ok",
    bytesBase64: Buffer.from("fictional-process-ok").toString("base64"),
  });
  const script = `process.stdin.resume();process.stdin.once("end",()=>process.stdout.write(${JSON.stringify(response)}));`;
  const { capture, port } = createControlledProcessPort(script);
  const signal = AbortSignal.timeout(30_000);

  assert.deepEqual(
    await port.readSource({ file: source, maximumBytes: CREDENTIAL_LIMIT, signal }),
    Buffer.from("fictional-process-ok"),
  );
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  assert.equal(
    capture.executable,
    path.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
  );
  assert.deepEqual(capture.args, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.resolve("src/lib/windows-codex-credential-helper.ps1"),
  ]);
  assert.deepEqual(capture.env, { SystemRoot: systemRoot, WINDIR: systemRoot });
  assert.equal(capture.options.windowsHide, true);
  assert.deepEqual(capture.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(capture.options.signal, signal);
  assert.equal(JSON.stringify([capture.args, capture.env]).includes(source), false);
  assert.deepEqual(JSON.parse(capture.stdin.toString("utf8")), {
    schemaVersion: 1,
    operation: "read-source",
    fileBase64: Buffer.from(source).toString("base64"),
    maximumBytes: CREDENTIAL_LIMIT,
  });
});

test("production transport rejects oversized requests before spawning", async () => {
  let spawnCount = 0;
  const marker = "FICTIONAL_OVERSIZED_PACKET_PRIVATE";
  const port = createTestCodexCredentialFilePort({
    spawnProcess() {
      spawnCount += 1;
      throw new Error("must not spawn");
    },
  });
  const pathPrefix = `D:\\${marker}\\`;
  const directory = Object.freeze({
    path: pathPrefix + "\u0001".repeat(32_767 - pathPrefix.length),
    device: "1",
    inode: "2",
  });
  await assert.rejects(
    port.writeNewPrivate({
      directory,
      name: "state.json",
      bytes: Buffer.alloc(PRIVATE_FILE_LIMIT, 0x70),
      signal: AbortSignal.timeout(30_000),
    }),
    (error) => isRedactedFailure(
      error,
      "CODEX_CREDENTIAL_FILE_OPERATION_FAILED",
      [marker, process.cwd()],
    ),
  );
  assert.equal(spawnCount, 0);
});

test("production transport bounds output streams and rejects nonzero exits", async (t) => {
  const marker = "FICTIONAL_PROCESS_OUTPUT_PRIVATE";
  const cases = [
    {
      name: "stdout exceeds 384 KiB",
      script: `process.stdin.resume();process.stdin.once("end",()=>{process.stdout.write("${marker}"+"x".repeat(${PACKET_LIMIT}));setInterval(()=>{},1000);});`,
    },
    {
      name: "stderr exceeds 4,096 bytes",
      script: `process.stdin.resume();process.stdin.once("end",()=>{process.stderr.write("${marker}"+"x".repeat(4096));setInterval(()=>{},1000);});`,
    },
    {
      name: "nonzero exit rejects otherwise valid stdout",
      script: `process.stdin.resume();process.stdin.once("end",()=>{process.stdout.write('{"schemaVersion":1,"status":"missing"}');process.exitCode=7;});`,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const { capture, port } = createControlledProcessPort(fixture.script);
      await assert.rejects(
        port.readSource({
          file: "D:\\fictional\\auth.json",
          maximumBytes: CREDENTIAL_LIMIT,
          signal: AbortSignal.timeout(30_000),
        }),
        (error) => isRedactedFailure(
          error,
          "CODEX_CREDENTIAL_FILE_OPERATION_FAILED",
          [marker],
        ),
      );
      assert.equal(capture.closed, true);
    });
  }
});

test("production abort kills and reaps the controlled helper before rejecting", async () => {
  const marker = "FICTIONAL_PROCESS_ABORT_PRIVATE";
  const script = "process.stdin.resume();process.stdin.once('end',()=>setInterval(()=>{},1000));";
  const { capture, port, spawned } = createControlledProcessPort(script);
  const controller = new AbortController();
  const pending = port.readSource({
    file: `D:\\${marker}\\auth.json`,
    maximumBytes: CREDENTIAL_LIMIT,
    signal: controller.signal,
  });
  await spawned;
  controller.abort(new Error(marker));
  await assert.rejects(
    pending,
    (error) => isRedactedFailure(error, "ABORT_ERR", [marker]),
  );
  assert.equal(capture.killCount > 0, true);
  assert.equal(capture.closed, true);
});

test("public errors have constant path-free stacks", async () => {
  const marker = "FICTIONAL_CALLER_PATH_PRIVATE";
  const port = createTestCodexCredentialFilePort({
    async invoke() {
      throw new Error(marker);
    },
  });
  await assert.rejects(
    port.readSource({
      file: `D:\\${marker}\\auth.json`,
      maximumBytes: CREDENTIAL_LIMIT,
      signal: AbortSignal.timeout(30_000),
    }),
    (error) => {
      assert.equal(error.stack, "Error: Codex credential file operation failed");
      return isRedactedFailure(
        error,
        "CODEX_CREDENTIAL_FILE_OPERATION_FAILED",
        [marker, process.cwd(), "windows-codex-credential-file.js"],
      );
    },
  );
});

test("helper responses require exact keys and canonical bounded Base64", async () => {
  const marker = "FICTIONAL_PRIVATE_RESPONSE_MARKER";
  const invalidResponses = [
    null,
    "not-json",
    { schemaVersion: 2, status: "ok", bytesBase64: "eA==" },
    { schemaVersion: 1, status: "unknown", bytesBase64: "eA==" },
    { schemaVersion: 1, status: "ok", bytesBase64: "not-base64" },
    { schemaVersion: 1, status: "ok", bytesBase64: "eA" },
    { schemaVersion: 1, status: "ok", bytesBase64: "" },
    { schemaVersion: 1, status: "ok", bytesBase64: "eA==", extra: marker },
    "x".repeat(PACKET_LIMIT + 1),
  ];
  const signal = AbortSignal.timeout(30_000);

  for (const response of invalidResponses) {
    const port = createTestCodexCredentialFilePort({
      async invoke() { return response; },
    });
    await assert.rejects(
      port.readSource({
        file: "D:\\fictional\\auth.json",
        maximumBytes: 65_536,
        signal,
      }),
      (error) => isRedactedFailure(
        error,
        "CODEX_CREDENTIAL_FILE_OPERATION_FAILED",
        [marker],
      ),
    );
  }
});

test("transport failures, oversized stderr, and nonzero exits are generically redacted", async () => {
  const credentialMarker = "FICTIONAL_CREDENTIAL_MATERIAL_NEVER_PUBLIC";
  const privatePathMarker = "D:\\fictional-private-marker\\state.json";
  const failures = [
    Object.assign(new Error(credentialMarker), { exitCode: 7 }),
    Object.assign(new Error(privatePathMarker), {
      stderr: `${credentialMarker}${"x".repeat(4_097)}`,
    }),
    Object.assign(new Error("malformed helper output"), {
      stdout: JSON.stringify({ marker: credentialMarker }).repeat(PACKET_LIMIT),
    }),
  ];

  for (const failure of failures) {
    const port = createTestCodexCredentialFilePort({
      async invoke() { throw failure; },
    });
    await assert.rejects(
      port.readSource({
        file: privatePathMarker,
        maximumBytes: 65_536,
        signal: AbortSignal.timeout(30_000),
      }),
      (error) => isRedactedFailure(
        error,
        "CODEX_CREDENTIAL_FILE_OPERATION_FAILED",
        [credentialMarker, privatePathMarker],
      ),
    );
  }
});

test("missing and unsafe source states remain distinguishable without private details", async () => {
  const marker = "FICTIONAL_SOURCE_PRIVATE_MARKER";
  for (const [response, expectedCode] of [
    [{ schemaVersion: 1, status: "missing" }, "ENOENT"],
    [{ schemaVersion: 1, status: "source-unsafe" }, "CODEX_CREDENTIAL_SOURCE_UNSAFE"],
  ]) {
    const port = createTestCodexCredentialFilePort({
      async invoke() { return response; },
    });
    await assert.rejects(
      port.readSource({
        file: `D:\\${marker}\\auth.json`,
        maximumBytes: 65_536,
        signal: AbortSignal.timeout(30_000),
      }),
      (error) => isRedactedFailure(error, expectedCode, [marker]),
    );
  }

  const optional = createTestCodexCredentialFilePort({
    async invoke() { return { schemaVersion: 1, status: "missing" }; },
  });
  assert.equal(
    await optional.readPrivate({
      directory: Object.freeze({ path: "D:\\fictional", device: "1", inode: "2" }),
      name: "state.json",
      maximumBytes: 65_536,
      required: false,
      signal: AbortSignal.timeout(30_000),
    }),
    null,
  );
});

test("aborts cancel invocation and never retain an abort reason", async () => {
  const marker = "FICTIONAL_ABORT_PRIVATE_MARKER";
  const beforeStart = new AbortController();
  beforeStart.abort(new Error(marker));
  let invoked = false;
  const port = createTestCodexCredentialFilePort({
    async invoke(_request, { signal }) {
      invoked = true;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });

  await assert.rejects(
    port.readSource({
      file: "D:\\fictional\\auth.json",
      maximumBytes: 65_536,
      signal: beforeStart.signal,
    }),
    (error) => isRedactedFailure(error, "ABORT_ERR", [marker]),
  );
  assert.equal(invoked, false);

  const inFlight = new AbortController();
  const pending = port.readSource({
    file: "D:\\fictional\\auth.json",
    maximumBytes: 65_536,
    signal: inFlight.signal,
  });
  inFlight.abort(new Error(marker));
  await assert.rejects(
    pending,
    (error) => isRedactedFailure(error, "ABORT_ERR", [marker]),
  );
});

test("wrong-owner fixtures skip only explicitly recognized privilege denials", () => {
  assert.equal(ownerFixturePrivilegeDenied({
    status: 1,
    stdout: "",
    stderr: "FullyQualifiedErrorId : UnauthorizedAccessException",
  }), true);
  assert.equal(ownerFixturePrivilegeDenied({
    status: 1,
    stdout: "",
    stderr: "A required privilege is not held by the client",
  }), true);
  assert.equal(ownerFixturePrivilegeDenied({
    status: 1,
    stdout: "",
    stderr: "The security identifier is not allowed to be the owner of t_x000D__x000A_</S><S S=\"Error\">his object.",
  }), true);
  for (const result of [
    { status: 1, stdout: "", stderr: "ParserError: unexpected token" },
    { status: 1, stdout: "", stderr: "TypeNotFound: broken fixture API" },
    { status: null, error: new Error("fixture timed out"), stdout: "", stderr: "" },
  ]) {
    assert.equal(ownerFixturePrivilegeDenied(result), false);
  }
});

test("Windows source admission is handle-bound across size, link, owner, ACL, and replacement cases", {
  skip: WINDOWS_NATIVE_SUPPORTED ? false : "requires Windows x64 native file-security APIs",
}, async (t) => {
  const root = await makeNativeRoot(t, "source");
  protectFixtureDirectory(root, { inheritedWorldRead: true });
  const port = createProductionCodexCredentialFilePort();
  const signal = AbortSignal.timeout(120_000);
  const normal = path.join(root, "normal.json");
  const maximum = path.join(root, "maximum.json");
  await writeFile(normal, Buffer.from("fictional-normal-auth"));
  await writeFile(maximum, Buffer.alloc(CREDENTIAL_LIMIT, 0x6d));

  assert.deepEqual(
    await port.readSource({ file: normal, maximumBytes: 65_536, signal }),
    Buffer.from("fictional-normal-auth"),
  );
  assert.deepEqual(
    await port.readSource({ file: maximum, maximumBytes: CREDENTIAL_LIMIT, signal }),
    Buffer.alloc(CREDENTIAL_LIMIT, 0x6d),
  );
  await assert.rejects(
    port.readSource({
      file: path.join(root, "missing.json"),
      maximumBytes: 65_536,
      signal,
    }),
    { code: "ENOENT" },
  );
  await assert.rejects(
    port.readSource({
      file: path.join(root, "missing-parent", "auth.json"),
      maximumBytes: 65_536,
      signal,
    }),
    { code: "ENOENT" },
  );

  const empty = path.join(root, "empty.json");
  const oversized = path.join(root, "oversized.json");
  const hardlinkSource = path.join(root, "hardlink-source.json");
  const hardlinkAlias = path.join(root, "hardlink-alias.json");
  const dangerous = path.join(root, "dangerous-write-ace.json");
  await writeFile(empty, Buffer.alloc(0));
  await writeFile(oversized, Buffer.alloc(65_537, 1));
  await writeFile(hardlinkSource, Buffer.from("fictional-hardlink"));
  await link(hardlinkSource, hardlinkAlias);
  await writeFile(dangerous, Buffer.from("fictional-dangerous-acl"));
  addWorldWriteAce(dangerous);

  for (const fixture of [
    { name: "empty", file: empty },
    { name: "oversized", file: oversized },
    { name: "hardlink", file: hardlinkAlias },
    { name: "dangerous-write-ace", file: dangerous },
  ]) {
    await assert.rejects(
      port.readSource({ file: fixture.file, maximumBytes: 65_536, signal }),
      (error) => error?.code === "CODEX_CREDENTIAL_SOURCE_UNSAFE",
      fixture.name,
    );
  }

  await t.test("rejects a symbolic-link source when link creation is available", async (t) => {
    const symbolic = path.join(root, "symbolic.json");
    try {
      await symlink(normal, symbolic, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
        t.skip(`Windows symbolic-link fixture capability unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      port.readSource({ file: symbolic, maximumBytes: 65_536, signal }),
      { code: "CODEX_CREDENTIAL_SOURCE_UNSAFE" },
    );
  });

  await t.test("rejects a wrong-owner source when owner reassignment is available", async (t) => {
    const wrongOwner = path.join(root, "wrong-owner.json");
    await writeFile(wrongOwner, Buffer.from("fictional-wrong-owner"));
    const ownership = trySetAdministratorsOwner(wrongOwner);
    if (ownership.status !== 0) {
      assert.equal(
        ownerFixturePrivilegeDenied(ownership),
        true,
        `wrong-owner fixture failed for a non-privilege reason: ${[
          ownership.error?.message,
          ownership.stdout,
          ownership.stderr,
        ].filter(Boolean).join("\n")}`,
      );
      t.skip("Windows wrong-owner fixture capability unavailable: Set-Acl owner reassignment denied");
      return;
    }
    await assert.rejects(
      port.readSource({ file: wrongOwner, maximumBytes: 65_536, signal }),
      { code: "CODEX_CREDENTIAL_SOURCE_UNSAFE" },
    );
  });

  await t.test("a racing replacement never yields mixed or unverified bytes", async () => {
    const racing = path.join(root, "racing.json");
    const spare = path.join(root, "racing-spare.json");
    const holding = path.join(root, "racing-holding.json");
    const generationA = Buffer.alloc(65_536, 0x41);
    const generationB = Buffer.alloc(65_536, 0x42);
    await writeFile(racing, generationA);
    await writeFile(spare, generationB);
    let running = true;
    const racer = (async () => {
      while (running) {
        try {
          await rename(racing, holding);
          await rename(spare, racing);
          await rename(holding, spare);
        } catch (error) {
          if (!["EPERM", "EACCES", "EBUSY", "ENOENT"].includes(error?.code)) throw error;
        }
      }
    })();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        port.readSource({ file: racing, maximumBytes: 65_536, signal })),
    );
    running = false;
    await racer;
    for (const result of results) {
      if (result.status === "rejected") {
        assert.equal(
          ["ENOENT", "CODEX_CREDENTIAL_SOURCE_UNSAFE"].includes(result.reason?.code),
          true,
        );
        continue;
      }
      assert.equal(
        result.value.equals(generationA) || result.value.equals(generationB),
        true,
      );
    }
  });
});

test("Windows private ACL admission permits only user, SYSTEM, and Administrators", {
  skip: WINDOWS_NATIVE_SUPPORTED ? false : "requires Windows x64 native file-security APIs",
}, async (t) => {
  const root = await makeNativeRoot(t, "private-acl");
  const directory = await frozenDirectory(root);
  const port = createProductionCodexCredentialFilePort();
  const signal = AbortSignal.timeout(120_000);

  for (const right of [
    "ReadData",
    "Traverse",
    "DeleteSubdirectoriesAndFiles",
    "WriteData",
    "Delete",
    "ChangePermissions",
    "TakeOwnership",
  ]) {
    addWorldAllowAce(root, right);
    await assert.rejects(
      port.readPrivate({
        directory,
        name: "missing.json",
        maximumBytes: CREDENTIAL_LIMIT,
        required: false,
        signal,
      }),
      { code: "CODEX_CREDENTIAL_FILE_OPERATION_FAILED" },
      `private directory admitted World ${right}`,
    );
    protectFixtureDirectory(root);
  }

  await port.writeNewPrivate({
    directory,
    name: "state.json",
    bytes: Buffer.from("fictional-private-acl"),
    signal,
  });
  addWorldAllowAce(path.join(root, "state.json"), "ReadData");
  await assert.rejects(
    port.readPrivate({
      directory,
      name: "state.json",
      maximumBytes: CREDENTIAL_LIMIT,
      required: true,
      signal,
    }),
    { code: "CODEX_CREDENTIAL_FILE_OPERATION_FAILED" },
    "private file admitted World ReadData",
  );
});

test("native PowerShell enforces 192 KiB private and 384 KiB packet bounds", {
  skip: WINDOWS_NATIVE_SUPPORTED ? false : "requires Windows x64 native file-security APIs",
}, async (t) => {
  const root = await makeNativeRoot(t, "native-bounds");
  const directory = await frozenDirectory(root);
  const oversized = Buffer.alloc(PRIVATE_FILE_LIMIT + 1, 0x62);
  const oversizedRead = path.join(root, "oversized-read.json");
  await writeFile(oversizedRead, oversized);

  await t.test("accepts a 192 KiB private file through normal PowerShell packets", async () => {
    const maximum = Buffer.alloc(PRIVATE_FILE_LIMIT, 0x61);
    assert.deepEqual(invokeNativeHelper({
      schemaVersion: 1,
      operation: "write-new-private",
      directory,
      name: "maximum.json",
      bytesBase64: maximum.toString("base64"),
    }), { schemaVersion: 1, status: "ok" });
    const response = invokeNativeHelper({
      schemaVersion: 1,
      operation: "read-private",
      directory,
      name: "maximum.json",
      maximumBytes: PRIVATE_FILE_LIMIT,
      required: true,
    });
    assert.equal(response.status, "ok");
    assert.deepEqual(Buffer.from(response.bytesBase64, "base64"), maximum);
  });

  await t.test("replace-private accepts exactly 192 KiB through the normal PowerShell selector", async () => {
    const name = "maximum-replacement.json";
    assert.deepEqual(invokeNativeHelper({
      schemaVersion: 1,
      operation: "write-new-private",
      directory,
      name,
      bytesBase64: Buffer.from("fictional-before-maximum-replacement").toString("base64"),
    }), { schemaVersion: 1, status: "ok" });

    const maximum = Buffer.alloc(PRIVATE_FILE_LIMIT, 0x63);
    assert.deepEqual(invokeNativeHelper({
      schemaVersion: 1,
      operation: "replace-private",
      directory,
      name,
      bytesBase64: maximum.toString("base64"),
    }), { schemaVersion: 1, status: "ok" });
    assert.deepEqual(await readFile(path.join(root, name)), maximum);
  });

  await t.test("read-private rejects a maximum above the private-file limit", () => {
    assert.deepEqual(invokeNativeHelper({
      schemaVersion: 1,
      operation: "read-private",
      directory,
      name: "oversized-read.json",
      maximumBytes: PRIVATE_FILE_LIMIT + 1,
      required: true,
    }), { schemaVersion: 1, status: "failed" });
  });

  await t.test("write-new-private rejects zero raw bytes", async () => {
    const target = path.join(root, "empty-new.json");
    assert.deepEqual(invokeNativeHelper({
      schemaVersion: 1,
      operation: "write-new-private",
      directory,
      name: "empty-new.json",
      bytesBase64: "",
    }), { schemaVersion: 1, status: "failed" });
    await assert.rejects(lstat(target), { code: "ENOENT" });
  });

  await t.test("write-new-private rejects oversized raw bytes", async () => {
    const target = path.join(root, "oversized-new.json");
    assert.deepEqual(invokeNativeHelper({
      schemaVersion: 1,
      operation: "write-new-private",
      directory,
      name: "oversized-new.json",
      bytesBase64: oversized.toString("base64"),
    }), { schemaVersion: 1, status: "failed" });
    await assert.rejects(lstat(target), { code: "ENOENT" });
  });

  await t.test("replace-private rejects oversized raw bytes without mutation", async () => {
    const state = path.join(root, "state.json");
    const initial = Buffer.from("fictional-before-oversized-replace");
    await writeFile(state, initial);
    assert.deepEqual(invokeNativeHelper({
      schemaVersion: 1,
      operation: "replace-private",
      directory,
      name: "state.json",
      bytesBase64: oversized.toString("base64"),
    }), { schemaVersion: 1, status: "failed" });
    assert.deepEqual(await readFile(state), initial);
  });

  await t.test("request packets above 384 KiB are rejected before parsing", () => {
    const missing = path.join(root, "packet-cap-missing.json");
    const request = JSON.stringify({
      schemaVersion: 1,
      operation: "read-source",
      fileBase64: Buffer.from(missing).toString("base64"),
      maximumBytes: CREDENTIAL_LIMIT,
    });
    const packet = request + " ".repeat(PACKET_LIMIT + 1 - Buffer.byteLength(request));
    assert.deepEqual(invokeNativeHelper(packet), { schemaVersion: 1, status: "failed" });
  });
});

test("native C# independently separates credential and private-file bounds", {
  skip: WINDOWS_NATIVE_SUPPORTED ? false : "requires Windows x64 native file-security APIs",
}, async (t) => {
  const root = await makeNativeRoot(t, "native-independent-bounds");
  const directory = await frozenDirectory(root);
  const helperPath = await makeNativeBoundHarness(root);

  await t.test("ReadPrivate accepts 192 KiB and rejects the next byte", async () => {
    const maximum = Buffer.alloc(PRIVATE_FILE_LIMIT, 0x75);
    const maximumName = "private-maximum.json";
    await writeFile(path.join(root, maximumName), maximum);
    const accepted = invokeNativeHelper({
      schemaVersion: 1,
      operation: "read-private",
      directory,
      name: maximumName,
      maximumBytes: PRIVATE_FILE_LIMIT,
      required: true,
    }, helperPath);
    assert.equal(accepted.status, "ok");
    assert.deepEqual(Buffer.from(accepted.bytesBase64, "base64"), maximum);

    const privateMarker = "fictional-native-over-limit-private-marker";
    const oversized = Buffer.alloc(PRIVATE_FILE_LIMIT + 1, 0x78);
    oversized.set(Buffer.from(privateMarker));
    const oversizedName = "private-over-limit.json";
    const oversizedPath = path.join(root, oversizedName);
    await writeFile(oversizedPath, oversized);
    const rejected = invokeNativeHelper({
      schemaVersion: 1,
      operation: "read-private",
      directory,
      name: oversizedName,
      maximumBytes: PRIVATE_FILE_LIMIT + 1,
      required: true,
    }, helperPath);
    assert.deepEqual(rejected, { schemaVersion: 1, status: "failed" });
    const serialized = JSON.stringify(rejected);
    assert.equal(serialized.includes(privateMarker), false);
    assert.equal(serialized.includes(oversizedPath), false);
  });

  await t.test("ReadSource remains independently capped at 65,536 bytes", async () => {
    const maximum = Buffer.alloc(CREDENTIAL_LIMIT, 0x73);
    const maximumPath = path.join(root, "source-maximum.json");
    await writeFile(maximumPath, maximum);
    const accepted = invokeNativeHelper({
      schemaVersion: 1,
      operation: "read-source",
      fileBase64: Buffer.from(maximumPath).toString("base64"),
      maximumBytes: CREDENTIAL_LIMIT,
    }, helperPath);
    assert.equal(accepted.status, "ok");
    assert.deepEqual(Buffer.from(accepted.bytesBase64, "base64"), maximum);

    const oversizedPath = path.join(root, "source-over-limit.json");
    await writeFile(oversizedPath, Buffer.alloc(CREDENTIAL_LIMIT + 1, 0x74));
    const rejected = invokeNativeHelper({
      schemaVersion: 1,
      operation: "read-source",
      fileBase64: Buffer.from(oversizedPath).toString("base64"),
      maximumBytes: CREDENTIAL_LIMIT + 1,
    }, helperPath);
    assert.equal(rejected.status, "source-unsafe");
    assert.deepEqual(Object.keys(rejected).sort(), ["schemaVersion", "status"]);
  });

  await t.test("private writes accept 192 KiB and reject the next byte", async () => {
    const maximum = Buffer.alloc(PRIVATE_FILE_LIMIT, 0x77);
    const oversized = Buffer.alloc(PRIVATE_FILE_LIMIT + 1, 0x78);
    assert.deepEqual(invokeNativeHelper({
      schemaVersion: 1,
      operation: "write-new-private",
      directory,
      name: "new-maximum.json",
      bytesBase64: maximum.toString("base64"),
    }, helperPath), { schemaVersion: 1, status: "ok" });
    assert.deepEqual(await readFile(path.join(root, "new-maximum.json")), maximum);
    assert.deepEqual(invokeNativeHelper({
      schemaVersion: 1,
      operation: "write-new-private",
      directory,
      name: "new-over-limit.json",
      bytesBase64: oversized.toString("base64"),
    }, helperPath), { schemaVersion: 1, status: "failed" });
    await assert.rejects(lstat(path.join(root, "new-over-limit.json")), { code: "ENOENT" });

    const state = path.join(root, "replace-state.json");
    await writeFile(state, Buffer.from("fictional-before-native-bound-replace"));
    assert.deepEqual(invokeNativeHelper({
      schemaVersion: 1,
      operation: "replace-private",
      directory,
      name: "replace-state.json",
      bytesBase64: maximum.toString("base64"),
    }, helperPath), { schemaVersion: 1, status: "ok" });
    assert.deepEqual(await readFile(state), maximum);
    assert.deepEqual(invokeNativeHelper({
      schemaVersion: 1,
      operation: "replace-private",
      directory,
      name: "replace-state.json",
      bytesBase64: oversized.toString("base64"),
    }, helperPath), { schemaVersion: 1, status: "failed" });
    assert.deepEqual(await readFile(state), maximum);
  });
});

test("Windows private operations use a pinned directory and atomic verified replacement", {
  skip: WINDOWS_NATIVE_SUPPORTED ? false : "requires Windows x64 native file-security APIs",
}, async (t) => {
  const root = await makeNativeRoot(t, "private");
  const directory = await frozenDirectory(root);
  const port = createProductionCodexCredentialFilePort();
  const signal = AbortSignal.timeout(120_000);
  const state = path.join(root, "state.json");
  const staleTemporary = path.join(root, `state.tmp.123.${"a".repeat(32)}`);
  const retained = path.join(root, "retain.txt");
  const initial = Buffer.from("fictional-private-generation-one");
  const replacement = Buffer.from("fictional-private-generation-two");

  assert.equal(
    await port.readPrivate({
      directory,
      name: "state.json",
      maximumBytes: 65_536,
      required: false,
      signal,
    }),
    null,
  );
  await port.writeNewPrivate({ directory, name: "state.json", bytes: initial, signal });
  assert.deepEqual(
    await port.readPrivate({
      directory,
      name: "state.json",
      maximumBytes: 65_536,
      required: true,
      signal,
    }),
    initial,
  );
  await assert.rejects(
    port.writeNewPrivate({ directory, name: "state.json", bytes: initial, signal }),
    { code: "CODEX_CREDENTIAL_FILE_OPERATION_FAILED" },
  );

  await writeFile(staleTemporary, Buffer.from("fictional-stale-temp"));
  await writeFile(retained, Buffer.from("fictional-retained"));
  await port.replacePrivate({ directory, name: "state.json", bytes: replacement, signal });
  assert.deepEqual(await readFile(state), replacement);
  assert.equal((await readdir(root)).some((name) => name.startsWith("state.tmp.")), false);
  assert.equal(await readFile(retained, "utf8"), "fictional-retained");

  const staleIdentity = Object.freeze({
    ...directory,
    inode: (BigInt(directory.inode) + 1n).toString(),
  });
  await assert.rejects(
    port.readPrivate({
      directory: staleIdentity,
      name: "state.json",
      maximumBytes: 65_536,
      required: true,
      signal,
    }),
    { code: "CODEX_CREDENTIAL_FILE_OPERATION_FAILED" },
  );

  await port.removePrivate({ directory, name: "state.json", signal });
  await assert.rejects(lstat(state), { code: "ENOENT" });
  await port.removePrivate({ directory, name: "state.json", signal });
});

test("two replacement helpers wait on the FILE_ID_INFO and name-bound mutex", {
  skip: WINDOWS_NATIVE_SUPPORTED ? false : "requires Windows x64 native file-security APIs",
  timeout: 120_000,
}, async (t) => {
  const root = await makeNativeRoot(t, "private-mutex");
  const directory = await frozenDirectory(root);
  const name = "state.json";
  const stableIdentity = queryStableFileIdentity(root);
  const signal = AbortSignal.timeout(110_000);
  const setupPort = createProductionCodexCredentialFilePort();
  await setupPort.writeNewPrivate({
    directory,
    name,
    bytes: Buffer.from("fictional-mutex-initial"),
    signal,
  });
  const holder = startMutexHolder(mutationMutexName(stableIdentity, name));
  let released = false;
  t.after(async () => {
    if (!released) holder.release();
    await holder.close;
  });
  await holder.ready;
  const payloads = [
    Buffer.alloc(CREDENTIAL_LIMIT, 0x61),
    Buffer.alloc(CREDENTIAL_LIMIT, 0x62),
  ];
  const replacements = Promise.allSettled(payloads.map((bytes) =>
    createProductionCodexCredentialFilePort().replacePrivate({
      directory,
      name,
      bytes,
      signal,
    })));
  const settledWhileLocked = await Promise.race([
    replacements.then(() => true),
    delay(4_000, false),
  ]);
  assert.equal(settledWhileLocked, false, "replacement bypassed the identity/name lock");

  holder.release();
  released = true;
  await holder.close;
  const results = await replacements;
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
  const final = await readFile(path.join(root, name));
  assert.equal(payloads.some((bytes) => bytes.equals(final)), true);
});

test("concurrent Windows replacement helpers serialize through final verification", {
  skip: WINDOWS_NATIVE_SUPPORTED ? false : "requires Windows x64 native file-security APIs",
  timeout: 180_000,
}, async (t) => {
  const root = await makeNativeRoot(t, "private-concurrent");
  const directory = await frozenDirectory(root);
  const signal = AbortSignal.timeout(170_000);
  const setupPort = createProductionCodexCredentialFilePort();
  await setupPort.writeNewPrivate({
    directory,
    name: "state.json",
    bytes: Buffer.alloc(CREDENTIAL_LIMIT, 0x30),
    signal,
  });

  for (let round = 0; round < 2; round += 1) {
    await Promise.all(Array.from({ length: 24 }, (_, index) =>
      writeFile(
        path.join(
          root,
          `state.tmp.${1_000 + round}.${index.toString(16).padStart(32, "0")}`,
        ),
        Buffer.alloc(8 * 1024, index),
      )));
    const payloads = Array.from(
      { length: 8 },
      (_, index) => Buffer.alloc(CREDENTIAL_LIMIT, 0x41 + round * 8 + index),
    );
    const results = await Promise.allSettled(payloads.map((bytes) =>
      createProductionCodexCredentialFilePort().replacePrivate({
        directory,
        name: "state.json",
        bytes,
        signal,
      })));
    assert.deepEqual(
      results.map((result) => result.status),
      Array.from({ length: payloads.length }, () => "fulfilled"),
      `replacement round ${round + 1}`,
    );
    const final = await readFile(path.join(root, "state.json"));
    assert.equal(
      payloads.some((bytes) => bytes.equals(final)),
      true,
      `replacement round ${round + 1} left unverified bytes`,
    );
    assert.equal(
      (await readdir(root)).some((entry) => entry.startsWith("state.tmp.")),
      false,
      `replacement round ${round + 1} left temporary files`,
    );
  }
});
