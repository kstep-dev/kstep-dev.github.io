#!/bin/bash
# Serve site/ locally, as deployed (bug images come from GitHub). The playground image is
# taken from the local kSTEP build dir (../../build/cli) when it exists there, since the
# published build repo has no `cli` image yet; PLAYGROUND_LOCAL=<dir> overrides.
#   ./serve.sh [port]
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
LOCAL=$W/../../build/cli
[ -z "${PLAYGROUND_LOCAL:-}" ] && [ -f "$LOCAL/kernel" ] && export PLAYGROUND_LOCAL=$LOCAL
"$W/deploy.sh" --stage-only
echo "http://localhost:${1:-8080}/"
exec python3 -m http.server --bind 127.0.0.1 --directory "$W/site" "${1:-8080}"
