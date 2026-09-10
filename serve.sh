#!/bin/bash
# Serve site/ locally, exactly as deployed (bug images from GitHub, the playground image from
# the kSTEP build dir; PLAYGROUND_LOCAL=<dir> overrides where it is taken from).
#   ./serve.sh [port]
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
"$W/build.sh"
echo "http://localhost:${1:-8080}/"
exec python3 -m http.server --bind 127.0.0.1 --directory "$W/site" "${1:-8080}"
