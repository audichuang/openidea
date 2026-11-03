# Maintaining this fork

Personal fork of OpenIDEA (`audichuang/openidea`, remote `fork`; upstream `l0ng-ai/openidea`, remote `origin`). Fork-only code lives in fork-owned files where possible; upstream files carry the smallest diff that wires it in. Read this before rebasing, before merging fork work into `develop`, and before releasing.

## Terms

- **Fork base**: the newest upstream GitHub Release tag (`vX.Y.Z`) that `develop` sits on. A tag upstream pushed without publishing a Release does not count.
- **develop**: the fork's integration branch: fork base plus the fork's commits. The GitHub default branch.
- **main**: a pointer to the last released commit. It only ever moves by force-push at release time.
- **Rebase lock**: a `rebase/vX.Y.Z` branch on the fork. While it exists an automated rebase is in flight or waits for the user.
- **CLEAN**: a rebase with no conflict and no extra commit.
- **MECHANICAL**: a rebase whose only conflicts are the mechanical kinds in "Rebase conflicts" (resolved by `scripts/fork/resolve-conflicts.py` or by regenerating a file), plus at most the regenerate commit.
- **MANUAL**: any other rebase: a conflict resolved by judgement, a fix commit, a dropped commit.

## Red lines

- Push only to `fork`, never to `origin`. No PRs to upstream.
- Every change, docs included, goes on a branch with a PR into `develop`, merged with a merge commit once Fork CI is green (`gh pr merge <n> --merge`). An agent merges its own PR without waiting for the user; a red it cannot fix, or a call it cannot make, leaves the PR open for the user.
- Nobody pushes `develop` directly except a rebase: the auto-rebase's lease push, or the user's own verified rebase. `develop` and `main` have no branch protection on purpose, since rebases force-push them.
- Rebase lock branches use the `rebase/` prefix and CI bases `ci-base/`; pick other prefixes for work branches.
- A branch cut from `develop` before a rebase moved it: `git rebase --onto fork/develop <its old merge-base>`. A plain rebase replays the old upstream range along with it.

## Platform scope

- Fork features must work on macOS, Windows and Linux, and a ClipCode payload copied on one OS must paste correctly on another (the user copies on the Mac and pastes on a Windows machine, and back). Paths inside a payload are always `/`-spelled; each OS converts at the edge. `crates/ide-clip/fixtures/clipboard-contract.json` is the shared contract and passes on all three CI jobs.
- The ClipCode format is shared with the IntelliJ, VS Code and Orca implementations. A fix that would change the format is a four-repo change: stop and take it to the user, never change it here alone.
- Releases ship only the macOS arm64 DMG. A Windows build is the next item, not yet in scope.

## Merge gate

