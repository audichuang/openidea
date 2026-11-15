#!/usr/bin/env bash
# PreToolUse(Bash) guard: refuse `gh pr merge` into the fork while an auto-rebase lock holds work.
# A lock is a fork `rebase/*` branch whose tip is not `develop` yet (develop has not moved onto it).
# Merging then breaks the lock's lease push and forces carrying every merged commit onto the lock
# (FORK.md "Auto-rebase"; 2026-11-15: 36 commits carried by hand onto rebase/v0.1.45).
# Override for one command: prefix it with OPENIDEA_MERGE_DURING_LOCK=1 after the user agreed.
set -u
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
case "$cmd" in *"gh pr merge"*) ;; *) exit 0 ;; esac
case "$cmd" in *OPENIDEA_MERGE_DURING_LOCK=1*) exit 0 ;; esac
# Only the fork: an explicit -R, or no -R while inside this repo.
case "$cmd" in
  *"-R "*|*"--repo "*) case "$cmd" in *audichuang/openidea*) ;; *) exit 0 ;; esac ;;
esac
remote=${OPENIDEA_FORK_REMOTE:-https://github.com/audichuang/openidea}  # override only for tests
refs=$(git ls-remote "$remote" 'refs/heads/rebase/*' 'refs/heads/develop' 2>/dev/null) || exit 0
develop=$(printf '%s\n' "$refs" | awk '$2=="refs/heads/develop"{print $1}')
held=$(printf '%s\n' "$refs" | awk -v d="$develop" '$2 ~ /^refs\/heads\/rebase\// && $1 != d {sub("refs/heads/","",$2); print $2}')
[ -z "$held" ] && exit 0
reason="An auto-rebase lock holds work: $(echo $held). Merging into develop now breaks its lease and forces carrying the merged commits onto the lock (FORK.md). Tell the user and ask: wait until the release moves develop, or merge and carry. If they choose to merge, rerun the command with OPENIDEA_MERGE_DURING_LOCK=1 in front."
jq -n --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
