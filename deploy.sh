#!/bin/bash
# Generate site/kernels.json and (unless --stage-only) force-push site/ as the gh-pages
# branch; history is not kept there.
#   ./deploy.sh [--stage-only]
# site/ = index.html, coi-serviceworker.min.js (tracked) + qemu/ (from build.sh) + kernels.json.
# The browser fetches kernel images from the kstep-dev/build repo on GitHub, at the commit
# the kSTEP `build` submodule pins, so the site carries no images.
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
# kSTEP checkout: ../.. when this repo is kSTEP's docs/web submodule, else a sibling ../kstep.
KSTEP_DIR=${KSTEP_DIR:-$([ -f "$W/../../run.py" ] && echo "$W/../.." || echo "$W/../kstep")}
[ -f "$W/site/qemu/qemu-system-x86_64.wasm" ] || { echo "no wasm build; run ./build.sh"; exit 1; }

# kernels.json: cache-busting version, image base URL, committed images with defaults from reproduce.py.
version="$(git -C "$W" rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M)"
url=$(git -C "$KSTEP_DIR/build" remote get-url origin | sed -E 's#\.git$##; s#^git@github.com:#https://github.com/#')
base="${url/github.com/raw.githubusercontent.com}/$(git -C "$KSTEP_DIR/build" rev-parse HEAD)"
kernels=$(git -C "$KSTEP_DIR/build" ls-files | sed -n 's#^\([^/]*\)/kernel$#\1#p')
(cd "$KSTEP_DIR" && python3 - "$version" "$base" $kernels <<'PY'
import json, re, sys
import reproduce
version, base, *names = sys.argv[1:]
bugs = {b.name: b for b in reproduce.BUGS + getattr(reproduce, "BUGS_EXTRA", [])}
out = []
MAX_MEM_MB = 1024   # fits the 2 GB wasm heap; long_balance (4096 MB) is left out
for n in names:
    b = bugs.get(re.sub(r"_(buggy|fixed)$", "", n))
    if b and b.mem_mb > MAX_MEM_MB: continue
    out.append({"name": n, "driver": b.name if b else n, "num_cpus": b.num_cpus if b else 2, "mem_mb": b.mem_mb if b else 512})
print(json.dumps({"version": version, "base": base, "kernels": out}, indent=1))
PY
) > "$W/site/kernels.json"
echo "site/: $(du -sh "$W/site" | cut -f1); $(echo $kernels | wc -w) kernels from $base"
[ "${1:-}" = --stage-only ] && exit 0

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cp -r "$W/site/." "$tmp/"
git -C "$tmp" init -q -b gh-pages
git -C "$tmp" add -A
git -C "$tmp" -c user.name="deploy.sh" -c user.email="deploy@kstep" commit -q -m "Deploy $version"
git -C "$tmp" push -q --force "$(git -C "$W" remote get-url origin)" gh-pages
echo "pushed gh-pages ($version)"
