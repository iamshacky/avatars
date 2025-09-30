#!/usr/bin/env bash
set -euo pipefail
HOST=${HOST:-http://localhost:${PORT:-8080}}
echo "[smoke] healthz:"
curl -s "$HOST/healthz" | jq .
echo "[smoke] tts headers:"
curl -s -I "$HOST/api/tts?text=ping" | sed -n '1,20p'
