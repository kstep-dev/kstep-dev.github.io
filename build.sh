#!/bin/bash
# Build qemu-system-x86_64 for a wasm64 host, end to end:
#   ./build.sh            # all stages
#   ./build.sh qemu       # just reconfigure+rebuild QEMU
# Stages: setup (apt, emsdk, meson) -> deps (zlib, libffi, pixman, glib) -> qemu.
# Output: build/qemu/build/qemu-system-x86_64.{js,wasm}
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
stage=${1:-all}
mkdir -p "$W/build"
# Kohei Tokunaga's QEMU branch carrying the wasm JIT backend (QEMU 10.2.50 + his 33
# commits), pinned to a commit. The same commits rebased onto the v11.1.0 release built
# and ran, but x86_64 guests then hit an intermittent init-time NULL dereference in kSTEP
# that the original branch never does, so the original is used until that is understood.
QEMU_REPO=https://github.com/ktock/qemu
QEMU_BRANCH=wasm64-tcg-b
QEMU_COMMIT=8f1406ba3307a10c58be24a8ff00ab6a5d3b6169
EMSDK_VERSION=4.0.23

toolchain() {  # emsdk, meson venv, and the cross-built deps prefix
  source "$W/build/emsdk/emsdk_env.sh" >/dev/null 2>&1
  export PATH="$W/build/venv/bin:$PATH"
  export TARGET="$W/build/deps/target" CPATH="$W/build/deps/target/include"
  export PKG_CONFIG_PATH="$TARGET/lib/pkgconfig" EM_PKG_CONFIG_PATH="$TARGET/lib/pkgconfig"
}

setup() {
  sudo apt-get install -y -q autoconf build-essential libglib2.0-dev libtool pkgconf ninja-build python3-pip python3-venv
  if [ ! -d "$W/build/emsdk" ]; then
    git clone -q --depth 1 https://github.com/emscripten-core/emsdk.git "$W/build/emsdk"
    (cd "$W/build/emsdk" && ./emsdk install $EMSDK_VERSION && ./emsdk activate $EMSDK_VERSION)
  fi
  [ -d "$W/build/venv" ] || { python3 -m venv "$W/build/venv" && "$W/build/venv/bin/pip" -q install meson==1.5.0 tomli; }
}

# Mirrors upstream tests/docker/dockerfiles/emsdk-wasm64-cross.docker, without Docker.
deps() {
  toolchain
  export CFLAGS="-O3 -pthread -DWASM_BIGINT -sMEMORY64=1" CXXFLAGS="-O3 -pthread -DWASM_BIGINT -sMEMORY64=1"
  export LDFLAGS="-sWASM_BIGINT -sASYNCIFY=1 -L$TARGET/lib -sMEMORY64=1"
  mkdir -p "$TARGET" "$W/build/deps" && cd "$W/build/deps"
  cross() {  # $1 = output cross file; embeds current CFLAGS/LDFLAGS
    { printf "[host_machine]\nsystem = 'emscripten'\ncpu_family = 'wasm64'\ncpu = 'wasm64'\nendian = 'little'\n\n"
      printf "[binaries]\nc = 'emcc'\ncpp = 'em++'\nar = 'emar'\nranlib = 'emranlib'\npkgconfig = ['pkg-config', '--static']\n\n"
      printf "[built-in options]\nc_args = [%s]\ncpp_args = [%s]\nc_link_args = [%s]\ncpp_link_args = [%s]\n" \
        "$(printf "'%s', " $CFLAGS | sed 's/, $//')" "$(printf "'%s', " $CFLAGS | sed 's/, $//')" \
        "$(printf "'%s', " $LDFLAGS | sed 's/, $//')" "$(printf "'%s', " $LDFLAGS | sed 's/, $//')"
    } > "$1"
  }
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
  if [ ! -f "$TARGET/lib/libpixman-1.a" ]; then
    [ -d pixman ] || git clone -q --depth 1 -b pixman-0.44.2 https://gitlab.freedesktop.org/pixman/pixman
    cross cross-pixman.meson
    (cd pixman && meson setup _build --prefix="$TARGET" --cross-file=../cross-pixman.meson \
      --default-library=static --buildtype=release -Dtests=disabled -Ddemos=disabled && meson install -C _build)
  fi
  if [ ! -f "$TARGET/lib/libglib-2.0.a" ]; then
    printf '#include <netdb.h>\nint res_query(const char *n, int c, int t, unsigned char *d, int l) { h_errno = HOST_NOT_FOUND; return -1; }\n' > res_query.c
    emcc $CFLAGS -c res_query.c -o res_query.o && emar rcs "$TARGET/lib/libresolv.a" res_query.o
    [ -d glib ] || { mkdir glib && curl -Ls https://download.gnome.org/sources/glib/2.84/glib-2.84.0.tar.xz | tar xJC glib --strip-components=1; }
    CFLAGS="$CFLAGS -Wno-incompatible-function-pointer-types" cross cross-glib.meson
    (cd glib && rm -rf _build && meson setup _build --prefix="$TARGET" --cross-file=../cross-glib.meson \
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
  src="$W/build/qemu"
  if [ ! -d "$src" ]; then
    git clone -q --depth 1 -b "$QEMU_BRANCH" "$QEMU_REPO" "$src"
    [ "$(git -C "$src" rev-parse HEAD)" = "$QEMU_COMMIT" ] || { git -C "$src" fetch -q --depth 50 origin "$QEMU_BRANCH"; git -C "$src" checkout -q "$QEMU_COMMIT"; }
  fi
  mkdir -p "$src/build" && cd "$src/build"
  emconfigure ../configure --static --cpu=wasm64 --cross-prefix= \
    --target-list=x86_64-softmmu \
    --enable-system --disable-user --disable-tools --disable-docs \
    --without-default-features --with-coroutine=wasm \
    --extra-cflags="-O3 -g0 -matomics -mbulk-memory -DNDEBUG -sASYNCIFY=1 -pthread -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sTOTAL_MEMORY=2300MB -sWASM_BIGINT -sMALLOC=mimalloc"
  emmake make -j"$(nproc)"
  ls -la qemu-system-x86_64.js qemu-system-x86_64.wasm
}

case $stage in
  all) setup; deps; qemu ;;
  setup|deps|qemu) $stage ;;
  *) echo "usage: $0 [all|setup|deps|qemu]"; exit 1 ;;
esac
