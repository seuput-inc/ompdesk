#!/usr/bin/env bash
# Deletes every published release of $GH_REPO except the newest `latest` and the tags .github/release-keep.json names
# (the owner's rule, 17 Nov 2026: old releases are not kept around). Only the release and its assets go; the git tag
# stays. `--dry-run` prints what would go. With $TAG set (release.yml's publish), the newest release must be that tag,
# so a run that did not just publish never prunes.
set -euo pipefail

dry=${1:-}
keep_file=.github/release-keep.json
latest=$(jq -er '.latest' "$keep_file")
[ "$latest" -ge 1 ] || { echo "::error::$keep_file: latest must be at least 1"; exit 1; }
keep=$(jq -er '.keep | keys[]' "$keep_file")

# Newest first by creation; drafts are not published releases and stay as they are.
releases=$(gh api --paginate "repos/$GH_REPO/releases?per_page=100" \
  --jq '.[] | select(.draft == false) | [.created_at, .tag_name] | @tsv' | sort -r | cut -f2)
newest=$(head -n 1 <<<"$releases")
if [ "$dry" != --dry-run ] && [ -n "${TAG:-}" ] && [ "$newest" != "$TAG" ]; then
  echo "::error::the newest release is $newest, not $TAG: nothing pruned"
  exit 1
fi

i=0
while IFS= read -r tag; do
  [ -n "$tag" ] || continue
  i=$((i + 1))
  if [ "$i" -le "$latest" ] || grep -qxF "$tag" <<<"$keep"; then
    echo "keep $tag"
  elif [ "$dry" = --dry-run ]; then
    echo "would delete $tag"
  else
    gh release delete "$tag" --yes
    echo "deleted $tag (tag kept)"
  fi
done <<<"$releases"
