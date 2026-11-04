#!/bin/bash
# Scenario test for precheck.sh: fake git, gh and alert script in a temp HOME, one case per lock state.
# A broken precheck stops the hourly auto-rebase without a sound, so Fork CI runs this.
set -euo pipefail
precheck="$(cd "$(dirname "$0")" && pwd)/precheck.sh"
iso_ago() { node -e 'console.log(new Date(Date.now() - process.argv[1] * 3600e3).toISOString().replace(/\.\d+Z$/, "Z"))' "$1"; }
failed=0

# check <label> <want exit> <want alert 0|1> <newest> <base> <held lock|""> <"needs-human moved [approved sha]" marks> [age h] [fail] [stamp age h]
check() {
  local label=$1 want=$2 want_alert=$3 newest=$4 base=$5 held=$6 marks=$7 age=${8:-1} fail=${9:-} stamp=${10:-}
  # COMMENTS: PR comments JSON; when set, the fake gh runs precheck's real --jq filter on it instead of echoing marks.
  local comments=${COMMENTS:-}
  local t
  t=$(mktemp -d)
  mkdir -p "$t/Project/openidea" "$t/bin" "$t/.config/fork-automation" "$t/.cache/fork-automation"
  printf '#!/bin/bash\necho "ALERT $2"\n' > "$t/.config/fork-automation/precheck-alert.sh"
  cat > "$t/bin/git" <<EOF
#!/bin/bash
case "\$1" in
  describe) echo $base ;;
  ls-remote) [ -z "$held" ] || printf 'abc\trefs/heads/rebase/$held\n' ;;
esac
EOF
  cat > "$t/bin/gh" <<EOF
#!/bin/bash
[ "$fail" != fail ] || exit 1
case "\$*" in
  *releases/latest*) echo $newest ;;
  *commits/*) echo $(iso_ago "$age") ;;
  *"pr list"*) echo "7 $(iso_ago "$age")" ;;
  *"pr view"*)
    if [ -n '$comments' ]; then
      while [ \$# -gt 0 ]; do [ "\$1" = --jq ] && { jq -r "\$2" <<<'$comments'; exit; }; shift; done
    fi
    echo "$marks" ;;
esac
EOF
  chmod +x "$t/bin/"* "$t/.config/fork-automation/precheck-alert.sh"
  [ -z "$stamp" ] || touch -d "$(iso_ago "$stamp")" "$t/.cache/fork-automation/openidea-rebase-precheck-down-since"
  local out rc=0
  # Why env -u BASH_ENV: a BASH_ENV toolchain file rebuilds PATH for the fake HOME and puts the real gh first.
  out=$(HOME=$t PATH="$t/bin:$PATH" env -u BASH_ENV bash "$precheck" 2>&1) || rc=$?
  local alerted=0
  grep -q '^ALERT' <<<"$out" && alerted=1
  rm -rf "$t"
  if [ "$rc" != "$want" ] || [ "$alerted" != "$want_alert" ]; then
    echo "FAIL $label: exit $rc (want $want), alert $alerted (want $want_alert)"
    sed 's/^/    /' <<<"$out"
    failed=1
  else
    echo "ok   $label"
  fi
}

check "no lock, newer release"          0 0 v0.1.35 v0.1.34 ""      ""
check "no lock, same release"           1 0 v0.1.34 v0.1.34 ""      ""
check "no lock, 0.1.9 vs 0.1.10"        0 0 v0.1.10 v0.1.9  ""      ""
check "waiting lock superseded"         0 0 v0.1.36 v0.1.34 v0.1.35 "1 0"
check "waiting lock current"            1 0 v0.1.35 v0.1.34 v0.1.35 "1 0"
check "waiting lock, develop moved"     0 0 v0.1.35 v0.1.35 v0.1.35 "1 0"
check "releasing, fresh"                1 0 v0.1.35 v0.1.35 v0.1.35 "1 1" 1
check "releasing, stale"                0 0 v0.1.35 v0.1.35 v0.1.35 "1 1" 8
check "in flight, fresh"                1 0 v0.1.36 v0.1.35 v0.1.36 "0 0" 1
check "in flight, stale"                0 0 v0.1.36 v0.1.35 v0.1.36 "0 0" 8
check "gh down, first hour"             1 0 v0.1.36 v0.1.35 ""      ""    1 fail
check "gh down 2 h"                     1 0 v0.1.36 v0.1.35 ""      ""    1 fail 2
check "gh down 7 h"                     1 1 v0.1.36 v0.1.35 ""      ""    1 fail 7
check "odd release tag"                 1 0 nightly-1 v0.1.35 ""    ""
check "approved lock tip"               0 0 v0.1.35 v0.1.34 v0.1.35 "1 0 abc"
check "approved, develop already moved" 0 0 v0.1.35 v0.1.35 v0.1.35 "1 0 abc"
check "approved an older tip"           1 0 v0.1.35 v0.1.34 v0.1.35 "1 0 def"
check "approved, then develop-moved"    1 0 v0.1.35 v0.1.35 v0.1.35 "1 1 abc" 1
check "approved, released run died"     0 0 v0.1.35 v0.1.35 v0.1.35 "1 1 abc" 8
COMMENTS='{"comments":[{"body":"<!-- auto-rebase:needs-human -->\\nlook"},{"body":"<!-- auto-rebase:approved abc -->\\nok"}]}' \
  check "real filter: approved tip"     0 0 v0.1.35 v0.1.34 v0.1.35 ""
COMMENTS='{"comments":[{"body":"<!-- auto-rebase:needs-human -->"},{"body":"<!-- auto-rebase:approved def -->"}]}' \
  check "real filter: approved old tip" 1 0 v0.1.35 v0.1.34 v0.1.35 ""
COMMENTS='{"comments":[{"body":"<!-- auto-rebase:needs-human -->"}]}' \
  check "real filter: not approved"     1 0 v0.1.35 v0.1.34 v0.1.35 ""
NH='{"body":"<!-- auto-rebase:needs-human -->"}'
AP='{"body":"<!-- auto-rebase:approved abc -->"}'
COMMENTS="{\"comments\":[$NH,$AP,$NH]}" \
  check "real filter: approval rejected, lock current"  1 0 v0.1.35 v0.1.34 v0.1.35 ""
COMMENTS="{\"comments\":[$NH,$AP,$NH,$AP]}" \
  check "real filter: re-approved after rejection"      0 0 v0.1.35 v0.1.34 v0.1.35 ""
COMMENTS="{\"comments\":[$NH,$AP,$NH]}" \
  check "real filter: approval rejected, upstream newer" 0 0 v0.1.36 v0.1.34 v0.1.35 ""
exit "$failed"
