# Shared environment for build.sh / run.mjs / serve.py. Source it from bash:
#   source env.sh
W=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export KSTEP_DIR="${KSTEP_DIR:-$W/../kstep}"          # kstep checkout with build/<kernel>/{kernel,rootfs.cpio}
export QEMU_TAG=v11.1.0                                # release the patches/ apply to
export EMSDK_VERSION=4.0.23
source "$W/build/emsdk/emsdk_env.sh" >/dev/null 2>&1 || true
export PATH="$W/build/venv/bin:$PATH"
export NODE="$(ls -d "$W"/build/emsdk/node/*/bin/node 2>/dev/null | head -1)"
export TARGET="$W/build/deps/target"
export CPATH="$TARGET/include"
export PKG_CONFIG_PATH="$TARGET/lib/pkgconfig"
export EM_PKG_CONFIG_PATH="$PKG_CONFIG_PATH"
