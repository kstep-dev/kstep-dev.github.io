#!/bin/bash
# Generate site/data.json and (unless --stage-only) force-push site/ as the gh-pages
# branch; history is not kept there.
#   ./deploy.sh [--stage-only]
# site/ = index.html, kstep.mjs, figures/, coi-serviceworker.min.js (tracked) + qemu/ (from build.sh) + data.json.
# The browser fetches kernel images from the kstep-dev/build repo on GitHub, at the commit
# the kSTEP `build` submodule pins, so the site carries no images.
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
# kSTEP checkout: ../.. when this repo is kSTEP's docs/website submodule, else a sibling ../kstep.
KSTEP_DIR=${KSTEP_DIR:-$([ -f "$W/../../run.py" ] && echo "$W/../.." || echo "$W/../kstep")}
[ -f "$W/site/qemu/qemu-system-x86_64.wasm" ] || { echo "no wasm build; run ./build.sh"; exit 1; }

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
# Playground (play.html): a plain kernel whose kmod has the `cli` driver. Served from the same
# base unless PLAYGROUND_LOCAL points at a local build dir with kernel + rootfs.cpio (then the
# images are copied into site/images/ for local testing).
import os
play = {"image": "cli", "base": base, "num_cpus": 2, "mem_mb": 128}
if os.environ.get("PLAYGROUND_LOCAL"):
    play["base"] = "images"
print(json.dumps({"version": version, "base": base, "bugs": bugs, "playground": play}, indent=1))
PY
) > "$W/site/data.json"
if [ -n "${PLAYGROUND_LOCAL:-}" ]; then
  mkdir -p "$W/site/images/cli" && cp "$PLAYGROUND_LOCAL/kernel" "$PLAYGROUND_LOCAL/rootfs.cpio" "$W/site/images/cli/"
else
  rm -rf "$W/site/images"
fi
echo "site/: $(du -sh "$W/site" | cut -f1); $(python3 -c "import json;print(len(json.load(open('$W/site/data.json'))['bugs']))") bugs, images from $base"
[ "${1:-}" = --stage-only ] && exit 0

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cp -r "$W/site/." "$tmp/"
git -C "$tmp" init -q -b gh-pages
git -C "$tmp" add -A
git -C "$tmp" -c user.name="deploy.sh" -c user.email="deploy@kstep" commit -q -m "Deploy $version"
git -C "$tmp" push -q --force "$(git -C "$W" remote get-url origin)" gh-pages
echo "pushed gh-pages ($version)"
