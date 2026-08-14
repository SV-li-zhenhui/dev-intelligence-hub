# U12 GitHub production credential-factory startup fix

## Problem

Managed startup with active GitHub `gh-login` reaches the shipped credential
factory, but its strict dependency boundary rejects two production-shaped
values: Node's special `process.env` object and a `SupervisedProcessRunner`
class instance. Existing integration coverage supplied plain narrow ports and
therefore did not construct the exact shipped factory.

## Requirements

- Add a Windows-x64 production-factory regression that uses a synthetic pinned
  offline `gh.exe`, prepares a private temporary root, and constructs the
  shipped source without acquiring a credential or spawning the executable.
- Observe the regression fail with the same dependency-validation error before
  changing production code.
- Preserve the strict plain-record dependency boundary.
- Copy only the existing five allow-listed non-secret system path variables
  into a plain environment record and expose only the runner's bound `run`
  capability.
- Run the complete credential-source, composition-root, and supervised-process
  runner suites plus syntax and diff validation.
- Do not invoke installed `gh`, read credentials, call a model, perform a
  GitHub/network write, or push.
