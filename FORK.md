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
- Every change, docs included, goes on a branch with a PR into `develop`, merged with a merge commit once Fork CI is green (`gh pr merge <n> --merge`). Auto-merge is off on the fork, so `--auto` fails: wait with `gh-wait pr <n> -R audichuang/openidea`, then merge. An agent merges a PR only when the user has said to merge that work ("merge", "commit push and merge", or the same for an earlier step of it); otherwise it leaves the PR open with the Fork CI result. A red it cannot fix, or a call it cannot make, also leaves the PR open for the user. The auto-rebase's own `develop` and release pushes are set up by the user and follow its skill.
- Nobody pushes `develop` directly except a rebase: the auto-rebase's lease push, or the user's own verified rebase. `develop` and `main` have no branch protection on purpose, since rebases force-push them.
- Rebase lock branches use the `rebase/` prefix and CI bases `ci-base/`; pick other prefixes for work branches.
- A branch cut from `develop` before a rebase moved it: `git rebase --onto fork/develop <its old merge-base>`. A plain rebase replays the old upstream range along with it.

## Platform scope

- Fork features must work on macOS, Windows and Linux, and a ClipCode payload copied on one OS must paste correctly on another (the user copies on the Mac and pastes on a Windows machine, and back). Paths inside a payload are always `/`-spelled; each OS converts at the edge. `crates/ide-clip/fixtures/clipboard-contract.json` is the shared contract and passes on all three CI jobs.
- The ClipCode format is shared with the IntelliJ, VS Code and Orca implementations. A fix that would change the format is a four-repo change: stop and take it to the user, never change it here alone.
- Releases ship the macOS arm64 app and the Windows x64 installer.

## Merge gate

