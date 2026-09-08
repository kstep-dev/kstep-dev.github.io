#!/bin/bash
# Run a kSTEP driver headless with emsdk's Node (Memory64 needs Node >= 24).
#   ./run.sh [--kernel sync_wakeup_buggy] [--driver sync_wakeup] [--smp 3] [--mem 512] [--out dir] [--quiet]
W=$(cd "$(dirname "$0")" && pwd)
node=$(ls -d "$W"/build/emsdk/node/*/bin/node 2>/dev/null | head -1)
exec "${node:-node}" --wasm-lazy-compilation "$W/run.mjs" "$@"
