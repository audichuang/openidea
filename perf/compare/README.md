# IDE comparison

`pnpm perf` measures OpenIDEA from inside its webview. This measures any IDE
from the outside, the same way for each, so OpenIDEA can be compared with
IntelliJ IDEA (or anything else listed in `apps.toml`).

```sh
pip install -r perf/compare/requirements.txt
python perf/compare/bench.py ~/src/spring-petclinic --runs 10
python perf/compare/bench.py ~/src/spring-petclinic --runs 5 --wipe-caches   # cold index
python perf/compare/bench.py ~/src/spring-petclinic --apps openidea_fork,idea  # the fork's macOS build
python perf/compare/bench.py --self-test   # checks the helpers, launches nothing
```

Each run launches the app on the project, waits until it is ready, opens the
project's `open_file` (if any), waits for the language server and for the CPU
to settle again, idles, closes it, and records:

| Metric                                      | How                                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `window_s`                                  | first visible window whose title matches `window_title` (the project name)                                            |
| `ready_s`                                   | the process tree's CPU stays under `--quiet-cores` for `--quiet-secs`, after the window and any `ready_after` markers |
| markers                                     | first/last time a log line matches, e.g. OpenIDEA `indexed`, IDEA `exit dumb mode`                                    |
| `lsp_s`, `open_ready_s`, `open_cpu_s`       | after `open_file`: until a process matching `language_server_process` appears; until the CPU settles; CPU it took     |
| `at_ready_mb`                               | the platform's memory metric (below) at ready, before `open_file`: what earlier runs reported                         |
| `peak_rss_mb`, `rss_mb`, `uss_mb`, `pss_mb` | summed over every process the app started (WebView2/WebKit, jdtls, language servers, the JVM)                         |
| `footprint_mb` (macOS), `private_mb` (Win)  | the same, as Activity Monitor and Task Manager count it                                                               |
| `by_category`                               | the memory per kind of process: `main`, `webview:*`, `lsp:<server>`, `jvm:<main class>`, or the process name          |
| `total_cpu_s`, `idle_cpu_pct`               | CPU time until ready; CPU while idle for `--idle-secs`                                                                |
| `exit_s`                                    | until every process has exited                                                                                        |
| `cache_mb`, install size                    | `cache_dirs`, `install_dir`                                                                                           |

Apps run interleaved, rotating the order, after `--warmup` unaggregated runs.
Every attempt, including warmups and failed launches, is retained in
`results/<time>-<project>-<unique>/`: `report.md`, `results.json`, and each
launched run's stdout. Reports are refreshed before and after each attempt
and on errors or interruption; separate invocations never overwrite each other.

The table shows median (min–max) and **valid/attempted** measured-trial counts
for every fixed metric, even when there are zero valid values. Only completely
valid trials enter aggregates; failed trials retain partial measurements and
explicit reasons in JSON and the attempts table. Warmups never enter medians
but a failed warmup still fails the suite. An empty or incomplete suite is not
successful.

Startup timeout, early exit/crash, observation/access errors, invalid or missing
required metrics, quit-command errors, forced termination, and interruption
produce a nonzero exit. JSON records `status`, `reasons`, `warmup`, and
`metric_status` (`valid`, `missing`, `invalid`, or `unsupported`). Nonfinite
numeric evidence is preserved as an `invalid_number` object, never JSON NaN.
Unsupported window observation, memory figures of other platforms (PSS off
Linux, footprint off macOS, Private bytes off Windows, USS that macOS denies),
the `open_file` metrics of a run without one, `lsp_s` for an app without
`language_server_process`, and unconfigured cache directories are explicit
exclusions rather than missing required values. Unobserved optional
log markers do not fail a trial; `ready_after` markers are required.

`--runs` must be positive; `--warmup` and `--cooldown` may be zero. Other
durations and the CPU threshold must be finite and positive, and the quiet
period cannot exceed the startup timeout.

Shutdown always runs after a launch, including observation errors and Ctrl-C.
`--close-timeout` bounds the quit command plus graceful wait; each forced cleanup
has at most two additional seconds to reap processes. `--command-timeout`
(default 60 seconds) bounds `--drop-os-cache`, including interactive commands.
Only processes attributed to the launch are terminated; preexisting instances
are refused, never killed. Configured `daemons` remain explicitly excluded from
shutdown and forced cleanup. POSIX launch-owned process groups retain orphaned
children; on Windows discovery uses the recorded process ancestry.

Run the small process-fixture regressions without launching an installed IDE:

```sh
python -m unittest discover -s perf/compare -p 'test_bench.py'
```

## Language servers and `open_file`

OpenIDEA starts a language server when the first file of its language is
opened, not when the project opens. Runs without an `open_file` (all runs before
this step existed, including the numbers in the top-level `README.md`) therefore
measured OpenIDEA without jdtls, pyright and the like, while IDEA's numbers
already included its in-process analysis. On a Java monorepo (macOS footprint) that was 234 MB at
ready against about 1,050 MB once a Java file was open and used.

Set `open_file` under `[projects.<directory name>]` in `apps.toml`, or pass
`--open-file <path>`; `--no-open-file` reproduces the old measurement. The
file is handed to the running app with `open -a` on macOS and by launching the
executable again on Windows and Linux (both apps forward it to the running
instance); `open_command` overrides that. Language servers are recognised from
the `[[language-servers]]` commands in `languages/*.toml`, plus jdtls.

Close all editor tabs before measuring: OpenIDEA restores the last session's
tabs, and a restored Java tab starts jdtls with the window, so `at_ready_mb`
then already includes it.

## Memory metric

The report leads with the figure each OS's own tools show, summed over the tree:

- macOS: `phys_footprint` (`proc_pid_rusage`, Activity Monitor's Memory column,
  includes compressed pages). USS needs the process's task port, which macOS
  denies for hardened-runtime apps without root, so `uss_mb` is empty there
  (earlier versions of this script silently dropped such processes from every
  sum, RSS included). RSS undercounts when memory is compressed or swapped.
- Linux: PSS. Windows: USS (Private bytes is recorded too).

## Fair runs

- Release builds only; a running instance of the same executable (a
  `pnpm tauri dev` build too) would take over the launch, so the script refuses.
- IDEA: open the project once by hand and trust it; turn off _Reopen projects
  on startup_ and _Confirm before exiting_; note the version, `-Xmx` and whether
  Shared Indexes were on.
- Same machine, power plan and plugged in; exclude the project and caches from
  antivirus scanning, or neither.
- `--drop-os-cache` runs a command before each launch for a cold OS cache:
  `sync; echo 3 | sudo tee /proc/sys/vm/drop_caches` (Linux), `sudo purge`
  (macOS), `RAMMap64.exe -Et` (Windows, admin).
- Typing latency is not covered: measure it on screen with Typometer for both.

## Platform notes

- Windows: windows via `user32`, closed with `WM_CLOSE`.
- macOS: windows via Quartz (`pyobjc-framework-Quartz`; titles need Screen
  Recording permission). WebKit helpers are children of launchd and are
  attributed through `responsibility_get_pid_responsible_for_pid`. Without that
  API, unrelated WebKit processes are not guessed by name/start time or killed.
- Linux: windows via `wmctrl` (X11). Without it `window_s` is skipped and
  readiness counts from launch.
