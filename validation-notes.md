# Validation notes

This tracked file describes the acceptance contract only. Run-specific evidence
is private operational data and belongs under the ignored
`validation-artifacts/runs/<run-id>/` directory; do not copy it into commits.

## Required acceptance record

Before declaring a release ready, create evidence from one clean, immutable Git
source state:

1. Run the core system validator.
2. Run the complete validator with Docker and the current managed UI service.
3. Obtain the two required scoped reviews after that validation run.
4. Publish the acceptance manifest that binds the validation report, UI
   artifacts, runtime identity, and review receipts to the same source state.
5. Complete the product-run external acceptance gate. The owner-only license
   gate was resolved with Apache-2.0 on 2026-08-10; its U11 distribution-
   identity slice is complete.

The machine-readable report is authoritative. A prose summary must not replace
it and must not claim a skipped, stale, simulated, or unauthorized check as a
pass.

## Privacy boundary

Never commit real repository identities, pull-request or issue numbers, process
identifiers, account names, private paths, provider responses, credentials,
local configuration, confirmation contents, screenshots, logs, or memory data.
Use synthetic identities in tracked tests and documentation.

## External-action boundary

Validation does not authorize a GitHub write, provider request, service restart,
Docker startup, push, or publication. Those actions require their own explicit
owner authorization and must remain inside the product's confirmation and
capability boundaries.
