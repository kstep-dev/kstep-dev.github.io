#!/bin/bash
# Assemble the static site in build/site and (unless --stage-only) force-push it as the
# gh-pages branch; history is not kept there.
#   ./deploy.sh [--stage-only]
# Site: index.html, coi-serviceworker.min.js, kernels.json, qemu/{qemu-system-x86_64.js,.wasm,*.bin}
# The browser fetches kernel images from the kstep-dev/build repo on GitHub, at the commit
# the kSTEP `build` submodule pins, so the site itself carries no images.
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
# kSTEP checkout: ../.. when this repo is kSTEP's docs/web submodule, else a sibling ../kstep.
KSTEP_DIR=${KSTEP_DIR:-$([ -f "$W/../../run.py" ] && echo "$W/../.." || echo "$W/../kstep")}
qemu="$W/build/qemu"
[ -f "$qemu/build/qemu-system-x86_64.wasm" ] || { echo "no wasm build; run ./build.sh"; exit 1; }

site="$W/build/site"
rm -rf "$site" && mkdir -p "$site/qemu"
cp "$W/coi-serviceworker.min.js" "$site/"
sed "s/__VERSION__/$(git -C "$W" rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M)/" "$W/index.html" > "$site/index.html"
cp "$qemu/build/qemu-system-x86_64.js" "$qemu/build/qemu-system-x86_64.wasm" \
   "$qemu/pc-bios/bios-256k.bin" "$qemu/pc-bios/linuxboot_dma.bin" "$qemu/pc-bios/kvmvapic.bin" "$site/qemu/"
touch "$site/.nojekyll"

# kernels.json: image base URL + the committed images, with defaults from reproduce.py's Bug table.
url=$(git -C "$KSTEP_DIR/build" remote get-url origin | sed -E 's#\.git$##; s#^git@github.com:#https://github.com/#')
base="${url/github.com/raw.githubusercontent.com}/$(git -C "$KSTEP_DIR/build" rev-parse HEAD)"
kernels=$(git -C "$KSTEP_DIR/build" ls-files | sed -n 's#^\([^/]*\)/kernel$#\1#p')
(cd "$KSTEP_DIR" && python3 - "$base" $kernels <<'PY'
import json, re, sys
import reproduce
base, *names = sys.argv[1:]
bugs = {b.name: b for b in reproduce.BUGS + getattr(reproduce, "BUGS_EXTRA", [])}
out = []
for n in names:
    b = bugs.get(re.sub(r"_(buggy|fixed)$", "", n))
    out.append({"name": n, "driver": b.name if b else n, "num_cpus": b.num_cpus if b else 2, "mem_mb": b.mem_mb if b else 512})
print(json.dumps({"base": base, "kernels": out}, indent=1))
PY
) > "$site/kernels.json"
echo "site: $(du -sh "$site" | cut -f1); $(echo $kernels | wc -w) kernels from $base"
[ "${1:-}" = --stage-only ] && exit 0

cd "$site"
git init -q -b gh-pages
git add -A
git -c user.name="deploy.sh" -c user.email="deploy@kstep" commit -q -m "Deploy $(git -C "$W" rev-parse --short HEAD) $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q --force "$(git -C "$W" remote get-url origin)" gh-pages
echo "pushed gh-pages"
