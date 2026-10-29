#!/usr/bin/env bash
# Seeds the shadow's data branch from the data directory of the recorder that ran before (docs/switch-over.md).
# Run it only after that recorder is stopped, so that the copy is its last state, and before the next run. It refuses
# a remote that already has the branch, and never force-pushes.
#   bash seed-data-branch.sh <PC data dir> <remote name or URL> <recorder commit> [branch]
# A remote name (such as origin) is read from the checkout the script is run in. It needs only git and coreutils
# (Git for Windows' bash has both).
# Layout: state.json and known/ at the root, as the recorder keeps them; the PC's captures/, osv/ and status/ under
# runs/pc-<commit>/. A day file over 50,000,000 bytes is cut at line ends into <day>.partNN.jsonl (GitHub refuses
# files over 100 MiB), so every *.jsonl under a kind directory is read in name order.
set -euo pipefail
src=$1 remote=$2 commit=$3 branch=${4:-shadow-data}
# The push runs in a new repository, which has no remotes: take the URL here.
if url=$(git remote get-url "$remote" 2> /dev/null); then remote=$url; fi
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "The recorder commit must be a full SHA." >&2; exit 1; }
[ -f "$src/state.json" ] && [ -d "$src/known" ] || { echo "No state.json and known/ in ${src}." >&2; exit 1; }
# The feed position and start, from the recorder's one-line state.json. Without them the workflow refuses the branch.
seq=$(sed -n 's/.*"seq":"\([0-9][0-9]*\)".*/\1/p' "$src/state.json")
started=$(sed -n 's/.*"feed_started_at":"\([^"]*\)".*/\1/p' "$src/state.json")
[ -n "$seq" ] && [ -n "$started" ] || { echo "state.json has no feed position and feed start." >&2; exit 1; }
rc=0; git ls-remote --exit-code "$remote" "refs/heads/${branch}" > /dev/null || rc=$?
if [ "$rc" -eq 0 ]; then echo "${branch} already exists on ${remote}. Nothing pushed." >&2; exit 1; fi
if [ "$rc" -ne 2 ]; then echo "Could not read ${remote} (git ls-remote exit ${rc}). Nothing pushed." >&2; exit 1; fi

work=$(mktemp -d)
git -C "$work" init -q -b "$branch"
# Store the recorder's bytes as they are, whatever the user's line-ending settings (Git for Windows sets autocrlf).
git -C "$work" config core.autocrlf false
cp "$src/state.json" "$work/state.json"
cp -R "$src/known" "$work/known"
run="runs/pc-${commit:0:7}"
for kind in captures osv status; do
  [ -d "$src/$kind" ] || continue
  mkdir -p "$work/$run/$kind"
  for f in "$src/$kind"/*.jsonl; do
    if [ "$(stat -c %s "$f")" -gt 50000000 ]; then
      split -C 50000000 -d --additional-suffix=.jsonl "$f" "$work/$run/$kind/$(basename "$f" .jsonl).part"
    else
      cp "$f" "$work/$run/$kind/"
    fi
  done
done
# A crash can leave a .tmp file beside a known/ file or state.json; the recorder never reads one.
find "$work" -type f -name '*.tmp' -not -path "$work/.git/*" -print -delete
bad=$(find "$work" -path "$work/.git" -prune -o -type f -size +50000000c -print)
[ -z "$bad" ] || { echo "Files still over 50,000,000 bytes: ${bad}" >&2; exit 1; }
git -C "$work" add -A
git -C "$work" -c user.name="Ludion-ai" -c user.email="292738933+Ludion-ai@users.noreply.github.com" \
  commit -q -m "shadow: the PC recorder's data at ${commit:0:7}, seq ${seq}, feed start ${started}"
git -C "$work" push -q "$remote" "HEAD:refs/heads/${branch}"
echo "Pushed ${branch}: $(git -C "$work" rev-parse HEAD), $(git -C "$work" ls-files | wc -l) files, $(du -sb --exclude=.git "$work" | cut -f1) bytes."
