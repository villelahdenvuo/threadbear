#!/bin/sh
# After the owner says go: merges the release that
# `scripts/merge-preview.sh --prepare <dir>` worked out, and puts in the
# clashing files as they were settled under <dir>/files
# (docs/bringing-in-updates.md, section 4). Run it in the thread's own
# worktree. It stops, changing nothing, if the branch isn't where the
# preview had main; and it leaves the merge unfinished, saying which, if a
# file still has conflict markers or git clashes somewhere the preview
# didn't.
#
# Usage: scripts/merge-prepared.sh <dir> -m "<merge message>"
set -eu
dir=${1:?usage: scripts/merge-prepared.sh <dir> -m "<message>"}
[ "${2:-}" = "-m" ] && [ -n "${3:-}" ] || { echo 'usage: scripts/merge-prepared.sh <dir> -m "<message>"' >&2; exit 2; }
msg=$3
base=$(cat "$dir/base")
commit=$(cat "$dir/commit")
[ -f "$dir/clashes" ] || { echo "$dir has no prepared clashes: merge with git merge as usual." >&2; exit 2; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "The worktree has uncommitted changes: commit or drop them first." >&2; exit 1; }
# Every prepared file is settled before anything changes.
left=""
while IFS= read -r f; do
  [ -f "$dir/files/$f" ] || continue
  if grep -qE '^(<<<<<<<|>>>>>>>) ' "$dir/files/$f"; then left="$left $f"; fi
done < "$dir/clashes"
[ -z "$left" ] || { echo "Still has conflict markers under $dir/files:$left" >&2; exit 1; }
head=$(git rev-parse HEAD)
if [ "$head" != "$base" ]; then
  # A thread's branch starts from main as it was: catch it up first.
  if git merge-base --is-ancestor "$head" "$base"; then
    git merge -q --ff-only "$base"
  else
    echo "This branch isn't where the preview had main ($base): run scripts/merge-preview.sh --prepare again and settle what changed." >&2
    exit 1
  fi
fi
st=0
git merge --no-ff -m "$msg" "$commit" >/dev/null 2>&1 || st=$?
git diff --name-only --diff-filter=U | sort -u > "$dir/unmerged"
if [ "$st" -ne 0 ] && [ ! -s "$dir/unmerged" ]; then
  echo "git merge failed ($st) with no clashing files: see git status." >&2
  exit 1
fi
while IFS= read -r f; do
  if grep -qxF "$f" "$dir/clashes" && [ -f "$dir/files/$f" ]; then
    cp "$dir/files/$f" "$f"
    git add -- "$f"
  fi
done < "$dir/unmerged"
still=$(git diff --name-only --diff-filter=U)
if [ -n "$still" ]; then
  echo "Merged, with clashes the preview didn't settle; settle these, then git commit --no-edit:"
  printf '  %s\n' $still
  exit 1
fi
if [ "$st" -ne 0 ]; then git commit -q --no-edit; fi
# Settled files git merged by itself (a merge attribute here): say so,
# as what's in them may differ from what was settled.
while IFS= read -r f; do
  grep -qxF "$f" "$dir/unmerged" || echo "Note: git merged $f by itself here; the settled copy wasn't used."
done < "$dir/clashes"
echo "Merged $commit with the settled clashes: $(git rev-parse --short HEAD)."
