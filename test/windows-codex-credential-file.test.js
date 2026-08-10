import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import test from "node:test";

import {
  createProductionCodexCredentialFilePort,
  createTestCodexCredentialFilePort,
} from "../src/lib/windows-codex-credential-file.js";

const PACKET_LIMIT = 192 * 1024;
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

test("Windows source admission is handle-bound across size, link, owner, ACL, and replacement cases", {
  skip: WINDOWS_NATIVE_SUPPORTED ? false : "requires Windows x64 native file-security APIs",
}, async (t) => {
  const root = await makeNativeRoot(t, "source");
  protectFixtureDirectory(root, { inheritedWorldRead: true });
  const port = createProductionCodexCredentialFilePort();
  const signal = AbortSignal.timeout(120_000);
  const normal = path.join(root, "normal.json");
  await writeFile(normal, Buffer.from("fictional-normal-auth"));

  assert.deepEqual(
    await port.readSource({ file: normal, maximumBytes: 65_536, signal }),
    Buffer.from("fictional-normal-auth"),
  );
  await assert.rejects(
    port.readSource({
      file: path.join(root, "missing.json"),
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
