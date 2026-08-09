import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import {
  buildUiArtifactReceipt,
  parseUiValidationCommandArguments,
  prepareUiArtifactDirectory,
  writeUiArtifactReceipt,
} from "../scripts/system-ui-artifact-receipt.mjs";
import { verifyLiveDashboard } from "../scripts/system-live-validation.mjs";

const scenarios = [
  "desktop-1440",
  "mobile-390",
  "confirmation-queue",
  "code-job-control-package-desktop-1100",
  "code-job-control-package-mobile-390",
  "external-review-confirmation",
  "system-status-initial-error",
  "system-status-stale-error",
  "system-status-stale-success",
];

function crc32(contents) {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(
    crc32(Buffer.concat([typeBytes, data])),
    8 + data.length,
  );
  return result;
}

function png(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height))),
    chunk("IEND"),
  ]);
}

const { outputDirectory, runId, liveService } =
  parseUiValidationCommandArguments(process.argv.slice(2));
const preparedOutput = await prepareUiArtifactDirectory({
  root: process.cwd(),
  runId,
});
assert.equal(preparedOutput.relativeDirectory, outputDirectory);
await verifyLiveDashboard({
  baseUrl: "http://127.0.0.1:4173",
  expectedRuntimeSource: liveService.runtimeSource,
  expectedLiveService: liveService,
});
const absoluteOutput = preparedOutput.directory;
const results = {
  schemaVersion: 1,
  runId,
  status: "passed",
  liveService,
  scenarios: scenarios.map((name) => ({
    name,
    status: "passed",
    consoleErrors: 0,
    pageErrors: 0,
    horizontalOverflow: false,
    accessibilityFailures: 0,
  })),
  details: scenarios.map((name) => ({ name })),
};
await writeFile(
  path.join(absoluteOutput, "results.json"),
  `${JSON.stringify(results, null, 2)}\n`,
  { flag: "wx" },
);
await writeFile(
  path.join(absoluteOutput, "desktop-1440.png"),
  png(1440, 1000),
  { flag: "wx" },
);
await writeFile(
  path.join(absoluteOutput, "mobile-390.png"),
  png(390, 844),
  { flag: "wx" },
);
const receipt = await buildUiArtifactReceipt({
  root: process.cwd(),
  runId,
  liveService,
  completedAt: new Date().toISOString(),
});
await verifyLiveDashboard({
  baseUrl: "http://127.0.0.1:4173",
  expectedRuntimeSource: liveService.runtimeSource,
  expectedLiveService: liveService,
});
const envelope = await writeUiArtifactReceipt({
  root: process.cwd(),
  receipt,
});
process.stdout.write(`${JSON.stringify(envelope)}\n`);
