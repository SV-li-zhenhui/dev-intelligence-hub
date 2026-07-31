import { createApplication } from "./composition-root.js";

async function main() {
  const [, , command, ...flags] = process.argv;
  if (command !== "refresh") {
    console.error("Usage: node src/cli.js refresh [--notify]");
    process.exitCode = 2;
    return;
  }
  const application = await createApplication();
  const result = await application.refreshService.refresh({
    notify: flags.includes("--notify"),
  });
  console.log(
    JSON.stringify(
      {
        refreshedAt: result.dashboard.meta.refreshedAt,
        counts: result.dashboard.counts,
        errors: result.dashboard.meta.errors,
        notification: result.notification,
      },
      null,
      2,
    ),
  );
  if (result.dashboard.meta.errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
