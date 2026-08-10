import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import test from "node:test";

test("holds the owned process chain open", async () => {
  const child = spawn(
    process.execPath,
    [process.env.SCHEDULER_GRANDCHILD_PATH],
    { stdio: ["pipe", "pipe", "inherit"], windowsHide: true },
  );
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", resolve);
  });
  writeFileSync(
    process.env.SCHEDULER_READY_PATH,
    JSON.stringify({
      runnerPid: process.ppid,
      workerPid: process.pid,
      grandchildPid: child.pid,
    }),
  );
  await new Promise(() => {});
});
