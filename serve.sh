#!/bin/bash
# Serve site/ locally, exactly as deployed (the playground image is kSTEP's build/cli, built by
# build.sh; PLAYGROUND_LOCAL=<build dir> overrides).
#   ./serve.sh [port]
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
"$W/build.sh"
echo "http://localhost:${1:-8080}/"
exec python3 -m http.server --bind 127.0.0.1 --directory "$W/site" "${1:-8080}"
