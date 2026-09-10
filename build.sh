#!/bin/bash
# Build the site: everything site/ needs that is not tracked, around the wasm QEMU setup.sh
# leaves in site/qemu/. Run it after changing the page, kSTEP's kmod, or the bug table.
#   ./build.sh
# site/ = index.html, reproduce.html, style.css, kstep.mjs, figures/, coi-serviceworker.min.js
# (tracked) + qemu/ (from setup.sh) + data.json and images/cli (from here).
# The browser fetches the bug images from the kstep-dev/build repo on GitHub, at the commit the
# kSTEP `build` submodule pins; only the playground image travels with the site (see below).
# serve.sh serves the result; deploy.sh checks it and publishes it.
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
# kSTEP checkout: ../.. when this repo is kSTEP's docs/website submodule, else a sibling ../kstep.
KSTEP_DIR=${KSTEP_DIR:-$([ -f "$W/../../run.py" ] && echo "$W/../.." || echo "$W/../kstep")}
[ -f "$W/site/qemu/qemu-system-x86_64.wasm" ] || { echo "no wasm build; run ./setup.sh"; exit 1; }

# data.json: cache-busting version, image base URL, and the bug catalog: reproduce.py's Bug
# table joined with the README results table (driver source, fix links, plot) and the
# images committed in the build repo.
version="$(git -C "$W" rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M)"
url=$(git -C "$KSTEP_DIR/build" remote get-url origin | sed -E 's#\.git$##; s#^git@github.com:#https://github.com/#')
base="${url/github.com/raw.githubusercontent.com}/$(git -C "$KSTEP_DIR/build" rev-parse HEAD)"
images=$(git -C "$KSTEP_DIR/build" ls-files | sed -n 's#^\([^/]*\)/kernel$#\1#p')
(cd "$KSTEP_DIR" && python3 - "$version" "$base" $images <<'PY'
import json, re, sys
import reproduce
version, base, *images = sys.argv[1:]
MAX_MEM_MB = 1024   # fits the 2 GB wasm heap; long_balance (4096 MB) is left out
readme = open("README.md").read()
titles = {}
try:   # short human titles only exist on the old site; fall back to the driver name
    old = open("docs/website-archive/index.html").read()
    titles = dict(re.findall(r"<span>(\w+)\.c</span>\s*<strong>(.*?)</strong>", old))
except FileNotFoundError:
    pass
rows = {}
for line in readme.splitlines():
    m = re.match(r"\| \*\*\[[^\]]+\]\((\S+?)\)\*\*(.*)", line)   # link text varies; key on the driver path
    if not m: continue
    path, rest = m.groups()
    name = re.sub(r"\.c$", "", path.rsplit("/", 1)[-1])
    rest = rest.split("**Run in browser**")[0]   # the row's links back to this site are not fixes
    links = [(l, u) for l, u in re.findall(r"\[([^\]]+)\]\((\S+?)\)", rest) if not l.endswith(".jsonl")]
    links = [(l, u if u.startswith("http") else f"https://github.com/kstep-dev/kstep/blob/master/{u}") for l, u in links]
    plot = re.search(r"!\[\]\((\S+?)\)", line) or re.search(r'src="(\S+?)"', line)
    rows[name] = {"driver_url": f"https://github.com/kstep-dev/kstep/blob/master/{path}",
                  "fixes": [{"label": l, "url": u} for l, u in links], "plot": plot.group(1) if plot else None}
bugs = []
for b in reproduce.BUGS + getattr(reproduce, "BUGS_EXTRA", []):
    imgs = {v: f"{b.name}_{v}" for v in ("buggy", "fixed") if f"{b.name}_{v}" in images}
    if not imgs or b.mem_mb > MAX_MEM_MB: continue
    bugs.append({"name": b.name, "title": titles.get(b.name, b.name), "num_cpus": b.num_cpus, "mem_mb": b.mem_mb,
                 "images": imgs, **rows.get(b.name, {"driver_url": None, "fixes": [], "plot": None})})
# Playground (index.html): a plain x86 kernel whose kmod has the `cli` driver. Unlike the bug
# images, it ships with the site (site/images/cli, copied below from the kSTEP build dir), so
# the page and the driver it talks to are always published together.
print(json.dumps({"version": version, "base": base, "bugs": bugs,
                  "playground": {"image": "cli", "base": "images", "mem_mb": 128}}, indent=1))
PY
) > "$W/site/data.json"
CLI=${PLAYGROUND_LOCAL:-$KSTEP_DIR/build/cli}   # kernel + rootfs.cpio built from the current kmod and user.c
[ -f "$CLI/kernel" ] && [ -f "$CLI/rootfs.cpio" ] || { echo "no playground image at $CLI (expected kernel + rootfs.cpio; PLAYGROUND_LOCAL=<dir> overrides)"; exit 1; }
mkdir -p "$W/site/images/cli" && cp "$CLI/kernel" "$CLI/rootfs.cpio" "$W/site/images/cli/"
echo "site/: $(du -sh "$W/site" | cut -f1); $(python3 -c "import json;print(len(json.load(open('$W/site/data.json'))['bugs']))") bugs, images from $base"
