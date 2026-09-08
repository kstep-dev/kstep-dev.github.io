#!/bin/bash
# Run a kSTEP driver headless with emsdk's Node (Memory64 needs Node >= 24).
#   ./run.sh [--kernel v6.14] [--driver default] [--smp 2] [--out dir] [--quiet]
W=$(cd "$(dirname "$0")" && pwd)
node=$(ls -d "$W"/build/emsdk/node/*/bin/node 2>/dev/null | head -1)
exec "${node:-node}" --wasm-lazy-compilation "$W/run.mjs" "$@"
