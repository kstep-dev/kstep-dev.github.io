#!/bin/bash
# Serve site/ locally, exactly as deployed (kernel images come from GitHub):
#   ./serve.sh [port]
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
"$W/deploy.sh" --stage-only
echo "http://localhost:${1:-8080}/"
exec python3 -m http.server --bind 127.0.0.1 --directory "$W/site" "${1:-8080}"
