#!/bin/bash
# Orca automation precheck for the OpenIDEA fork: exit 0 when upstream has a newer release than develop's base and
# no run holds the fork's rebase/* lock, when a held lock went stale (a run died; the skill's step 0 handles it), or
# when a lock left for the user is obsolete (a newer release, or develop already on its version; step 0 retires it).
set -euo pipefail
name="OpenIDEA fork 自動 rebase"
trap 'rc=$?; m="precheck failed (exit $rc) at line $LINENO: $BASH_COMMAND"; echo "$m" >&2; "$HOME/.config/fork-automation/precheck-alert.sh" "$name" "$m" || true' ERR
# Why: a hiccup retries next hour; 6 h down (dead token, outage) blocks every rebase, so alert (once a day).
down="$HOME/.cache/fork-automation/openidea-rebase-precheck-down-since"
skipped=
trap '[ -n "$skipped" ] || rm -f "$down"' EXIT
skip() {
  skipped=1
  echo "$1; skipped"
  mkdir -p "${down%/*}"
  [ -e "$down" ] || touch "$down"
  if [ -n "$(find "$down" -mmin +360)" ]; then
    "$HOME/.config/fork-automation/precheck-alert.sh" "$name" "precheck 連續 6 小時以上失敗：$1" || true
  fi
  exit 1
}
cd "$HOME/Project/openidea"
git fetch -q fork develop || skip "git fetch fork failed"
git fetch -q origin --no-tags '+refs/tags/v*:refs/tags/v*' || skip "git fetch origin tags failed"
# Only a published GitHub Release counts, not every pushed tag.
newest=$(gh api repos/l0ng-ai/openidea/releases/latest --jq .tag_name) || skip "gh api releases/latest failed"
# Why no alert: an odd upstream tag is upstream's to fix, and its next release replaces it.
[[ $newest =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "latest upstream release tag '$newest' is not vX.Y.Z; skipped"; exit 1; }
base=$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude '*-fork*' fork/develop)
echo "upstream=$newest develop-base=$base"
newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }
locks=$(git ls-remote fork 'refs/heads/rebase/*') || skip "git ls-remote fork failed"
lock=$(head -1 <<<"$locks")
if [ -n "$lock" ]; then
  branch=${lock#*refs/heads/}
  held=${branch#rebase/}
  # Why stale after 6 h: a healthy run pushes or comments at every stage (longest gap: one CI round plus a release);
  # a dead one never resumes on its own.
  when=$(gh api "repos/audichuang/openidea/commits/${lock%%[[:space:]]*}" --jq .commit.committer.date) || skip "gh api lock commit failed"
  pr=$(gh pr list -R audichuang/openidea --head "$branch" --state open --json number,updatedAt --jq '.[0] // empty | "\(.number) \(.updatedAt)"') || skip "gh pr list failed"
  [ -n "$pr" ] && when=$(printf '%s\n%s\n' "$when" "${pr#* }" | sort | tail -1)
  # Why both: the automation runs on macOS (BSD date); precheck.test.sh also runs in Linux CI (GNU date).
  since=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$when" +%s 2>/dev/null || date -u -d "$when" +%s)
  age=$(( $(date +%s) - since ))
  waiting=0
  moved=0
  approved=-
  if [ -n "$pr" ]; then
    marks=$(gh pr view "${pr%% *}" -R audichuang/openidea --json comments --jq '[.comments[].body] | "\([.[] | select(startswith("<!-- auto-rebase:needs-human -->"))] | length) \([.[] | select(startswith("<!-- auto-rebase:develop-moved "))] | length) \([.[] | select(startswith("<!-- auto-rebase:approved "))] | last // "" | split(" ")[2] // "-")"') || skip "gh pr view failed"
    read -r waiting moved approved <<<"$marks"
  fi
  # Why before the obsolete check: the user may move develop onto the approved commit themselves, which makes the
  # lock look obsolete; the run must still release it. Only an approval of the current lock tip counts.
  if [ "$waiting" != 0 ] && [ "$moved" = 0 ] && [ "$approved" = "${lock%%[[:space:]]*}" ]; then
    echo "approved by the user: $branch at $approved"
    exit 0
  fi
  # Why moved first: once develop moved, a release is running (or died) whatever earlier comments say.
  if [ "$waiting" = 0 ] || [ "$moved" != 0 ]; then
    if [ "$age" -gt 21600 ]; then
      echo "stale lock: $branch (${age}s since last activity)"
      exit 0
    fi
    echo "in flight: $branch"
    exit 1
  fi
  # Why: a lock left for the user otherwise blocks every later release in silence; step 0 backs it up and retires it.
  if newer "$newest" "$held" || [ "$base" = "$held" ]; then
    echo "obsolete lock: $branch waits for the user, but upstream=$newest develop-base=$base"
    exit 0
  fi
  echo "waiting for the user: $branch"
  exit 1
fi
newer "$newest" "$base" || exit 1
