#!/bin/bash
# One-time setup: build qemu-system-aarch64 for a wasm64 host, end to end.
#   ./setup.sh            # all stages
#   ./setup.sh qemu       # just reconfigure+rebuild QEMU
# Stages: setup (apt, emsdk) -> deps (zlib, libffi, glib; QEMU needs zlib and glib, the wasm JIT
# calls helpers through libffi; pixman is a disabled feature in this build) -> qemu.
# Output: site/qemu/ (qemu-system-aarch64.{js,wasm}; the virt machine needs no firmware), served/deployed as-is.
# Needed once per checkout; build.py assembles the site around what this leaves behind.
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
stage=${1:-all}
mkdir -p "$W/build"
# QEMU is the qemu/ submodule: https://github.com/kstep-dev/qemu, branch kstep = upstream
# v11.1.1 + Kohei Tokunaga's wasm64 JIT backend (squashed from ktock/qemu wasm64-tcg-b) + the
# kSTEP tuning commit (1 GB heap, INSTANTIATE_NUM 300, 4 virtio-mmio slots, the kstep device set).
EMSDK_VERSION=6.0.10

toolchain() {  # emsdk and the cross-built deps prefix
  source "$W/build/emsdk/emsdk_env.sh" >/dev/null 2>&1
  export TARGET="$W/build/deps/target" CPATH="$W/build/deps/target/include"
  export PKG_CONFIG_PATH="$TARGET/lib/pkgconfig" EM_PKG_CONFIG_PATH="$TARGET/lib/pkgconfig"
}

setup() {
  sudo apt-get install -y -q autoconf build-essential libglib2.0-dev libtool pkgconf ninja-build
  [ -d "$W/build/emsdk" ] || git clone -q --depth 1 https://github.com/emscripten-core/emsdk.git "$W/build/emsdk"
  # after a version bump, also rm -rf build/deps qemu/build: they keep objects of the old SDK
  (cd "$W/build/emsdk" && git pull -q && ./emsdk install $EMSDK_VERSION && ./emsdk activate $EMSDK_VERSION)
}

# Mirrors upstream tests/docker/dockerfiles/emsdk-wasm64-cross.docker, without Docker; glib's meson
# build reads cross.meson next to this script.
deps() {
  toolchain
  export CFLAGS="-O3 -pthread -DWASM_BIGINT -sMEMORY64=1" CXXFLAGS="-O3 -pthread -DWASM_BIGINT -sMEMORY64=1"
  export LDFLAGS="-sWASM_BIGINT -sASYNCIFY=1 -L$TARGET/lib -sMEMORY64=1"
  meson() { uvx --from meson==1.5.0 meson "$@"; }   # glib's build system (QEMU brings its own)
  link_args="[$(printf "'%s', " $LDFLAGS | sed 's/, $//')]"   # LDFLAGS as a meson array
  mkdir -p "$TARGET" "$W/build/deps" && cd "$W/build/deps"
  if [ ! -f "$TARGET/lib/libz.a" ]; then
    mkdir -p zlib && curl -Ls https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.xz | tar xJC zlib --strip-components=1
    (cd zlib && emconfigure ./configure --prefix="$TARGET" --static && emmake make install -j"$(nproc)")
  fi
  if [ ! -f "$TARGET/lib/libffi.a" ]; then
    [ -d libffi ] || git clone -q --depth 1 -b v3.5.2 https://github.com/libffi/libffi
    (cd libffi && autoreconf -fiv && emconfigure ./configure --host=wasm64-unknown-linux --prefix="$TARGET" \
      --enable-static --disable-shared --disable-dependency-tracking --disable-builddir \
      --disable-multi-os-directory --disable-raw-api --disable-docs && emmake make install SUBDIRS='include' -j"$(nproc)")
  fi
  if [ ! -f "$TARGET/lib/libglib-2.0.a" ]; then
    printf '#include <netdb.h>\nint res_query(const char *n, int c, int t, unsigned char *d, int l) { h_errno = HOST_NOT_FOUND; return -1; }\n' > res_query.c
    emcc $CFLAGS -c res_query.c -o res_query.o && emar rcs "$TARGET/lib/libresolv.a" res_query.o
    [ -d glib ] || { mkdir glib && curl -Ls https://download.gnome.org/sources/glib/2.84/glib-2.84.0.tar.xz | tar xJC glib --strip-components=1; }
    (cd glib && rm -rf _build && meson setup _build --prefix="$TARGET" --cross-file="$W/cross.meson" \
      -Dc_link_args="$link_args" -Dcpp_link_args="$link_args" \
      --default-library=static --buildtype=release --force-fallback-for=pcre2 \
      -Dselinux=disabled -Dlibelf=disabled -Dxattr=false -Dlibmount=disabled -Dnls=disabled \
      -Dtests=false -Dglib_debug=disabled -Dglib_assert=false -Dglib_checks=false \
      && sed -i -E "/#define HAVE_POSIX_SPAWN 1/d;/#define HAVE_PTHREAD_GETNAME_NP 1/d" _build/config.h \
      && meson install -C _build)
  fi
}

qemu() {
  toolchain
  export CFLAGS="-O3 -pthread -DWASM_BIGINT" CXXFLAGS="-O3 -pthread -DWASM_BIGINT" LDFLAGS="-sWASM_BIGINT -sASYNCIFY=1 -L$TARGET/lib"
  src="$W/qemu"
  [ -f "$src/configure" ] || git -C "$W" submodule update --init --depth 1 qemu
  mkdir -p "$src/build" && cd "$src/build"
  emconfigure ../configure --static --cpu=wasm64 --enable-wasm64-32bit-address-limit --cross-prefix= \
    --target-list=aarch64-softmmu --without-default-devices --with-devices-aarch64=kstep \
    --enable-system --disable-user --disable-tools --disable-docs \
    --without-default-features --with-coroutine=wasm \
    --extra-cflags="-O3 -g0 -matomics -mbulk-memory -DNDEBUG -sASYNCIFY=1 -pthread -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sWASM_BIGINT -sMALLOC=mimalloc"
  emmake make -j"$(nproc)"
  mkdir -p "$W/site/qemu"
  rm -f "$W/site/qemu"/* && cp qemu-system-aarch64.js qemu-system-aarch64.wasm "$W/site/qemu/"
  ls -la "$W/site/qemu"
}

case $stage in
  all) setup; deps; qemu ;;
  setup|deps|qemu) $stage ;;
  *) echo "usage: $0 [all|setup|deps|qemu]"; exit 1 ;;
esac