- Fork CI (`.github/workflows/fork-ci.yml`) is the gate; its `Fork CI passed` job is the one result to read. It runs what upstream's `ci.yml` runs (Rust clippy and tests on macOS, ubuntu-22.04 and Windows, the musl remote server, cargo deny, frontend, E2E), split into parallel jobs, plus the auto-rebase precheck's scenario test. It runs on PRs into `develop` and pushes to `develop` and `rebase/**`, and skips the auto-rebase's lock commit.
- Speed: `develop` pushes save the Rust caches PRs restore; debug info is off; Windows links with `rust-lld`. On a PR, and on a develop push compared with the commit before it, the `scope` job skips Rust jobs when only frontend paths changed, frontend jobs when only Rust paths changed, and both when only docs, `.claude/`, `scripts/fork/` or `fork-release.yml` changed. Swatinem's rust-cache saves on a failed job too (the test jobs keep only the registry in it). Test jobs restore a rolling cache of `target/` (`.github/actions/target-cache`): each develop run prunes obsolete artifact hashes against Cargo JSON from the current test/clippy builds, removes incremental output, saves at zstd level 1 under a key with its commit and deletes the older one; PRs only report the reclaimable bytes. Restore looks up the key first, bounds each download segment to 2 minutes, retries a failed download once and logs no key / download failed / restored; a restore sets every tracked file's mtime far in the past and the files changed since the cached commit to now, so cargo rebuilds only those crates and their dependents (a missing cached commit rebuilds the workspace). The key carries the ISO week and the rustc hash, so it starts clean weekly and on a toolchain change. Windows builds on a trusted ReFS Dev Drive with Defender's real-time scanning off. The repo's cache limit is 30 GB. Windows Rust tests keep three nextest `slice` partitions (measured test-seconds are more balanced than `count`; a build-once archive would add serial upload/download/setup to the gate). macOS stays one job, installs Go with its build cache so the Unix-only Go process tests execute, and runs nextest with 6 threads on its 3 cores (the tests mostly wait on subprocesses; the Go process test binary is Unix-only, so Windows cannot cover it), vitest in three shards and E2E in two (Linux runners are plentiful); `pnpm build` runs in the static-checks job. `rebase/**` pushes run everything. Develop runs are never cancelled by a newer push, since they save the caches; PR and `rebase/**` runs are.
- Upstream's `ci.yml` stays unedited. The `upstream-ci` job pins its SHA-256 and fails when a rebase brings a changed `ci.yml`: port the change into `fork-ci.yml`, then update the pin.
- Hosted macOS arm64 runners are scarce: a macOS job can queue for many minutes, or be cancelled with "The job was not acquired by Runner". That is capacity, not the change: rerun it. Keep macOS work in one job, and cancel superseded runs (`gh run cancel`) so they free runners.
- A red job gets one `gh run rerun <id> --failed`; red again is real.
- Locally before pushing: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm knip`, `pnpm test`. On the Mac mini cargo checks, clippy and tests go to the ubuntu host through `rust-remote` (`rust-remote fmt --all --check`, `rust-remote clippy --workspace --all-targets -- -D warnings`, `rust-remote nextest run --workspace --profile ubuntu-remote`). The `ubuntu-remote` profile in `.config/nextest.toml` leaves out the tests that fail there for environment reasons (the `ide-plugin` host tests need the sample plugins' wasm, three `ide-sdk` tests need Go and a JDK), so any failure it reports is real. `rust-remote` syncs sources up and brings back only `Cargo.lock` and `--pull` paths, so `cargo fmt --all` (which rewrites files) runs locally with `PATH="$HOME/.cargo/bin:$PATH"`. Regenerate `src/bindings.ts` the same way: `rust-remote --pull src/bindings.ts test -p openidea --test export_bindings`. If the ubuntu host loses its GTK/WebKit/dbus development packages again (an OS upgrade removed them once), building the app on the Mac (`pnpm dev:app`) regenerates it too.
- User-visible changes are also proven in the running app: upstream's `verify` skill, plus the fork's `fork-verify` (`.agents/skills/fork-verify`, linked from `.claude/skills/fork-verify`) for how Tauri MCP (`mcp__tauri__*`, webview) and osascript/cliclick (real OS input on the same `pnpm dev:app` process) split the work, AppKit chrome, and the fork's feature map.
- Upstream's `CI` and `Release` workflows stay disabled on the fork (`gh workflow disable`): `CI` would rerun the whole uncached suite on every release's `main` push. A rebase that brings a new upstream workflow needs the same, right after `develop` moves: `pull_request_target` runs the workflow from the PR's base branch, so it fires on the next PR into `develop` (v0.1.35's `PR check` labelled one within seconds).
- What runs when: a PR into `develop` runs Fork CI, the only run anyone waits for. The merge's `develop` push runs it again in the background (scope by the merged paths) to save the caches and catch two PRs that pass alone but not together. A release tag runs only Fork Release.

## Rebase conflicts

Rebase with `git rebase --onto <vNEW> $(git merge-base fork/develop origin/main)`: `develop` may sit on upstream commits past its release tag. Keep `git config rerere.enabled true`. During a rebase "ours" is the new upstream side and "theirs" the fork commit.

Mechanical kinds:

- **Locale JSON** (`src/platform/locales/**`): `python3 scripts/fork/resolve-conflicts.py locale <file>` keeps upstream's side and adds the keys the fork adds, dropping keys upstream removed. It refuses when the fork changes or removes an upstream key, or upstream gave a fork key a different string.
- **Appended tests**: both sides added tests at the end of the same file. `python3 scripts/fork/resolve-conflicts.py append <file>` keeps both, upstream first; it refuses when any hunk edits existing lines.
- **Generated files** (`Cargo.lock`, `pnpm-lock.yaml`, `src/bindings.ts`): take upstream's side, then regenerate once the rebase ends (`pnpm install --lockfile-only`; `rust-remote --pull Cargo.lock metadata --format-version 1`; `src/bindings.ts` as in the Merge gate note above; the auto-rebase leaves upstream's side and lets Fork CI's `Bindings are up to date` check catch drift, which makes the rebase MANUAL). A fork crate's version follows the workspace version, so `Cargo.lock` changes on every upstream version bump.

Anything else is MANUAL: keep the fork's behaviour, adopt upstream's new structure.

Standing decision: updater endpoint and PAC policy lives in `src-tauri/src/fork_updater.rs`. When rebasing upstream `266e4eeb` (CNB update sources), retain the fork-owned policy and keep both the updater builder and `updates_configured` using its endpoint list. Fork releases use the configured fork endpoint (or `OPENIDEA_UPDATE_ENDPOINT` override), without appending CNB or upstream sources. Apply a PAC decision only when exactly one endpoint is configured: the updater builder shares that decision across all endpoints and the artifact download, so a first-endpoint decision cannot safely cover multiple sources.

Standing decision: on macOS, project window groups keep the fork's AppKit native window tabs, which share one real fullscreen Space. Upstream's simple fullscreen for grouped windows (l0ng-ai/openidea#1218, reverted by the fork's `revert(macos)` commit on v0.1.36) is not taken: it covers the current desktop instead of giving the IDE its own Space. When upstream changes group fullscreen again, resolve toward the native tabs and still take its unrelated window changes.

## Unattended rebase

- The Orca automation "OpenIDEA fork 自動 rebase" fires hourly at :37. Its precheck (`.claude/skills/openidea-fork-auto-rebase/scripts/precheck.sh`, read from `fork/develop`) lets the agent run only when upstream published a newer Release than the fork base, a rebase lock went stale or obsolete, or the user approved a needs-human PR (below). The agent follows the `openidea-fork-auto-rebase` skill in a fresh worktree on `fork/develop`.
- CLEAN or MECHANICAL with green gates: it moves `develop` with a lease on the commit it rebased and releases. MANUAL, or a red it cannot fix: it leaves the `rebase/vX` lock and a PR marked needs-human for the user. Either way it sends a Bark notice.
- To hand a needs-human PR back after review, comment with `<!-- auto-rebase:approved <full sha of the rebase/vX tip> -->` as the first line. The next hourly precheck starts a run that moves `develop` (or finds it already moved) and releases, without redoing the rebase or the gates. Pushing to `rebase/vX` afterwards voids the approval.
- While a rebase lock exists, hold merges into `develop`; a merge meanwhile makes the lease fail and the next run starts over.
- The skill and its scripts live in `.claude/skills/openidea-fork-auto-rebase/` and change through a PR. Upstream's `.gitignore` ignores `.claude/` except its own skills; the fork adds exceptions for `fork-verify` and `openidea-fork-auto-rebase` below them, so a new fork skill needs its own `!.claude/skills/<name>` line there. Only the automation definition, `BARK_URL` (Doppler `shioaji`/`dev`) and `~/.config/fork-automation/precheck-alert.sh` live on the machine.

## Release

- Version `vX.Y.Z-fork.N`: X.Y.Z is the fork base, N counts up per base from 1.
- Move `main` and push an annotated tag in one atomic push. The tag message is the release notes, in Traditional Chinese: the fork base, upstream's user-visible changes since the last release, the fork's user-visible changes.

  ```sh
  old=$(git ls-remote fork refs/heads/main | cut -f1)
  git tag -a vX.Y.Z-fork.N <sha> -F notes.md && git push --atomic --force-with-lease=main:$old fork <sha>:refs/heads/main vX.Y.Z-fork.N
  ```

- The tag push runs `.github/workflows/fork-release.yml`: it refuses a tag that is not fork `main` or whose commit is not on `develop` (a commit an earlier published release shipped is let through, for a rerun or a rollback), then builds the macOS arm64 app (Developer ID signed and notarized) and the Windows x64 NSIS installer in parallel, with thin LTO (set in the workflow; `Cargo.toml` keeps upstream's fat LTO) and, on Windows, a trusted ReFS Dev Drive with Defender's real-time scanning off. Only when both succeed does it publish the GitHub Release with both, the updater's `latest.json`, and bump `Casks/openidea-fork.rb` in `audichuang/homebrew-tap` with the `TAP_DEPLOY_KEY` deploy key. A Windows failure blocks the release like a macOS one: both platforms are in daily use. Re-running the workflow on the same tag replaces the assets and notes.
- Both builds carry the tag's version (`X.Y.Z-fork.N`, shown in About) and point the built-in updater at this fork's `latest.json` with the fork's own key (`TAURI_SIGNING_PRIVATE_KEY` and its password, backed up in 1Password, Agent vault; the public key is in the workflow), so the app updates itself to fork releases, never to upstream's. Windows ships NSIS only: MSI rejects a pre-release version. The Windows installer has no Authenticode signature, so a browser-downloaded installer meets SmartScreen once ("More info → Run anyway"); updates the app downloads itself carry no download mark and install without it.
- Every `develop` push (and a weekly run) builds a release candidate with the same workflow: signed, notarized, under the version the next release will carry (the fork base plus the next free `fork.N`), kept as a workflow artifact for 3 days, and it rolls the release `target/` cache forward (`.github/actions/target-cache`; candidate and tag builds share `.github/actions/fork-release-setup`, so a `CARGO_*` variable added to only one side breaks the cache). A newer develop push cancels the candidate in flight. A release tag whose commit and version match a successful candidate publishes that candidate's assets without building (it waits for a candidate still running); otherwise it builds, restoring the newest candidate's cache. The repo's cache limit is 30 GB.
- To try a workflow change without releasing, push a `fork-release-dryrun-<anything>` tag: it carries the next version, reuses a matching candidate like a release (or builds both platforms), and stops after writing `latest.json`; nothing is published. Delete the tag afterwards.
- Installing: macOS `brew install --cask audichuang/tap/openidea-fork` once; the cask says `auto_updates true`, so later updates come from the app and `brew upgrade` leaves it alone. Windows: run `openidea-fork-windows-x64-setup.exe` from the release once; it replaces an official OpenIDEA install and shares its settings, like the Mac build.
- Pushed tags and `backup/*` branches keep released commits reachable after a rebase rewrites `develop`.
