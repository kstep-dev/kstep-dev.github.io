#!/bin/bash
# Serve the browser UI locally with the kernels from $KSTEP_DIR/build: stage
# build/site (same layout as gh-pages) and run a plain static server. The
# service worker supplies the COOP/COEP headers.
#   ./serve.sh [port]
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
"$W/deploy.sh" --stage-only
echo "http://localhost:${1:-8080}/"
exec python3 -m http.server --bind 127.0.0.1 --directory "$W/build/site" "${1:-8080}"
