#!/bin/bash
# Assemble the static site in build/site and publish it to the gh-pages branch
# (history is not kept).
#   ./deploy.sh [kernel ...]          # default: every $KSTEP_DIR/build/<kernel> with kernel + rootfs.cpio
#   ./deploy.sh --stage-only [...]    # just build/site, no push (serve.sh uses this)
# Site layout: index.html, coi-serviceworker.min.js, kernels.json, qemu/{js,wasm}, images/<kernel>/{kernel,rootfs.cpio}
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
push=1; [ "${1:-}" = --stage-only ] && { push=0; shift; }
# kSTEP checkout: ../.. when this repo is kSTEP's docs/web submodule, else a sibling ../kstep.
if [ -z "${KSTEP_DIR:-}" ]; then
  if [ -f "$W/../../run.py" ]; then KSTEP_DIR="$W/../.."; else KSTEP_DIR="$W/../kstep"; fi
fi
qemu="$W/build/qemu/build"
[ -f "$qemu/qemu-system-aarch64.wasm" ] || { echo "no wasm build; run ./build.sh"; exit 1; }

if [ $# -gt 0 ]; then kernels=("$@"); else
  kernels=(); for d in "$KSTEP_DIR"/build/*/; do
    [ -f "$d/kernel" ] && [ -f "$d/rootfs.cpio" ] && [ ! -L "${d%/}" ] && kernels+=("$(basename "$d")")
  done
fi
[ ${#kernels[@]} -gt 0 ] || { echo "no kernels under $KSTEP_DIR/build"; exit 1; }

site="$W/build/site"
rm -rf "$site" && mkdir -p "$site/qemu"
cp "$W/index.html" "$W/coi-serviceworker.min.js" "$site/"
cp "$qemu/qemu-system-aarch64.js" "$qemu/qemu-system-aarch64.wasm" "$site/qemu/"
for k in "${kernels[@]}"; do
  mkdir -p "$site/images/$k"
  cp "$KSTEP_DIR/build/$k/kernel" "$KSTEP_DIR/build/$k/rootfs.cpio" "$site/images/$k/"
done
printf '%s\n' "${kernels[@]}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().split()))' > "$site/kernels.json"
touch "$site/.nojekyll"
echo "site: $(du -sh "$site" | cut -f1), kernels: ${kernels[*]}"
[ $push -eq 1 ] || exit 0

remote=$(git -C "$W" remote get-url origin)
cd "$site"
git init -q -b gh-pages
git add -A
git -c user.name="deploy.sh" -c user.email="deploy@kstep" commit -q -m "Deploy $(git -C "$W" rev-parse --short HEAD) $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q --force "$remote" gh-pages
echo "pushed gh-pages to $remote"
