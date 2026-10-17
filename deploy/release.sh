#!/bin/sh
# A release of Rommancer that installs without git: the source at HEAD plus the client apps built into
# clients/*/release (not in git), as dist-release/rommancer.tar.gz and rommancer.zip. With --publish it tags
# vVERSION and puts both on a GitHub release, so .../releases/latest/download/rommancer.tar.gz is always the newest.
#   deploy/release.sh [VERSION] [--publish]      VERSION defaults to the last tag with its minor number + 1
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
REPO=doctor-utsugi/rommancer

VERSION='' PUBLISH=''
for a in "$@"; do
  case "$a" in
    --publish) PUBLISH=1 ;;
    v[0-9]* | [0-9]*) VERSION=${a#v} ;;
    *) sed -n '2,5p' "$0"; exit 2 ;;
  esac
done
if [ -z "$VERSION" ]; then
  last=$(git tag -l 'v[0-9]*' --sort=-v:refname | head -n 1)
  last=${last#v}
  major=${last%%.*} rest=${last#*.}
  VERSION="${major:-0}.$((${rest%%.*} + 1)).0"
fi
git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && { echo "v$VERSION exists already" >&2; exit 1; }

OUT="$ROOT/dist-release"
rm -rf "$OUT"
mkdir -p "$OUT/stage"
git archive --prefix=rommancer/ HEAD | tar -x -C "$OUT/stage"
echo "$VERSION" > "$OUT/stage/rommancer/VERSION"

# The apps the server hands to devices; an app built from older sources still ships, with a warning
for app in android desktop; do
  if [ -f "clients/$app/release/version.txt" ]; then
    mkdir -p "$OUT/stage/rommancer/clients/$app/release"
    cp -p "clients/$app/release/"* "$OUT/stage/rommancer/clients/$app/release/"
  else
    echo "warning: clients/$app/release is empty; the server will not offer the $app app" >&2
  fi
done
built=$(sed 's/.* //' clients/android/release/version.txt 2>/dev/null || true)
source=$(sed -n 's/.*versionName *= *"\(.*\)".*/\1/p' clients/android/app/build.gradle* 2>/dev/null | head -n 1)
[ "$built" = "$source" ] || echo "warning: the Android app built is $built, its source says $source" >&2
built=$(cat clients/desktop/release/version.txt 2>/dev/null || true)
source=$(sed -n 's/^ *"version": *"\(.*\)".*/\1/p' clients/desktop/src-tauri/tauri.conf.json | head -n 1)
[ "$built" = "$source" ] || echo "warning: the desktop app built is $built, its source says $source" >&2

tar -czf "$OUT/rommancer.tar.gz" -C "$OUT/stage" rommancer
(cd "$OUT/stage" && zip -qr ../rommancer.zip rommancer)
rm -rf "$OUT/stage"
ls -lh "$OUT"
echo "Rommancer $VERSION ($(git rev-parse --short HEAD))"

[ -n "$PUBLISH" ] || exit 0
git branch -r --contains HEAD | grep -q 'origin/main' || { echo "push HEAD to origin/main first" >&2; exit 1; }
TOKEN_FILE="$HOME/.config/git-tokens/github-doctor-utsugi"
[ -f "$TOKEN_FILE" ] && GH_TOKEN=$(cat "$TOKEN_FILE") && export GH_TOKEN
git tag -a "v$VERSION" -m "Rommancer $VERSION"
git push -q origin "v$VERSION"
gh release create "v$VERSION" -R "$REPO" --title "Rommancer $VERSION" --notes "$(cat <<EOF
Install on a Linux server with Podman, no git needed:

\`\`\`bash
curl -fsSL https://github.com/$REPO/releases/latest/download/rommancer.tar.gz | tar xz
sh rommancer/deploy/podman/rommancer.sh install
\`\`\`

\`rommancer.zip\` holds the same. To update, extract the new release over the old folder and run
\`rommancer.sh build\` and \`rommancer.sh up\`: your settings and data live outside it.
EOF
)" "$OUT/rommancer.tar.gz" "$OUT/rommancer.zip"