- Fork CI (`.github/workflows/fork-ci.yml`) is the gate; its `Fork CI passed` job is the one result to read. It runs what upstream's `ci.yml` runs (Rust clippy and tests on macOS, ubuntu-22.04 and Windows, the musl remote server, cargo deny, frontend, E2E), split into parallel jobs, plus the auto-rebase precheck's scenario test. It runs on PRs into `develop` and pushes to `develop` and `rebase/**`, and skips the auto-rebase's lock commit.
- Speed: `develop` pushes save the Rust caches PRs restore; debug info is off; Windows links with `rust-lld`. On a PR, and on a develop push compared with the commit before it, the `scope` job skips Rust jobs when only frontend paths changed, frontend jobs when only Rust paths changed, and both when only docs, `.claude/`, `scripts/fork/` or `fork-release.yml` changed. Swatinem's rust-cache saves on a failed job too, and Windows builds on a ReFS Dev Drive. `rebase/**` pushes run everything. Develop runs are never cancelled by a newer push, since they save the caches; PR runs are.
- Upstream's `ci.yml` stays unedited. The `upstream-ci` job pins its SHA-256 and fails when a rebase brings a changed `ci.yml`: port the change into `fork-ci.yml`, then update the pin.
- Hosted macOS arm64 runners are scarce: a macOS job can queue for many minutes, or be cancelled with "The job was not acquired by Runner". That is capacity, not the change: rerun it. Keep macOS work in one job, and cancel superseded runs (`gh run cancel`) so they free runners.
- A red job gets one `gh run rerun <id> --failed`; red again is real.
- Locally before pushing: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm knip`, `pnpm test`. On the Mac mini all cargo work goes to the ubuntu host through `rust-remote` (`rust-remote fmt --all --check`, `rust-remote clippy --workspace --all-targets -- -D warnings`, `rust-remote nextest run --workspace`, `rust-remote --pull src/bindings.ts test -p openidea --test export_bindings`). On that host `ide-plugin` tests fail without the sample plugins' wasm and three `ide-sdk` tests see its real Go and JDK; compare against a clean upstream worktree before calling a red fork-caused. The Mac mini has no local `rustfmt`, so the pre-commit hook fails on `.rs` files there: check with `rust-remote fmt --all --check`, then commit with `--no-verify`.
- Upstream's `CI` runs on `main` pushes, i.e. once per release; upstream's `Release` workflow stays disabled on the fork.

## Rebase conflicts

Rebase with `git rebase --onto <vNEW> $(git merge-base fork/develop origin/main)`: `develop` may sit on upstream commits past its release tag. Keep `git config rerere.enabled true`. During a rebase "ours" is the new upstream side and "theirs" the fork commit.

Mechanical kinds:

- **Locale JSON** (`src/platform/locales/**`): `python3 scripts/fork/resolve-conflicts.py locale <file>` keeps upstream's side and adds the keys the fork adds, dropping keys upstream removed. It refuses when the fork changes or removes an upstream key, or upstream gave a fork key a different string.
- **Appended tests**: both sides added tests at the end of the same file. `python3 scripts/fork/resolve-conflicts.py append <file>` keeps both, upstream first; it refuses when any hunk edits existing lines.
- **Generated files** (`Cargo.lock`, `pnpm-lock.yaml`, `src/bindings.ts`): take upstream's side, then regenerate once the rebase ends (`pnpm install --lockfile-only`; `rust-remote --pull Cargo.lock metadata --format-version 1`; the bindings test above). A fork crate's version follows the workspace version, so `Cargo.lock` changes on every upstream version bump.

Anything else is MANUAL: keep the fork's behaviour, adopt upstream's new structure.

## Unattended rebase

- The Orca automation "OpenIDEA fork 自動 rebase" fires hourly at :37. Its precheck (`.claude/skills/openidea-fork-auto-rebase/scripts/precheck.sh`, read from `fork/develop`) lets the agent run only when upstream published a newer Release than the fork base, or a rebase lock went stale or obsolete. The agent follows the `openidea-fork-auto-rebase` skill in a fresh worktree on `fork/develop`.
- CLEAN or MECHANICAL with green gates: it moves `develop` with a lease on the commit it rebased and releases. MANUAL, or a red it cannot fix: it leaves the `rebase/vX` lock and a PR marked needs-human for the user. Either way it sends a Bark notice.
- While a rebase lock exists, hold merges into `develop`; a merge meanwhile makes the lease fail and the next run starts over.
- The skill and its scripts live in `.claude/skills/openidea-fork-auto-rebase/` and change through a PR. Upstream ignores `.claude/` and `CLAUDE.md`, so a new file there needs `git add -f`, and the pre-commit hook then fails to re-stage it ("lint-staged failed due to a git error", no commit made): run `pnpm exec oxfmt --check <those files>`, then commit with `--no-verify`. Only the automation definition, `BARK_URL` (Doppler `shioaji`/`dev`) and `~/.config/fork-automation/precheck-alert.sh` live on the machine.

## Release

- Version `vX.Y.Z-fork.N`: X.Y.Z is the fork base, N counts up per base from 1.
- Move `main` and push an annotated tag in one atomic push. The tag message is the release notes, in Traditional Chinese: the fork base, upstream's user-visible changes since the last release, the fork's user-visible changes.

  ```sh
  old=$(git ls-remote fork refs/heads/main | cut -f1)
  git tag -a vX.Y.Z-fork.N <sha> -F notes.md && git push --atomic --force-with-lease=main:$old fork <sha>:refs/heads/main vX.Y.Z-fork.N
  ```

- The tag push runs `.github/workflows/fork-release.yml`: it refuses a tag that is not fork `main` or whose commit is not on `develop` (a commit an earlier published release shipped is let through, for a rerun or a rollback), builds a Developer ID signed, notarized arm64 DMG (about 50 minutes), publishes the GitHub Release and bumps `Casks/openidea-fork.rb` in `audichuang/homebrew-tap` with the `TAP_DEPLOY_KEY` deploy key (backed up in 1Password, Agent vault). Re-running the workflow on the same tag replaces the DMG and notes.
- Installing is the user's: `brew upgrade --cask openidea-fork` on each machine, with the app closed. The fork's built-in updater is off.
- Pushed tags and `backup/*` branches keep released commits reachable after a rebase rewrites `develop`.
