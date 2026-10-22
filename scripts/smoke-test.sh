#!/usr/bin/env bash
set -euo pipefail
binary="$(realpath "${1:-dist/pi-sessions-viewer-linux-amd64}")"
tmp="$(mktemp -d)"
pid=''
cleanup() { if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi; rm -rf "$tmp"; }
trap cleanup EXIT
mkdir -p "$tmp/sessions/--demo--"
cat > "$tmp/sessions/--demo--/smoke.jsonl" <<'JSONL'
{"type":"session","id":"smoke","version":3,"timestamp":"2026-01-01T00:00:00Z","cwd":"/demo"}
{"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":[{"type":"text","text":"Offline smoke test"}]}}
{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"Ready without Go or external assets."}],"usage":{"totalTokens":12,"cost":{"total":0}}}}
JSONL
port="${SMOKE_PORT:-27891}"
"$binary" -version
"$binary" -host 127.0.0.1 -p "$port" -sessions-dir "$tmp/sessions" > "$tmp/server.log" 2>&1 &
pid=$!
base="http://127.0.0.1:$port"
for i in $(seq 1 50); do
  if curl --silent --fail "$base/" > "$tmp/index.html"; then break; fi
  kill -0 "$pid" 2>/dev/null || { cat "$tmp/server.log"; exit 1; }
  sleep 0.1
done
curl --silent --show-error --fail "$base/" > "$tmp/index.html"
grep -q 'smoke.jsonl' "$tmp/index.html"
curl --silent --show-error --fail "$base/session?id=--demo--%2Fsmoke.jsonl" > "$tmp/session.html"
curl --silent --show-error --fail "$base/api/session?id=--demo--%2Fsmoke.jsonl" | grep -q 'Offline smoke test'
curl --silent --show-error --fail "$base/export?id=--demo--%2Fsmoke.jsonl" > "$tmp/export.html"
grep -q '<html' "$tmp/export.html"
if grep -q '{{SESSION_DATA}}\|{{MARKED_JS}}\|{{CSS}}' "$tmp/export.html"; then echo 'Unresolved embedded assets'; exit 1; fi
code="$(curl --silent -o /dev/null -w '%{http_code}' -X POST "$base/share?id=--demo--%2Fsmoke.jsonl")"
[[ "$code" == 403 ]] || { echo "Sharing must be disabled; got $code"; exit 1; }
echo 'Smoke test passed: dashboard, reader, JSON API, offline export, disabled sharing.'
