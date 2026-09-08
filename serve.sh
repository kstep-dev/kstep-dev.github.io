#!/bin/bash
# Serve the browser UI locally: stage build/site (same layout as gh-pages) and
# run a plain static server. The service worker supplies the COOP/COEP headers.
#   ./serve.sh [port] [kernel ...]
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
port=${1:-8080}; shift || true
"$W/deploy.sh" --stage-only "$@"
echo "http://localhost:$port/"
exec python3 -m http.server --bind 127.0.0.1 --directory "$W/build/site" "$port"
