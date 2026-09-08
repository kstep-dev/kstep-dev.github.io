#!/bin/bash
# Stage the static site in build/site and (unless --stage-only) force-push it to
# the gh-pages branch; history is not kept there.
#   ./deploy.sh                 # stage + push. Kernels are fetched by the browser from the
#                               # kstep-dev/build repo on GitHub at the commit the kSTEP submodule
#                               # pins, so the site holds no images.
#   ./deploy.sh --stage-only    # stage only, with the local $KSTEP_DIR/build images copied in
#                               # (what serve.sh uses)
# Site: index.html, coi-serviceworker.min.js, kernels.json, qemu/{qemu-system-x86_64.js,.wasm,*.bin}
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
push=1; [ "${1:-}" = --stage-only ] && push=0
# kSTEP checkout: ../.. when this repo is kSTEP's docs/web submodule, else a sibling ../kstep.
if [ -z "${KSTEP_DIR:-}" ]; then
  if [ -f "$W/../../run.py" ]; then KSTEP_DIR="$W/../.."; else KSTEP_DIR="$W/../kstep"; fi
fi
qemu="$W/build/qemu"
[ -f "$qemu/build/qemu-system-x86_64.wasm" ] || { echo "no wasm build; run ./build.sh"; exit 1; }

site="$W/build/site"
rm -rf "$site" && mkdir -p "$site/qemu"
cp "$W/coi-serviceworker.min.js" "$site/"
sed "s/__VERSION__/$(git -C "$W" rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M)/" "$W/index.html" > "$site/index.html"
cp "$qemu/build/qemu-system-x86_64.js" "$qemu/build/qemu-system-x86_64.wasm" "$site/qemu/"
cp "$qemu/pc-bios/bios-256k.bin" "$qemu/pc-bios/linuxboot_dma.bin" "$qemu/pc-bios/kvmvapic.bin" "$site/qemu/"
touch "$site/.nojekyll"

# kernels.json: where to fetch images from, plus per-kernel defaults from reproduce.py.
if [ $push -eq 1 ]; then
  url=$(git -C "$KSTEP_DIR/build" remote get-url origin | sed -E 's#\.git$##; s#^git@github.com:#https://github.com/#')
  base="${url/github.com/raw.githubusercontent.com}/$(git -C "$KSTEP_DIR/build" rev-parse HEAD)"   # exact commit kSTEP pins
  list=$(git -C "$KSTEP_DIR/build" ls-files | sed -n 's#^\([^/]*\)/kernel$#\1#p')   # committed images only
else
  base=images
  # local x86_64 images only (bzImage magic "HdrS" at 0x202); arm64 builds are skipped
  list=$(cd "$KSTEP_DIR/build" && for d in */; do d=${d%/}; [ ! -L "$d" ] && [ -f "$d/rootfs.cpio" ] && [ "$(dd if="$d/kernel" bs=1 skip=514 count=4 2>/dev/null)" = HdrS ] && echo "$d"; done)
  for k in $list; do mkdir -p "$site/images/$k"; cp "$KSTEP_DIR/build/$k/kernel" "$KSTEP_DIR/build/$k/rootfs.cpio" "$site/images/$k/"; done
fi
python3 - "$base" "$KSTEP_DIR" $list > "$site/kernels.json" <<'PY'
import json, re, sys
base, kstep, *names = sys.argv[1:]
src = open(f"{kstep}/reproduce.py").read()
bugs = {}
for m in re.finditer(r'Bug\(\s*"(\w+)"(.*?)\)', src, re.S):
    args = m.group(2)
    cpus = re.search(r"num_cpus=(\d+)", args); mem = re.search(r"mem_mb=(\d+)", args)
    bugs[m.group(1)] = (int(cpus.group(1)) if cpus else 2, int(mem.group(1)) if mem else 512)
out = []
for n in names:
    bug = re.sub(r"_(buggy|fixed)$", "", n)
    cpus, mem = bugs.get(bug, (2, 512))
    out.append({"name": n, "driver": bug, "num_cpus": cpus, "mem_mb": mem})
print(json.dumps({"base": base, "kernels": out}, indent=1))
PY
echo "site: $(du -sh "$site" | cut -f1); images from $base; $(echo $list | wc -w) kernels"
[ $push -eq 1 ] || exit 0

remote=$(git -C "$W" remote get-url origin)
cd "$site"
git init -q -b gh-pages
git add -A
git -c user.name="deploy.sh" -c user.email="deploy@kstep" commit -q -m "Deploy $(git -C "$W" rev-parse --short HEAD) $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q --force "$remote" gh-pages
echo "pushed gh-pages to $remote"
