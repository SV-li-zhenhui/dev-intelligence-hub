# Maintainer release checklist

Use this checklist for a public tag or release. It supplements the authoritative
acceptance contract in [`validation-notes.md`](../validation-notes.md).

## Repository settings

- Enable GitHub private vulnerability reporting and verify the link from the
  Security policy page before inviting public security reports.
- Protect `main` with a repository ruleset. Require pull requests, the CI status
  check, resolved review conversations, and protection from force pushes and
  deletion.
- Enable Dependabot alerts and security updates. Review whether secret scanning
  and push protection are available for the repository.
- Add repository topics such as `developer-tools`, `ai-agents`, `local-first`,
  `workflow-automation`, `github`, and `ollama`.
- Review the public commit author identity and email before pushing rewritten or
  new history.

## Source and privacy

- Start from a clean committed tree and confirm `git status --short` is empty.
- Verify `config.json`, `config.local.json`, `.env*`, `data/`, `logs/`,
  `backups/`, `validation-artifacts/`, `node_modules/`, and worktrees remain
  ignored and absent from the commit.
- Run the tracked-tree privacy and clean-distribution tests through `npm test`.
- Review new documentation, fixtures, filenames, and Git metadata for personal
  identities, private repositories, credentials, and machine paths.
- Keep real validation reports and screenshots local even when they pass.

## Acceptance

- Run `npm ci` from a fresh checkout.
- Run `npm test` and resolve every failure; document only intentional platform
  skips.
- Run `npm run setup:validation-browser` when the validation browser is absent
  or Playwright changed.
- Start the clean commit through the managed lifecycle and run
  `npm run validate:system -- --all` with Docker Desktop available.
- Obtain the two independent review records and generate the system acceptance
  manifest described in the README.
- Complete the separately authorized product-run live PR acceptance gate.

## Publication

- Confirm the README status, version, known limits, installation steps, and
  license match the release.
- Create an annotated version tag only after the acceptance evidence is bound to
  the same commit.
- Write release notes with user-visible changes, migration steps, known limits,
  and the exact verification scope.
- Download the public source archive, install it in a clean temporary directory,
  and repeat the safe startup check before announcing the release.
