import { applyTestRunnerResult, runTestSuite } from "./run-test-suite.mjs";

const testDirectory = process.argv[2];
applyTestRunnerResult(await runTestSuite({ testDirectory }));
