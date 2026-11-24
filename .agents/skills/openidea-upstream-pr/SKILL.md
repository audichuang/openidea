---
name: openidea-upstream-pr
description: OpenIDEA-specific know-how for sending a pull request from this fork to upstream l0ng-ai/openidea, loaded alongside the generic `pr` skill. Covers what the maintainer re-tests and re-measures, a branch from origin/main without fork commits, perf measurement in Chromium and WebKit, and the lessons of upstream PRs 5336 and 5649. Use when preparing, measuring, writing or sending an upstream PR, "提 PR 給上游", "上游 PR", "送上游", or answering the maintainer's review on one. Not for fork PRs into develop.
---

# Upstream PRs to l0ng-ai/openidea

Load the global `pr` skill first: its body rules, evidence rules and `references/perf-and-behaviour.md` apply. This skill adds only what is specific to OpenIDEA's upstream.

## When an upstream PR is allowed at all

Since 2026-11-25 the user's standing rule is: any fork fix or improvement the maintainer would plausibly accept may go upstream, one problem per PR, meeting the no-regression bar in `pr`'s perf reference. Fork-only features and `FORK.md` standing decisions stay in the fork. Security problems never go into a public PR or issue: upstream `SECURITY.md` asks for a private advisory, and the user decides whether to file one. Before opening: an independent review (advisor or a second model) of the diff, the body and the evidence; then a draft, CI, and `gh pr ready`. Reds that upstream's own `main` already has don't block ready (the user's rule): confirm each on the PR's base commit and name them in a PR comment first.

## The maintainer (researched 2026-11-25 over the last 400 merged/closed PRs)

- `l0ng-ai` merges, `arookieofc-ai` pre-reviews. About two thirds of merges are external; external PRs are rarely closed unmerged (4 of 5 by their own authors, 1 as a duplicate). Merge latency is 1–10 h.
- He **re-tests in the app and re-measures**. He caught #5336's two regressions with his own numbers, and re-ran #5649's rewrite against `main` on 400,000 generated lines. Numbers in the body must reproduce on his machine.
- He often pushes fixes and a `main` merge onto the contributor's branch before merging. Pull before pushing again.
- Drafts are never merged. The PR-check bot adds `needs-info` when "How it was verified" is missing.
- An issue is not required, and about half of external fixes have none. Link one with `Closes #<n>` when it exists in upstream. A product call goes into an upstream issue, and then you stop (`CONTRIBUTING.md`).

## Checklist before the draft

- Conventional title (`fix(scope): …`, `perf(scope): …`). Write "What and why" in 2–4 plain sentences: the user-visible problem and its root cause.
- One problem per PR. Search open PRs and recent merges for duplicates first (#5417 was closed as a duplicate of #5415).
- A red→green regression test. Before/after screenshots for visible UI, and a recording for multi-step flows.
- Follow the UI rules in `AGENTS.md`: tokens, no hex, and every new string in `en.json` and `zh.json`.
- Rebase onto the latest `origin/main` before opening; once the PR is open, merge `origin/main` instead (the maintainer may have pushed onto the branch) and re-run the checks before every push. Run the frontend checks locally. Run the Rust checks through `rust-remote`, as the machine rules require.
- For a red upstream CI, rerun the failing tests on the PR's base commit before you call them pre-existing. Name them and the base sha in the PR (#5649: five E2E tests failed on `6cca609d5` without the change).
- Examples of merged external UI fixes: #5645 #5620 #5578 #5662 #5484 #5428 #5458 #5505 #5473 #5440.

## Branch, push, open

```bash
git fetch origin
git worktree add ../openidea-wt/up-<name> -b up/<name> origin/main
# … commits …
git push fork up/<name>
gh pr create --draft -R l0ng-ai/openidea --base main --head audichuang:up/<name> --body-file <body>
```

- Never carry fork commits. Check with `git log origin/main..HEAD`: every commit must be yours for this PR. If the change depends on a fix that exists only in the fork, bring that fix into the PR as its own commit and measure again. #5336 was first measured on the fork, where an earlier fork fix (`d13c6ed44`) hid the frame regression.
- In the upstream body, `#<n>` refers to upstream. Never mention fork issues, fork PRs or fork-only commits there.
- The fork's own issue and PR (`-R audichuang/openidea`, into `develop`) are a separate trail. Don't mix them up.

## Lessons

- **#5336** (combined-diff virtualization): blocked at first on two regressions that our own body had already listed, frame p95 17 → 117 ms and selection plus expanded lines resetting after a scroll. Disclosing them didn't help. The slowdown was put down to "likely editor creation" and never profiled. One CPU profile later found the real cause: per-editor CodeMirror themes (`seamlessSelection()`, `movedCodeHighlights()`, `fontExtension()`) inserted rules that restyled the whole page, about 90 ms per mount. It merged after the fixes, with an A/B table (main / main + theme fix / PR) in Chromium and WebKit. Lesson: unmounting needs the parity list in `pr`'s perf reference, and every number is compared with `main`.
- **#5649** (linear output-link detection): praised. The output was identical to `main`'s `findOutputLinks`, the change was a small single path, and it shipped only the part that carried the win. WebKit A/B showed that removing the 4,000-char cutoff regressed no-newline streams (max frame 31 → 121 ms), so the cutoff stayed. An earlier lookbehind version had passed 2M short random strings but dropped the second of two adjacent links (`a.ts:1b.ts:2`).

## Measuring

- **Frontend, headless Chromium**: `pnpm perf --only <id>` runs 1 warmup and 3 runs by default (`--runs`, `--warmup`). `--profile --unminified` gives a CPU profile with readable function names. Results go to `target/perf/report.json`, and the body quotes its rows (median). Add a new scenario as the PR's first commit, so that "before" = `origin/main` + scenario.
- **Real WebKit, in the dev app**: run an A/B in one session. Launch `pnpm dev:app` from the `up/` worktree, as `fork-verify` describes. Swap only the changed file between `git show origin/main:<path>` and the PR version, and let hot reload pick it up. Drive the workload through `window.__openideaPerf` with `.agents/skills/fork-verify/scripts/bridge-js.mjs <port> <window> '<js>'`. Alternate main/PR at least twice. Example scripts: the main checkout's `.agent-work/ui-perf-fixes/upstream/U8v2/webkit/` (`ab.sh`, `measure.js`, `notes.md`).
- **Rust**: run cargo and criterion through `rust-remote` (machine rule). On the shared ubuntu host, check `uptime` first. Pin cores and interleave the variants, e.g. `rust-remote bench --config 'target.x86_64-unknown-linux-gnu.runner=["taskset","-c","4-7"]' -p <crate> --bench <bench> -- <filter>`. For a rewrite that claims identical output, put the differential test (old vs new, with adjacency and boundary cases in the generator) in the crate's tests.

## Evidence

Keep drafts, A/B logs and screenshots in the main checkout under `.agent-work/<topic>/` (git-excluded, survives reboots), with a `TODO.md` saying where to resume. Upstream acceptance research: `.agent-work/upstream-prs/maintainer-acceptance.md`.
