import {
  applicationWriterGuardName,
  ProcessExclusiveGuard,
} from "./process-exclusive-guard.js";
import { projectIdentityDigest } from "./project-identity.js";

export function createApplicationWriterLease({
  projectRoot,
  projectDigest = null,
} = {}) {
  return new ProcessExclusiveGuard({
    name: applicationWriterGuardName(
      projectIdentityDigest({ projectRoot, projectDigest }),
    ),
  });
}
