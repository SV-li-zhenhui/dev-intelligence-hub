import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);

function functionSource(name) {
  const start = appSource.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const signatureEnd = appSource.indexOf(") {", start);
  assert.notEqual(signatureEnd, -1, `${name} must have a function body`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let index = bodyStart; index < appSource.length; index += 1) {
    if (appSource[index] === "{") depth += 1;
    if (appSource[index] === "}") depth -= 1;
    if (depth === 0) return appSource.slice(start, index + 1);
  }
  assert.fail(`${name} must have a complete function body`);
}

test("employee view loads every configured role and exposes independent controls", () => {
  assert.match(appSource, /fetch\("\/api\/employees"/);
  assert.match(appSource, /employeeRoles\.map\(employeeRoleCard\)/);
  assert.match(appSource, /data-role-control=/);
  assert.match(appSource, /data-role-run=/);
  assert.match(
    appSource,
    /\/api\/employees\/\$\{encodeURIComponent\(roleId\)\}\/control/,
  );
  assert.match(
    appSource,
    /\/api\/employees\/\$\{encodeURIComponent\(roleId\)\}\/run/,
  );
});

test("employee cards display their assigned model, mission, and permissions", () => {
  for (const value of [
    "roleBrainLabel(role)",
    "role.mission",
    "permissions.join",
    "role.lastErrorCode",
  ]) {
    assert.equal(appSource.includes(value), true, value);
  }
});

test("main loading applies dashboard and confirmations independently of the employee roster", () => {
  const loadSource = functionSource("load");
  const mainRequests = loadSource.slice(
    loadSource.indexOf("await Promise.all(["),
    loadSource.indexOf("]);", loadSource.indexOf("await Promise.all([")),
  );

  assert.match(loadSource, /void loadEmployeeRoles\(\);/);
  assert.match(mainRequests, /fetchDashboard\(\)/);
  assert.match(mainRequests, /fetchConfirmationQueue\(\)/);
  assert.doesNotMatch(mainRequests, /loadEmployeeRoles\(\)/);
  assert.ok(
    loadSource.indexOf("applyConfirmationQueue") <
      loadSource.indexOf("queueMicrotask(showNextConfirmation)"),
    "the independently fetched confirmation snapshot must be applied before opening the dialog",
  );
});

test("employee roster GETs abort predecessors and reject out-of-order responses", () => {
  const rosterSource = functionSource("loadEmployeeRoles");

  assert.match(rosterSource, /const sequence = \+\+employeeRolesRequestSequence/);
  assert.match(rosterSource, /employeeRolesAbortController\?\.abort\(\)/);
  assert.match(rosterSource, /const controller = new AbortController\(\)/);
  assert.match(rosterSource, /signal: controller\.signal/);
  assert.match(rosterSource, /sequence !== employeeRolesRequestSequence/);
  assert.match(rosterSource, /sequence < lastAppliedEmployeeRolesRequest/);
  assert.match(rosterSource, /lastAppliedEmployeeRolesRequest = sequence/);
});

test("aborted roster requests stay silent while real failures remain local to the employee view", () => {
  const rosterSource = functionSource("loadEmployeeRoles");
  const abortGuard = rosterSource.indexOf('error?.name === "AbortError"');
  const errorAssignment = rosterSource.indexOf("employeeRolesError = error.message");

  assert.notEqual(abortGuard, -1);
  assert.ok(abortGuard < errorAssignment, "abort exits before recording an error");
  assert.doesNotMatch(rosterSource, /statusBanner/);
  assert.match(appSource, /其他指挥功能不受影响/);
});

test("employee mutations refresh the roster without delaying confirmation refresh", () => {
  for (const name of ["handleEmployeeRun", "handleRoleRun"]) {
    const source = functionSource(name);
    assert.match(source, /void loadEmployeeRoles\(\);/);
    assert.doesNotMatch(source, /Promise\.all\([\s\S]*loadEmployeeRoles/);
    assert.ok(
      source.indexOf("void loadEmployeeRoles()") <
        source.indexOf("await refreshConfirmationQueue"),
      `${name} must start its best-effort roster refresh before awaiting confirmations`,
    );
  }
});
