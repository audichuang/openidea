---
name: openidea-upstream-pr
description: OpenIDEA-specific know-how for sending a pull request from this fork to upstream l0ng-ai/openidea, loaded alongside the generic `pr` skill. Covers what the maintainer re-tests and re-measures, a branch from origin/main without fork commits, perf measurement in Chromium and WebKit, finding what upstream wants, and the lessons of upstream PRs 5336, 5649, 5718, 5754 and 6282, briefing parallel workers, and cleanup after a merge. Use when preparing, measuring, writing or sending an upstream PR, "提 PR 給上游", "上游 PR", "送上游", or answering the maintainer's review on one. Not for fork PRs into develop.
---

# Upstream PRs to l0ng-ai/openidea

Load the global `pr` skill first: its body rules, evidence rules and `references/perf-and-behaviour.md` apply. This skill adds only what is specific to OpenIDEA's upstream.

## When an upstream PR is allowed at all

The user's rule (2026-11-28): only upstream's own bugs that still reproduce on `origin/main` go upstream, one problem per PR, meeting the no-regression bar in `pr`'s perf reference. The fork-only features (ClipCode, Git Graph, window tabs, Annotate extensions and the like) and `FORK.md` standing decisions are never sent; fork code that fell behind upstream is fixed in the fork by shrinking its footprint. Security problems never go into a public PR or issue: upstream `SECURITY.md` asks for a private advisory, and the user decides whether to file one. Before opening: the local gates, an in-app check when behaviour changed, and an independent review (advisor or a second model) of the diff, the body and the evidence. Then open it ready (or `gh pr ready` a draft) right away, without asking first (this replaces `pr`'s draft-then-ask flow for this repo) and without waiting for upstream CI, which takes 1–2 h (the user's rule since 2026-11-27). Leave `gh-wait` in the background and fix only the reds this PR caused. Reds that upstream's own `main` already has don't block: confirm each on the PR's base commit and name them in a PR comment. No Windows-only fixes: there is no Windows machine to verify on.

## The maintainer (researched 2026-11-25 over the last 400 merged/closed PRs)

- `l0ng-ai` merges, `arookieofc-ai` pre-reviews. About two thirds of merges are external; external PRs are rarely closed unmerged (4 of 5 by their own authors, 1 as a duplicate). Merge latency is usually under 10 h.
- He **re-tests in the app and re-measures**. He caught #5336's two regressions with his own numbers, and re-ran #5649's rewrite against `main` on 400,000 generated lines. Numbers in the body must reproduce on his machine.
- He often pushes fixes and a `main` merge onto the contributor's branch before merging. Pull before pushing again. He also resolves conflicts with upstream changes that landed meanwhile (#6377 against #6333, #6413 against our own #6412), so a conflict is no reason to hold a PR back.
- Code that compiles only on Windows waits for `Rust (windows-latest)` green: #6282's Job-object cleanup took 18 h from open to merge while `main`'s Windows job was broken.
- Drafts are never merged. The PR-check bot adds `needs-info` when "How it was verified" is missing.
- `arookieofc-ai` comments on almost every upstream PR (CI verdicts, pre-reviews). Take its real points into the body; no reply is needed, and its comments don't mean the PR is wrong. It approves only once the head is fully green. Upstream sometimes bulk-cancels external PRs' CI, `main`'s included (2026-11-26). A re-push then gets cancelled too: wait until other PRs' runs finish again, then push once.
- An issue is not required, and about half of external fixes have none. Link one with `Closes #<n>` when it exists in upstream. A product call goes into an upstream issue, and then you stop (`CONTRIBUTING.md`).

## Finding what to send

`pr`'s "外部貢獻" section applies. Here: #5698's merge comment led to #5754, #3994's close comment to #5718. Accepted label is `planned`; skip `needs-info`, `needs-decision`, `needs-acceptance`. Triage notes: `.agent-work/upstream-prs/issue-triage*.md`. Pick small, unambiguous fixes yourself and start; skip work likely to be blocked (the maintainer's active area, unclear root cause, product calls). Skip issues opened by contributors who send their own PRs fast (list: `.agent-work/upstream-prs/active-senders.md`): on 2026-11-27 one sent #6505/#6506 39 min after opening the issues, the same fixes our workers had just finished. Check open PRs right before pushing too (stack-module was dropped as a duplicate of #6366).

Reproduce on current `origin/main` first. If it doesn't reproduce, stop and record it; don't send a fix for a bug only the fork showed (build-longline, 2026-11-25).

## Checklist before the draft

- Conventional title (`fix(scope): …`, `perf(scope): …`). Write "What and why" in 2–4 plain sentences: the user-visible problem and its root cause.
- Fix only the bug. If the fix changes a wider rule than the bug needs, narrow it: the wider rule is a product call for an upstream issue. #6028's first version treated any nested build file as a separate module, so `web/blog` in a Django app with a `package.json` would have lost Python Package.
- One problem per PR. Search open PRs and recent merges for duplicates first (#5417 was closed as a duplicate of #5415).
- A red→green regression test. Before/after screenshots for visible UI, and a recording for multi-step flows.
- Follow the UI rules in `AGENTS.md`: tokens, no hex, and every new string in `en.json` and `zh.json`.
- Rebase onto the latest `origin/main` before opening; once the PR is open, merge `origin/main` instead (the maintainer may have pushed onto the branch) and re-run the checks before every push. Run the frontend checks locally. Run the Rust checks through `rust-remote`, as the machine rules require.
- For a red upstream CI, rerun the failing tests on the PR's base commit before you call them pre-existing. Name them and the base sha in the PR (#5649: five E2E tests failed on `6cca609d5` without the change).
- Test fixtures with multi-root commits: put the `repo` field on a variable, not a `Commit` literal, or tsc rejects it (#5718's red CI).
- Commit with `PATH="$HOME/.cargo/bin:$PATH"`: the pre-commit hook runs `rustfmt` and fails with `EACCES` without it.
- Keep upstream's deliberate UI rules even when they limit the fix (#5718: Commit's left divider stays header-only, so Repository is resizable from rows only when a fixed column leads). Say so in the body and offer the alternative.
- English UI for screenshots: `commands.settingsSet("global", "appearance.locale", JSON.stringify("en"))` in the dev app (its settings are in the worktree's own dev data dir, not the user's). Real drags: `.agents/skills/fork-verify/scripts/drag.swift`. Images: the fork's `pr-assets` branch.
- Examples of merged external UI fixes: #5645 #5620 #5578 #5662 #5484 #5428 #5458 #5505 #5473 #5440.

## A red job unrelated to the change

Per `pr`'s `after-open.md`. Known flaky here: `ide-host::mcp` timing tests (~10 s timeouts on the Linux runner; #5754, where the maintainer named it himself on merge). Run the test alone with `rust-remote nextest run -p ide-host --test mcp -E 'test(<name>)'`.

## Branch, push, open

```bash
git fetch origin
git worktree add ../openidea-wt/up-<name> -b up/<name> origin/main
# … commits …
git push fork up/<name>
gh pr create -R l0ng-ai/openidea --base main --head audichuang:up/<name> --title <title> --body-file <body>
```

- Never carry fork commits. Check with `git log origin/main..HEAD`: every commit must be yours for this PR. If the change depends on a fix that exists only in the fork, bring that fix into the PR as its own commit and measure again. #5336 was first measured on the fork, where an earlier fork fix (`perf(fork): 根除開 diff 時的卡頓…`, building each editor theme once) hid the frame regression. The same goes for every "Before" screenshot or observation in the body: take it on upstream `main` at the PR's base (debug-close's Before came from the fork and had to be rewritten, 2026-11-27).
- In the upstream body, `#<n>` refers to upstream. Never mention fork issues, fork PRs or fork-only commits there.
- The fork's own issue and PR (`-R audichuang/openidea`, into `develop`) are a separate trail. Don't mix them up.

## Parallel workers

The user's pace since 2026-11-27: two PRs in flight at a time, and when both are sent, triage and start the next two without being asked. An `up/*` worktree is cut from `origin/main`, so it has neither this skill nor the fork's `AGENTS.md`: give each worker absolute paths into the main checkout, starting from the shared brief `.agent-work/upstream-prs/common-brief.md` (machine rules, no push or GitHub actions, repro on `main` first, report files in `.agent-work/upstream-prs/<name>/`). Workers never launch the app; the main line runs the one in-app check per PR, reviews, pushes and opens it.

## After a merge

`pr`'s cleanup applies, without asking, with these differences. He squash-merges, so `wt-done` needs `--keep-branch`. Bundle the branch into `.agent-work/upstream-prs/branch-backup/`, `git fetch fork up/<name>` and check that tip equals the PR's `headRefOid` (he often pushes a `main` merge onto it) before deleting the local and fork branches. Never delete the fork's `pr-assets` branch: merged PR bodies keep linking its screenshots. Read the merge comment for follow-ups he names.

## Lessons

- **#5336** (combined-diff virtualization): blocked at first on two regressions that our own body had already listed, frame p95 17 → 117 ms and selection plus expanded lines resetting after a scroll. Disclosing them didn't help. The slowdown was put down to "likely editor creation" and never profiled. One CPU profile later found the real cause: per-editor CodeMirror themes (`seamlessSelection()`, `movedCodeHighlights()`, `fontExtension()`) inserted rules that restyled the whole page, about 90 ms per mount. It merged after the fixes, with an A/B table (main / main + theme fix / PR) in Chromium and WebKit. Lesson: unmounting needs the parity list in `pr`'s perf reference, and every number is compared with `main`.
- **#5649** (linear output-link detection): praised. The output was identical to `main`'s `findOutputLinks`, the change was a small single path, and it shipped only the part that carried the win. WebKit A/B showed that removing the 4,000-char cutoff regressed no-newline streams (max frame 31 → 121 ms), so the cutoff stayed. An earlier lookbehind version had passed 2M short random strings but dropped the second of two adjacent links (`a.ts:1b.ts:2`).

- **#5718** (Repository column width): asked for by the maintainer, merged the same day it was marked ready. What took the time: a TypeScript error in a test added after the last typecheck, and an advisor catching that the "headers off" A/B did different drags on `main` and the branch.
- **#5754** (long-line window capacity): 80 GiB → 76 MiB requested and 232 → 104 ms on a 20 MB line, but a short-line bench stayed ~1% slower for every variant that touched `in_window`. The variant that left the shared hot function untouched and changed only the long-line loop came closest; the user accepted the remaining ~1% stated plainly in the body. A first try with `Vec::new()` broke `bounded_memory` (each kept one-match result gets 4 slots). Hand the body and the raw logs to an independent reviewer: it found five numbers that didn't match their logs.

- **log-native-copy** (not sent, 2026-11-26): a jsdom test dispatching `selectstart`/`copy` failed on `main`, but real ⌘A/⌘C in the dev app copied exactly the message pane. jsdom has no WebKit Select All. For a bug in a macOS native-menu path (⌘A, ⌘C, ⌘V, Edit menu), record `main` in the app with osascript first, before writing the fix.

## Measuring

- **Frontend, headless Chromium**: `pnpm perf --only <id>` runs 1 warmup and 3 runs by default (`--runs`, `--warmup`). `--profile --unminified` gives a CPU profile with readable function names. Results go to `target/perf/report.json`, and the body quotes its rows (median). Add a new scenario as the PR's first commit, so that "before" = `origin/main` + scenario. For an A/B that has to hold up on noisy numbers, first build every bundle from one pinned upstream sha, with `main` built twice as an A/A control. Never read the moving `origin/main` inside the loop: it voided one batch. Rotate the order each round and note any other load on the machine. Judge each metric by the number of rounds where the PR is strictly the worst of the three: with two identical arms that is about 2 of 6 by chance, and only 5–6 of 6 means worse.
- **Real WebKit, in the dev app**: run an A/B in one session. Launch `pnpm dev:app` from the `up/` worktree, as `fork-verify` describes. Swap only the changed file between `git show origin/main:<path>` and the PR version, and let hot reload pick it up. Drive the workload through `window.__openideaPerf` with `.agents/skills/fork-verify/scripts/bridge-js.mjs <port> <window> '<js>'`. Alternate main/PR at least twice. Example scripts: the main checkout's `.agent-work/ui-perf-fixes/upstream/U8v2/webkit/` (`ab.sh`, `measure.js`, `notes.md`).
- **Rust**: run cargo and criterion through `rust-remote` (machine rule). On the shared ubuntu host, check `uptime` first. Pin cores and interleave the variants, e.g. `rust-remote bench --config 'target.x86_64-unknown-linux-gnu.runner=["taskset","-c","4-7"]' -p <crate> --bench <bench> -- <filter>`. The host runs other jobs: build first (`rust-remote bench --no-run …`), wait until the 1-minute load is under 1 (`ssh ubuntu 'awk "{exit !(\$1 < 1.0)}" /proc/loadavg'`), log `uptime` before and after each run, rotate the order of the variants per round, and drop rounds whose load rose (state it). mbx reuses one bench binary path per crate, so read symbols (`nm -S -C`) right after each variant's build. `perf stat` is not available there (paranoid 4, no sudo). `ide-search`'s `bounded_memory` fails on that host on `main` too (`a skipped file held` ~1040 KiB against 1 MiB). For peak allocations, copy that test's counting allocator into a temporary test file and leave it out of the commit. For a rewrite that claims identical output, put the differential test (old vs new, with adjacency and boundary cases in the generator) in the crate's tests.

## Security problems

Per `pr`'s hard rule: upstream `SECURITY.md` asks for a private advisory. The fork is public, so a fix branch is never pushed there. Open items and drafts: `.agent-work/security-advisories/`.

## Evidence

Keep drafts, A/B logs and screenshots in the main checkout under `.agent-work/<topic>/` (git-excluded, survives reboots), with a `TODO.md` saying where to resume. Upstream acceptance research: `.agent-work/upstream-prs/maintainer-acceptance.md`.
