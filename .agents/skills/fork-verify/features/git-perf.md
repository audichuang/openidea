# Git performance on a large repository

What the Git perf work (#277 #282 #283 #284 #285 #293 #297) must keep, checked on a real large history: Show History for Selection, Show History, Git Log, the author filter, Annotate and blame while typing.

## Fixture

`~/Project/hermes-agent` is a large repo on this Mac (about 69k commits on `main`). Never open the original in the IDE: auto fetch and autosave would touch it. Clone it and open the clone by its real path (`/private/tmp/…`, not `/tmp/…`):

```bash
git clone -q ~/Project/hermes-agent /private/tmp/perf-hermes
```

Useful targets: `gateway/run.py` has about 2,160 `git log -L` revisions and changes from 5,177 lines on `4761cbab79` to 30,922 on `27562ad5f8`, so checking out between them is a whole-file reload. A merge is the newest revision of lines 2001–2100. Delete the clone afterwards.

## Scenarios that found real bugs

- **Selection History**: select all of `gateway/run.py`, Git → Show History for Selection. First rows within about 0.3 s, a spinner until the full list, the selected row does not jump, deep-row diffs match `git log -L<a>,<b>:<file> -n1 <commit>`, closing a loading tab leaves no `git log -L` process (`pgrep -fl "git.*log.*-L"`). Lines 2001–2100 on a clean file must show no Local Changes row.
- **Freeze on checkout**: keep the Git tool window's Log tab visible and scrolled so many rows are loaded, Annotate on `run.py`, then `git checkout 27562ad5f8`, `git checkout main`, `git checkout 27562ad5f8`. A single checkout does not reproduce it; the round trip with Log loaded did (#292, quadratic scroll anchoring). Probe the webview every second; a stall over 10 s fails. Also with `run.py` in a background tab.
- **Annotate after checkout**: within about 10 s Annotate matches `git blame` at the new HEAD (#290 was the watcher thread blocked by local-history writes).
- **Typing**: with Annotate on, type with pauses while sampling `pgrep -fl "git.*blame"`; no blame per pause after the first. First check the sampler sees a blame when Annotate opens on a new file, so a zero count means something.
- **Data safety** (#294): type a character and ⌘Z, external `git checkout`, switch to Finder and back: the editor reloads and `git status` stays clean.

## Evidence

A frozen webview leaves no JS names in `sample <WebContent pid>`. When it shows `operationMakeRope3` / `resolveRope` in a microtask, count calls with temporary instrumentation in the suspect function instead of guessing. Before blaming a PR, run the same steps on `fork/develop` in its own worktree.
