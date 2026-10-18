#!/bin/sh
# A release of Rommancer that installs without git: the source at HEAD plus the client apps built into
# clients/*/release (not in git), as dist-release/rommancer.tar.gz and rommancer.zip. With --publish it builds the
# images (for x86_64 and ARM) and pushes them to ghcr.io, where installs and updates download them instead of building,
# then tags vVERSION and puts both files and get.sh on a GitHub release, so .../releases/latest/download/ is always
# the newest.
# CHANGELOG.md needs an entry "## VERSION (DATE)": it becomes the release's notes, which servers show before updating.
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
    *) sed -n '2,6p' "$0"; exit 2 ;;
  esac
done
if [ -z "$VERSION" ]; then
  last=$(git tag -l 'v[0-9]*' --sort=-v:refname | head -n 1)
  last=${last#v}
  major=${last%%.*} rest=${last#*.}
  VERSION="${major:-0}.$((${rest%%.*} + 1)).0"
fi
git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && { echo "v$VERSION exists already" >&2; exit 1; }

# This version's entry in CHANGELOG.md as committed: from its heading to the next one
NOTES=$(git show HEAD:CHANGELOG.md 2>/dev/null | awk -v v="$VERSION" '
  /^## / { if (found) exit; if (index($0, "## " v " ") == 1 || $0 == "## " v) { found = 1; next } }
  found { print }' | sed -e '/./,$!d')
[ -n "$NOTES" ] || { echo "CHANGELOG.md has no entry \"## $VERSION ($(date +%F))\": write it and commit it first" >&2; exit 1; }

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
cp deploy/get.sh "$OUT/get.sh"
echo "Rommancer $VERSION ($(git rev-parse --short HEAD))"

[ -n "$PUBLISH" ] || { rm -rf "$OUT/stage"; ls -lh "$OUT"; exit 0; }
git branch -r --contains HEAD | grep -q 'origin/main' || { echo "push HEAD to origin/main first" >&2; exit 1; }
TOKEN_FILE="$HOME/.config/git-tokens/github-doctor-utsugi"
[ -f "$TOKEN_FILE" ] && GH_TOKEN=$(cat "$TOKEN_FILE") && export GH_TOKEN
[ -n "${GH_TOKEN:-}" ] || GH_TOKEN=$(gh auth token -u "${REPO%%/*}") && export GH_TOKEN

# The images, from the same files as the tar, before the release exists: an update never finds a release without them
REGISTRY=ghcr.io/${REPO%%/*}
printf '%s' "$GH_TOKEN" | podman login ghcr.io -u "${REPO%%/*}" --password-stdin >/dev/null
for i in mysql:deploy/mysql api:backend web:frontend; do
  name=$REGISTRY/rommancer-${i%%:*}
  podman manifest rm "$name:$VERSION" >/dev/null 2>&1 || true
  podman build --platform linux/amd64,linux/arm64 --manifest "$name:$VERSION" \
    --label "org.opencontainers.image.source=https://github.com/$REPO" --label "org.opencontainers.image.version=$VERSION" \
    -f "$OUT/stage/rommancer/${i#*:}/Containerfile" "$OUT/stage/rommancer"
  podman manifest push --all "$name:$VERSION" "docker://$name:$VERSION"
  podman manifest push --all "$name:$VERSION" "docker://$name:latest"
  podman manifest rm "$name:$VERSION" >/dev/null 2>&1 || true
done
rm -rf "$OUT/stage"
ls -lh "$OUT"
git tag -a "v$VERSION" -m "Rommancer $VERSION"
git push -q origin "v$VERSION"
gh release create "v$VERSION" -R "$REPO" --title "Rommancer $VERSION" --notes "$(cat <<EOF
$NOTES

---

Installs on Linux and macOS with one command, then finishes in the browser:

\`\`\`bash
curl -fsSL https://github.com/$REPO/releases/latest/download/get.sh | sh
\`\`\`

\`rommancer.zip\` holds the same, for Windows. macOS, Windows and updating:
https://github.com/$REPO/blob/v$VERSION/docs/install.md
EOF
)" "$OUT/rommancer.tar.gz" "$OUT/rommancer.zip" "$OUT/get.sh"
