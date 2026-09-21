import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { GitCheckoutInspector } from "../src/adapters/git-checkout-inspector.js";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { workspaceRevisionFromFileHashes } from "../src/domain/workspace-revision.js";
import { ProcessExclusiveGuard } from "../src/lib/process-exclusive-guard.js";
import { StateStore } from "../src/lib/state-store.js";
import { ChangePackageApplicationService } from "../src/services/change-package-application-service.js";
import { ChangePackageStore } from "../src/services/change-package-store.js";

const execFile = promisify(execFileCallback);

function locateGit() {
  const result =
    process.platform === "win32"
      ? spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true })
      : spawnSync("which", ["git"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const candidate = result.stdout.split(/\r?\n/).find(Boolean);
  return candidate && path.isAbsolute(candidate) ? path.resolve(candidate) : null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function git(gitCommand, cwd, args) {
  await execFile(gitCommand, args, {
    cwd,
    env: process.env,
    windowsHide: true,
    timeout: 30_000,
  });
}

function envelope(plan) {
  const queued = normalizeConfirmationPlan(plan);
  return {
    schemaVersion: 1,
    id: queued.id,
    idempotencyKey: `confirmation-${queued.approvalBindingDigest}`,
    kind: queued.kind,
    requestedBy: queued.requestedBy,
    actor: queued.actor,
    target: queued.target,
    action: queued.action,
    displayedPayloadDigest: queued.displayedPayloadDigest,
    approvalBindingDigest: queued.approvalBindingDigest,
    execution: {
      requestId: "integration-application-request-0001",
      attempt: 1,
      startedAt: "2026-08-02T03:00:00.000Z",
    },
  };
}

const gitCommand = locateGit();

test(
  "applies an immutable package exactly once to a disposable Git checkout",
  { skip: gitCommand === null ? "Git is unavailable" : false },
  async (t) => {
    const base = await mkdtemp(path.join(tmpdir(), "change-package-git-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const repository = path.join(base, "repository");
    const packageRoot = path.join(base, "packages");
    const stateRoot = path.join(base, "state");
    await mkdir(path.join(repository, "src"), { recursive: true });
    const beforeApp = Buffer.from("before\n");
    const afterApp = Buffer.from("after\n");
    const oldFile = Buffer.from("old\n");
    const newFile = Buffer.from("new\n");
    const readme = Buffer.from("readme\n");
    await writeFile(path.join(repository, "src", "app.js"), beforeApp);
    await writeFile(path.join(repository, "src", "old.js"), oldFile);
    await writeFile(path.join(repository, "README.md"), readme);
    await git(gitCommand, repository, ["init"]);
    await git(gitCommand, repository, ["config", "user.name", "MyDashboard Test"]);
    await git(gitCommand, repository, [
      "config",
      "user.email",
      "mydashboard@example.invalid",
    ]);
    await git(gitCommand, repository, ["add", "--all"]);
    await git(gitCommand, repository, ["commit", "-m", "baseline"]);

    const sourceRevision = workspaceRevisionFromFileHashes([
      ["README.md", sha256(readme)],
      ["src/app.js", sha256(beforeApp)],
      ["src/old.js", sha256(oldFile)],
    ]);
    const workspaceRevision = workspaceRevisionFromFileHashes([
      ["README.md", sha256(readme)],
      ["src/app.js", sha256(afterApp)],
      ["src/new.js", sha256(newFile)],
    ]);
    const packageStore = new ChangePackageStore({ root: packageRoot });
    await packageStore.recover();
    const manifest = await packageStore.create({
      job: { id: "code-job-1", revision: 7, recordDigest: "a".repeat(64) },
      proposal: { id: "proposal-1", contentDigest: "b".repeat(64) },
      grant: { digest: "c".repeat(64) },
      workspace: { id: "workspace-1", sourceRevision, workspaceRevision },
      passedProfiles: [
        {
          id: "node-tests",
          configDigest: "d".repeat(64),
          workspaceRevision,
          actionId: "test-action",
          attemptNumber: 1,
          imageId: "sha256:test-image",
          artifacts: {
            output: { path: "evidence/output.json", sha256: "d".repeat(64), bytes: 1 },
            stdout: { path: "evidence/stdout.txt", sha256: "d".repeat(64), bytes: 1 },
            stderr: { path: "evidence/stderr.txt", sha256: "d".repeat(64), bytes: 1 },
          },
        },
      ],
      created: [{ path: "src/new.js", content: newFile }],
      modified: [
        {
          path: "src/app.js",
          beforeSha256: sha256(beforeApp),
          content: afterApp,
        },
      ],
      deleted: [{ path: "src/old.js", beforeSha256: sha256(oldFile) }],
    });
    const inspector = new GitCheckoutInspector({ gitCommand });
    const guardName = `change-package-apply-${randomUUID()}`;
    const createService = (guard) =>
      new ChangePackageApplicationService({
        packageReader: packageStore.reader(),
        trustedTargets: [
          {
            workspaceId: "workspace-1",
            sourceRoot: repository,
            targetAuthorityDigest: "e".repeat(64),
            writablePaths: ["src"],
            excludePaths: [],
          },
        ],
        gitInspector: inspector,
        store: new StateStore(stateRoot),
        exclusiveLease: guard,
        applicationAuthorityVerifier: { verify: async () => true },
        clock: () => new Date("2026-08-02T03:00:00.000Z"),
      });

    const firstGuard = new ProcessExclusiveGuard({ name: guardName });
    const service = createService(firstGuard);
    await service.recover();
    const plan = await service.prepareConfirmation({
      packageId: manifest.packageId,
      requestedBy: { roleId: "developer", workItemId: "work-1" },
    });
    assert.equal(JSON.stringify(plan).includes(path.resolve(repository)), false);
    const request = envelope(plan);
    const applied = await service.execute(request);
    assert.equal(applied.status, "applied");
    assert.equal(await readFile(path.join(repository, "src", "app.js"), "utf8"), "after\n");
    assert.equal(await readFile(path.join(repository, "src", "new.js"), "utf8"), "new\n");
    await assert.rejects(readFile(path.join(repository, "src", "old.js")), {
      code: "ENOENT",
    });
    assert.deepEqual(await inspector.inspect({ sourceRoot: repository }), {
      headOid: request.action.expectedHeadOid,
      clean: false,
    });
    await firstGuard.close();

    const secondGuard = new ProcessExclusiveGuard({ name: guardName });
    t.after(() => secondGuard.close());
    const restarted = createService(secondGuard);
    await restarted.recover();
    assert.deepEqual(await restarted.reconcile(request), {
      status: "already",
      receipt: applied.receipt,
    });
    assert.deepEqual(await restarted.execute(request), {
      status: "already",
      receipt: applied.receipt,
    });
  },
);
