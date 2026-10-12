# Native Codex execution

## Goal

Keep the existing GitHub automation, immutable PR bindings, task ledger and
controlled code execution. Add a thin Codex CLI login route that leaves
authentication and conversation storage with Codex, and document the actual
runtime boundaries. Existing installations retain their configuration.

## Implementation

1. Fix the legacy provider's preparation-failure credential fence. Release the
   shared lease only after preparation has settled, no process can still start,
   and verified cleanup succeeds. Preserve fencing for uncertain processes,
   credential publication and cleanup.
2. Add `credentialMode: "codex-native-login"` for Codex providers. Use the service
   account's startup `CODEX_HOME` or default Codex home, a serialized native
   execution route, persistent session references, and supervised CLI processes.
   Do not copy auth files or session directories. Pass task input through stdin,
   bind PR reads to the existing read-only MCP reader, validate final structured
   decisions, and keep GitHub writes under the existing publisher.
3. Expose the mode in configuration validation and the UI. Explain native versus
   legacy login, native session storage, unattended execution, diagnostics,
   migration and rollback. Correct stale claims about MCP, sessions and automatic
   authorization in the README and architecture guide.

## Verification

- Reproduce and cover the legacy pre-process failure before changing behavior;
  an independent subsequent task must run after a settled preparation failure.
- Native execution must use the original Codex home without staging credentials;
  resume the correct entity's session; serialize shared native profile access;
  handle cancellation, timeout, malformed output and unknown process termination.
- Review must still require complete change-set reading and current immutable
  source identity. No native call directly publishes a GitHub mutation.
- Validate the new mode through backend and frontend contracts; reject it for
  Claude and preserve the existing default modes.
- Run focused tests and review the integrated change. Report live verification
  separately from fixture evidence; do not claim a real PR completed from tests.

## Operational boundaries

Configuration, login state, retained conversations and task history are private.
Native mode is an explicit configuration choice, with no automatic fallback or
silent migration of historical sessions. Installing Retinue, replacing the task
ledger, changing the selected model, or granting arbitrary GitHub write access is
outside this change.
