import path from "node:path";

import { BackupService } from "../src/services/backup-service.js";
import { OfflineRestoreActivationService } from "../src/services/offline-restore-activation-service.js";

const [activeDirectory, backupDirectory, controlDirectory, backupId, crashStage] =
  process.argv.slice(2);

if ([activeDirectory, backupDirectory, controlDirectory, backupId, crashStage].some(
  (value) => typeof value !== "string" || value.length === 0,
)) {
  process.exitCode = 64;
} else {
  const quiescence = {
    async enter() {
      throw new Error("offline restore must not enter a live checkpoint");
    },
    async leave() {},
  };
  const backupService = new BackupService({
    sourceDirectory: path.resolve(activeDirectory),
    backupDirectory: path.resolve(backupDirectory),
    quiescence,
  });
  const service = new OfflineRestoreActivationService({
    activeDirectory: path.resolve(activeDirectory),
    backupDirectory: path.resolve(backupDirectory),
    controlDirectory: path.resolve(controlDirectory),
    backupService,
    transitionObserver: {
      async observe({ stage }) {
        if (crashStage === "hold-lock" && stage === "lock-acquired") {
          process.stdout.write("LOCK_READY\n");
          await new Promise(() => {
            setInterval(() => {}, 1_000);
          });
        }
        if (stage === crashStage) process.exit(86);
      },
    },
  });
  await service.activate({ backupId });
  process.exitCode = 65;
}
