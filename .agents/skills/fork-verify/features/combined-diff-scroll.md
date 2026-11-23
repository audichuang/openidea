# All-in-one diff scrolling (virtualized CombinedDiff)

What a change to the all-in-one diff (`src/features/vcs/CombinedDiff.tsx`, one tab with every file of a change, blocks mounted only near the view) must keep: a reveal from Changes lands on the file, Previous/Next File land on the neighbouring block, wheel scrolling moves the content by what the wheel sent, and no blank block shows when scrolling stops. Measured with real OS input on the dev app; scripts in `../scripts/combined-diff/` (each prints its usage with `--help`).

## Fixture and setup

```bash
C=.agents/skills/fork-verify/scripts/combined-diff
export PYTHONDONTWRITEBYTECODE=1   # keep __pycache__ out of the tracked script directory
python3 $C/mk-fixture.py ~/openidea-perf-fixtures   # recreates u4-mix (+ u4-sub-origin), seed 42
```

`u4-mix` has 301 changes: 300 files `dNN/mNNN.txt`, eight of them (m020, m075, m120, m180, m210, m240, m270, m295) 3–5k lines with every other line changed, so a block grows from its estimated height to about 100k px when measured; m150 partially staged (two blocks); a submodule `sub` with a new commit. Regenerate it before each build you compare.

Open it with the `openProjectInWindow` recipe (`../SKILL.md`), then through the bridge:

- `localStorage.setItem("openidea.diff.allInOne", "true")` (what the diff viewer's Show All Files in One Diff View does), and, in the project window, `import("/src/features/vcs/settingsUi.ts").then(m => m.saveVcsSetting("vcs.commit.doubleClickOpensDiff", true))` (the Changes view's Show on Double-Click item) so a double-click in Changes opens the diff at that file. `reveal.py` pages the first tree on the page, so keep the Commit tool window's Changes tree showing.
- The scripts read `PERF_WT` (worktree of the dev app, default the current git root), `PERF_PORT` (bridge port from `pnpm dev:status`), `W` (window label, `project-1`), `T` (AppKit window title, `u4-mix`) and `OUT` (records and `shots/`, default `/tmp/oi-verify/<worktree>/combined-diff`). Each run appends one JSON line per measurement to `$OUT/<script>.jsonl`; pass a tag (`before`, `after`) to tell runs apart.
- Split or unified is the diff toolbar's viewer buttons; measure both, the mode label is free text.

Restore afterwards: `saveVcsSetting("vcs.commit.doubleClickOpensDiff", null)` and `localStorage.removeItem("openidea.diff.allInOne")`.

## What to measure

| Check                          | Script                                                | Pass                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reveal landing                 | `reveal.py <tag> m100 m200 m260 …`                    | after 6 s the header block is the target and its top is at 0–8 px (`t6.hdr`, `target_top_px`). Mid-file targets with unmeasured blocks above are the ones that broke.                                                                                                                   |
| Previous/Next File             | `goto.py m202`, then `nav.py <tag> "Previous File" 6` | each press lands on the adjacent block at 8 px. Also start at m245 so the presses cross the 170k px m240.                                                                                                                                                                               |
| Slow / fast wheel up           | `goto.py m160`, then `jump2.py <tag> split`           | `excess_px` (content moved minus wheel delta) near 0 for slow bursts (5×100 px), no frame moving more than one wheel step plus slack (`jump_frames`).                                                                                                                                   |
| Scroll writes and their source | `fast.py <tag> <label> up\|down`                      | `wheel_delta_sum` equals the burst (9000 px), so input reached the page; `writes`/`sources` name who wrote `scrollTo`/`scrollBy`/`scrollTop` (virtualizer `applyScrollAdjustment`, CodeMirror `measure`, the view itself); `n_big` frames are content jumps scrollTop does not explain. |
| Blank blocks while reading     | `read.py <tag> [delta] [cap_s]`                       | `stops_with_empty` empty, mounted blocks / editors stay bounded (`mounted_max`, `cm_max`); frame gaps against the 3 s idle baseline in the same record.                                                                                                                                 |
| Crossing a large block         | `cross.py <tag> <mode> <n>`                           | classifies each >5k px frame by where m020 was when it grew. A block growing while already in view is not compensated (before or after #484); count it, don't fail on it.                                                                                                               |

## Pitfalls

- **Track the block at the centre, frame by frame, not a line.** Tracking the centre line reads null as soon as its block unmounts (9 of 16 samples in the first round). `jump2.py`/`fast.py` re-pick the block under the viewport centre every frame and sum its movement.
- **Judge a jump by content movement in the frame, not by scrollTop.** A scrollTop write of 100k+ px with 0–2k px content movement in the same frame is the compensation working; a jump is content moving more than the wheel explains.
- **BEFORE and AFTER in the same session, app frontmost both times.** Frame stats from a background window differ (one round had AFTER unfocused and BEFORE focused, so its frame numbers were unusable). `fast.py` records `frontmost` before and after each burst; drop runs where either is false. The cheapest same-session BEFORE is one dev app with the old `CombinedDiff.tsx` swapped in and reloaded.
- **The wheel is discrete.** `wheel.swift` posts CGEvent pixel wheel events (no cliclick wheel, no trackpad inertia); report trackpad scrolling as unverified. Several events can land in one frame, so a 2–2.4k px frame in a fast burst is not by itself a jump.
- **One dev app at a time** (`../SKILL.md`, Launch): the scripts find the app by `PERF_WT`, and clicks and the wheel go to whatever is frontmost.
- The reveal double-click sometimes does not open the tab: `t6.hdr` is then the previous view, not a wrong landing. Rerun that target.
