# U12 unknown external-action owner sealing

## Problem

With working gh-login credentials, the product safely reconciled five of seven
historical uncertain GitHub Reviews. Two unchanged targets returned exact marker
absence. A later absence cannot prove that an earlier admitted write never ran,
so the queue correctly retained an unknown outcome and blocked readiness.

The queue already permits an owner to reject a failed item without executing or
reconciling it, but non-retryable unknown items were absent from the unified
attention projection. The owner therefore had no UI path to acknowledge the
remaining uncertainty and seal the item against replay.

## Requirements

- Surface durable failed items whose outcome is `unknown` in the same unified
  queue after ordinary pending/retryable items.
- Mark the public projection explicitly as `resolutionRequired`; never make the
  item retryable or convert absence into proof.
- Render an exact warning, bound target/action/details, diagnostic, original
  body and evidence, with only two controls: owner sealing through the existing
  bound reject operation, or defer.
- Do not show approve, retry, publish, execute, update, push, or merge controls.
- Bind sealing to queue revision, item revision, displayed payload digest and
  approval binding digest; record an explicit no-replay reason.
- Prove sealing performs no executor, credential, model, or GitHub call and
  removes the item from recovery readiness only after durable owner action.
- Run unit, server, static frontend, and real Playwright confirmation tests.
