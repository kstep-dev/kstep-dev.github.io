#!/bin/bash
# Build the site: everything site/ needs that is not tracked, around the wasm QEMU setup.sh
# leaves in site/qemu/. Run it after changing the page, kSTEP's kmod, or the bug table.
#   ./build.sh
# site/ = index.html, style.css, kstep.mjs, figures/, coi-serviceworker.min.js (tracked)
# + qemu/ (from setup.sh) + data.json and images/cli (from here).
# serve.sh serves the result; deploy.sh checks it and publishes it.
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
# kSTEP checkout: .. when this repo is kSTEP's website submodule, else a sibling ../kstep.
KSTEP_DIR=${KSTEP_DIR:-$([ -f "$W/../run.py" ] && echo "$W/.." || echo "$W/../kstep")}
[ -f "$W/site/qemu/qemu-system-x86_64.wasm" ] || { echo "no wasm build; run ./setup.sh"; exit 1; }

# data.json: cache-busting version and the bug catalog: reproduce.py's Bug table joined with
# the README results table (driver source, fix links, plot).
version="$(git -C "$W" rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M)"
(cd "$KSTEP_DIR" && python3 - "$version" <<'PY'
import json, re, sys
import reproduce
version, = sys.argv[1:]
readme = open("README.md").read()
rows = {}
for line in readme.splitlines():
    m = re.match(r"\| \*\*\[[^\]]+\]\((\S+?)\)\*\*(.*)", line)   # link text varies; key on the driver path
    if not m: continue
    path, rest = m.groups()
    name = re.sub(r"\.c$", "", path.rsplit("/", 1)[-1])
    links = [(l, u) for l, u in re.findall(r"\[([^\]]+)\]\((\S+?)\)", rest) if not l.endswith(".jsonl")]
    links = [(l, u if u.startswith("http") else f"https://github.com/kstep-dev/kstep/blob/master/{u}") for l, u in links]
    plot = re.search(r"!\[\]\((\S+?)\)", line) or re.search(r'src="(\S+?)"', line)
    rows[name] = {"driver_url": f"https://github.com/kstep-dev/kstep/blob/master/{path}",
                  "fixes": [{"label": l, "url": u} for l, u in links], "plot": plot.group(1) if plot else None}
bugs = []
for b in reproduce.BUGS + getattr(reproduce, "BUGS_EXTRA", []):
    bugs.append({"name": b.name, "num_cpus": b.num_cpus, "mem_mb": b.mem_mb,
                 **rows.get(b.name, {"driver_url": None, "fixes": [], "plot": None})})
print(json.dumps({"version": version, "bugs": bugs}, indent=1))
PY
) > "$W/site/data.json"
# Playground image: kSTEP's build of Linux $PLAYGROUND_LINUX for x86_64 (the wasm QEMU's only
# target), the same build/<version> directory the repro scripts use, built here from the current
# kmod and user.c so the page and the driver it talks to are always published together. The
# kernel is built once (checkout.py + make.py, ~10 min); PLAYGROUND_LOCAL=<build dir> uses
# another x86_64 build instead.
PLAYGROUND_LINUX=v6.18
CLI=${PLAYGROUND_LOCAL:-$KSTEP_DIR/build/$PLAYGROUND_LINUX}
if [ -z "${PLAYGROUND_LOCAL:-}" ] && [ ! -d "$CLI/linux" ]; then
  (cd "$KSTEP_DIR" && ./checkout.py "$PLAYGROUND_LINUX" "$PLAYGROUND_LINUX" --no-current)
fi
"$KSTEP_DIR/make.py" --build "$(basename "$(readlink -f "$CLI")")" --arch x86_64
[ "$(cat "$CLI/arch" 2>/dev/null)" = x86_64 ] || { echo "playground image at $CLI is not x86_64 (the wasm QEMU is x86_64 only)"; exit 1; }
# The kernel is the uncompressed vmlinux, stripped (PVH boot: no in-guest decompression); GitHub
# Pages gzips it to about the bzImage's size.
mkdir -p "$W/site/images/cli" && cp "$CLI/rootfs.cpio" "$W/site/images/cli/"
x86_64-linux-gnu-strip -o "$W/site/images/cli/kernel" "$CLI/kernel" 2>/dev/null || cp "$CLI/kernel" "$W/site/images/cli/kernel"
echo "site/: $(du -sh "$W/site" | cut -f1); $(python3 -c "import json;print(len(json.load(open('$W/site/data.json'))['bugs']))") bugs"
