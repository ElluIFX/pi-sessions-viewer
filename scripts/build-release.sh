#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version="$(tr -d '\r\n' < VERSION)"
commit="$(git rev-parse HEAD)"
build_date="$(git show -s --format=%cI HEAD)"
case "$version" in *[!a-zA-Z0-9.+-]*|'') echo 'Invalid VERSION' >&2; exit 1;; esac
out="${1:-dist}"
mkdir -p "$out"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1 go build -trimpath -buildvcs=false \
  -ldflags "-s -w -X main.version=$version -X main.commit=$commit -X main.buildDate=$build_date" \
  -o "$out/pi-sessions-viewer-linux-amd64" .
file "$out/pi-sessions-viewer-linux-amd64"
if readelf -l "$out/pi-sessions-viewer-linux-amd64" | grep -q INTERP; then
  echo 'Unexpected dynamic interpreter' >&2; exit 1
fi
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$out/pi-sessions-viewer-linux-amd64" "$stage/pi-sessions-viewer"
cp README.md docs/LINUX.md THIRD_PARTY_NOTICES.md "$stage/"
printf 'Version: %s\nCommit: %s\nBuild date: %s\nToolchain: %s\nTarget: linux/amd64 (GOAMD64=v1, CGO_ENABLED=0)\n' \
  "$version" "$commit" "$build_date" "$(go version)" > "$stage/BUILD-INFO.txt"
tar -czf "$out/pi-sessions-viewer-${version}-linux-amd64.tar.gz" -C "$stage" pi-sessions-viewer README.md LINUX.md THIRD_PARTY_NOTICES.md BUILD-INFO.txt
(cd "$out" && sha256sum pi-sessions-viewer-linux-amd64 "pi-sessions-viewer-${version}-linux-amd64.tar.gz" > SHA256SUMS)
