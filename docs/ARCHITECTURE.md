# Architecture

MyDashboard is a single-user, local-first command center. It combines observed
engineering signals with durable work, autonomous role decisions, controlled
execution, explicit human decisions, cited memory, and recoverable operations.

## Runtime shape

```text
GitHub / DingTalk / local imports
              |
        read-only adapters
              |
      facts and immutable events
              |
   workflow router -> work ledger/graph -> role employees
                               |               |
                               |          brain router
                               |   (Ollama, HTTPS, or CLI)
                               |               |
                               +---- validated intents
                                         |
                                  policy + dispatcher
                                    /           \
                         owner confirmation   local waiting,
                          /             \      handoff, memory
                 controlled code     GitHub actions
                         \             /
                    evidence and receipts
                              |
                    memory projection/search
```

The composition root creates services and passes frozen, least-authority ports
between them. Domain modules validate bounded records; services own state
transitions; adapters isolate operating-system and remote side effects; the
server exposes safe projections rather than underlying stores.

## Durable control plane

Workflow events are routed into a persistent work ledger. Each role claims work
under a lease, assembles evidence-bound context, asks its configured brain for
one structured decision, validates that decision, and emits an intent. Policy
maps the intent to the exact authority permitted for that role and work item.
The dispatcher then records the result or hands it to a narrower execution
boundary.

The orchestrator, requirements analyst, PR engineer, developer, and tester are
independent roles. Their schedules, pause states, permissions, routine brains,
and task brains are configurable. Replacing a brain changes reasoning quality,
not authority.

### Supervised CLI brain boundary

Codex CLI and Claude CLI are remote reasoning providers behind the same brain
router and data-class admission gate as HTTPS providers. The trusted controller
remains deterministic MyDashboard code. For each admitted task revision it
locates one version-admitted official Windows x64 npm binary, creates a fresh
private invocation directory and empty profile roots, and starts one bounded
child-process tree. Claude uses only its fixed API-key environment variable.
Codex either uses the backward-compatible API-key mode or a brokered
`credentialMode: "codex-login"`; missing mode remains API-key for legacy
configurations.

The login broker derives the source only from startup `CODEX_HOME` or the
current Windows user's default Codex directory. It handle-validates the one
file login source, synchronizes an atomic private mirror outside project/data/
backup roots, and stages only the authentication file into the disposable
profile. It never mounts the full host profile or writes back to the host login
source. All login-mode providers for one service user share a FIFO lease across
source synchronization, the model process, refreshed-credential capture, and
cleanup. Login, account switch, and logout changes are therefore observed only
at a task boundary without concurrent refresh overwrite.

The child has no inherited `PATH`, host configuration beyond that isolated
authentication file, Git/GitHub/SSH environment, repository working directory,
plugin, MCP, browser, shell tool, or persistent session. The private credential
mirror is not part of backup, restore, packaging, or open-source distribution.

The vendor strategies use fixed no-authority flags and accept only bounded,
strict structured output. Output is untrusted: it returns to the existing
decision schema, policy, ledger, memory, controlled-code, and confirmation
boundaries. It cannot directly mutate a repository or GitHub. A timeout,
cancellation, malformed result, output overflow, unavailable binary, or process
reaping failure ends that attempt; the role does not ask the CLI to repair its
own response. Cross-task continuity belongs to MyDashboard's durable ledger and
memory. Persistent vendor conversations remain a deferred mode.

Owner-created work enters through a separate structured command-center
contract. The browser supplies business content only; role, node, permission,
event, assignment, and work-item identities are server-owned. A reserved
highest-priority routing rule sends this event to the orchestrator before any
ordinary configured rule can match it. The intake service durably stages the
request, binds its workflow assignment, and then binds the corresponding ledger
item. Each transition is content-addressed and restart recovery reconciles a
lost routing or ledger response instead of creating a second root task.

## Confirmation and side effects

Human-only operations enter one durable confirmation queue. A request is bound
to its revision, digest, actor, source provenance, and target identity. The UI
shows one request at a time and cannot replace server-owned payloads. Stale or
revoked requests fail closed.

Code work uses fixed semantic actions in isolated workspaces. Models never
receive a raw shell or arbitrary host path. Applying a change package,
publishing a commit, and every GitHub mutation are distinct authority and
confirmation boundaries. Git operations bind the observing account, base and
head repositories, refs, and object IDs. A changed binding invalidates derived
work.

External actions use intent, policy, dispatcher, durable receipt, and
reconciliation stages. If the process cannot prove whether a call completed,
the result becomes `unknown`; duplicate execution remains blocked until a
trusted observation resolves it.

GitHub mutations select one credential source only after authority and the
current confirmation have both been revalidated. The compatibility source,
`credentialMode: "token-env"`, resolves the configured environment-variable
name. The recommended `credentialMode: "gh-login"` source supervises a fixed
absolute GitHub CLI binary in a private temporary working directory and asks
the same operating-system user's current login for the exact
`actorAccountId`. Browser data cannot supply a command, profile path,
`GH_CONFIG_DIR`, token, hostname, or account override. Account mismatch,
timeout, malformed output, or cleanup failure occurs before the transport can
write.

The legacy GitHub action adapter and the PR external-action transport share
this credential-source boundary and the same confirmation executor. A bounded
credential lease exists only for confirmed execution or reconciliation, is
passed directly to the selected transport, and releases its references during
cleanup. No credential enters intent state, receipts, logs, browser responses,
model context, backup, or recovery data. Credential selection never changes
the immutable account, repository, ref, Head OID, action, or payload binding.

## Memory

Raw local records are authoritative. Search and cited answering select bounded
records from the local index. A generated answer is accepted only when each
claim cites currently accessible raw evidence; derived or superseded records
cannot be the sole authority. Local inference works without a remote provider.
Remote inference additionally passes the per-data-class authorization gate.
Roles receive memory only through an explicit `query_memory` intent. The query
is durably reserved before inference, limited to one attempt per work revision,
revalidated against current citations, and then returned to the same role
decision; replacing the brain does not grant memory access or side effects.

## Operations and recovery

Mutable stores use single-writer queues, revisions, digests, journals, or
content-addressed artifacts. Startup restores state and reconciles uncertain
operations before readiness. Backup closes admission, drains participating
writers, records a global checkpoint, then copies and hashes the declared data
set. Restore validates into a separate directory, migrates and reconciles it,
and activates it only after those checks pass.

The startup bootstrap captures a private source checkpoint before importing
the application. The public runtime identity contains the commit, tree, and
declared-package digest; the process-private checkpoint also binds the Git HEAD
reflog. Rechecking both after module loading detects edits and ordinary
commit/checkout/reset A-to-B-to-A races without exposing local history through
the status API. It is a provenance boundary, not protection from another
process already running as the same trusted local user.

Liveness answers only whether the local process can serve. Readiness also
accounts for store health, reconciliation blockers, recovery state, and
capacity. See [OPERATIONS.md](OPERATIONS.md) for procedures.

## Trust boundaries

- The loopback process and its local operating-system account form the primary
  trust boundary.
- Browser payloads, model output, repository content, imported text, remote
  responses, and recovery inputs are untrusted.
- Secrets are injected from environment variables into the smallest possible
  adapter and must not enter model context, state, logs, or browser responses.
- Privileged features are disabled by default; explicit configuration grants
  capability but never bypasses confirmation or evidence checks.
- GitHub writes remain fake or disabled in ordinary tests and local acceptance
  unless the owner has separately confirmed the publishing account.
