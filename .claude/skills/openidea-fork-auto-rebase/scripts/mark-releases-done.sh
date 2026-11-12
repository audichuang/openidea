#!/usr/bin/env bash
# Mark the user's GitHub release notifications for l0ng-ai/openidea up to and
# including the given tag as Done, so an empty inbox means the fork caught up.
# Usage: mark-releases-done.sh vX.Y.Z
set -euo pipefail

target=${1:?usage: mark-releases-done.sh vX.Y.Z}
[[ $target =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a release tag: $target" >&2; exit 2; }

# Succeeds when $1 <= $2 (both vX.Y.Z).
not_newer() {
  [[ $(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1) == "$1" ]]
}

done_count=0
failed=0
while read -r id url; do
  [[ -n $id && $url != null ]] || continue
  tag=$(gh api "$url" --jq .tag_name 2>/dev/null) || continue
  [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  not_newer "$tag" "$target" || continue
  if gh api -X DELETE "notifications/threads/$id" --silent; then
    echo "done $tag"
    done_count=$((done_count + 1))
  else
    echo "failed $tag ($id)" >&2
    failed=1
  fi
done < <(gh api 'notifications?all=true&per_page=100' \
  --jq '.[] | select(.repository.full_name=="l0ng-ai/openidea" and .subject.type=="Release") | "\(.id) \(.subject.url)"')

echo "marked $done_count notification(s) done up to $target"
exit "$failed"
