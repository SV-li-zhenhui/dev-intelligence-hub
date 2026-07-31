import { spawn } from "node:child_process";

export class CommandError extends Error {
  constructor(command, code, stderr) {
    super(`${command} failed with exit code ${code}: ${stderr.trim()}`);
    this.name = "CommandError";
    this.code = code;
  }
}

export function runCommand(command, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const invocation =
      process.platform === "win32" && command === "dws"
        ? {
            command: "C:\\Program Files\\nodejs\\node.exe",
            args: [
              `${process.env.APPDATA}\\npm\\node_modules\\dingtalk-workspace-cli\\bin\\dws.js`,
              ...args,
            ],
          }
        : { command, args };
    const child = spawn(invocation.command, invocation.args, {
      shell: false,
      windowsHide: true,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new CommandError(command, code, stderr));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function runJson(command, args, options) {
  const output = await runCommand(command, args, options);
  const start = Math.min(
    ...["{", "["]
      .map((character) => output.indexOf(character))
      .filter((index) => index >= 0),
  );
  if (!Number.isFinite(start)) {
    throw new Error(`${command} returned no JSON`);
  }
  return JSON.parse(output.slice(start));
}
