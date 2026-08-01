import { createApplication } from "./composition-root.js";

async function main() {
  const [, , command, ...flags] = process.argv;
  if (command !== "refresh") {
    console.error("Usage: node src/cli.js refresh [--notify]");
    process.exitCode = 2;
    return;
  }
  const application = await createApplication({ externalActions: false });
  try {
    const result = await application.refreshService.refresh({
      notify: flags.includes("--notify"),
    });
    const routing = application.workflowRouting
      ? await application.workflowRouting.ingestSnapshot({
          snapshot: await application.store.read("snapshot"),
        })
      : null;
    console.log(
      JSON.stringify(
        {
          refreshedAt: result.dashboard.meta.refreshedAt,
          counts: result.dashboard.counts,
          errors: result.dashboard.meta.errors,
          notification: result.notification,
          routing: routing
            ? {
                events: routing.events.length,
                assignments: routing.assignments.length,
              }
            : null,
        },
        null,
        2,
      ),
    );
    if (result.dashboard.meta.errors.length) process.exitCode = 1;
  } finally {
    await application.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
