#!/usr/bin/env python3
"""Build the site, serve it locally, or publish it.

    ./build.py                 # site/ = tracked files + qemu/ (from setup.sh) + data.json and images/cli (from here)
    ./build.py serve [PORT]    # build, then http://localhost:8080/
    ./build.py deploy          # build, gate on `run.mjs --check`, force-push site/ as the orphan gh-pages branch

Run it after changing the page, kSTEP's kmod, or the bug table. The kSTEP checkout is .. (this
repo as kSTEP's website submodule) or a sibling ../kstep, or $KSTEP_DIR.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

W = Path(__file__).resolve().parent
KSTEP = Path(os.environ.get("KSTEP_DIR") or (W.parent if (W.parent / "run.py").exists() else W.parent / "kstep"))
sys.path.insert(0, str(KSTEP))
from checkout import checkout  # noqa: E402
from make import Build, build_kstep  # noqa: E402
from reproduce import BUGS, BUGS_EXTRA  # noqa: E402
from scripts import system  # noqa: E402

SITE = W / "site"
KSTEP_URL = "https://github.com/kstep-dev/kstep/blob/master"
RESULTS_URL = "https://raw.githubusercontent.com/kstep-dev/results/main"
OFFICIAL_FIX = {"sync_wakeup": "aa3ee4f0b7541382c9f6f43f7408d73a5d4f4042"}   # upstream fix of a patch-based bug


def catalog(bug) -> dict:
    """What the bug catalog shows, from the Bug fields (the README's results table says the same by hand)."""
    commit = lambda h: {"label": f"linux@{h[:7]}", "url": f"https://github.com/torvalds/linux/commit/{h}"}
    fixes = [commit(h) for h in (bug.fix, OFFICIAL_FIX.get(bug.name)) if h]
    if bug.patch:
        fixes.append({"label": bug.patch, "url": f"{KSTEP_URL}/linux/{bug.patch}"})
    driver = next(KSTEP.glob(f"kmod/drivers*/{bug.name}.c"), KSTEP / "kmod" / "drivers" / f"{bug.name}.c")
    return {
        "name": bug.name, "num_cpus": bug.num_cpus, "mem_mb": bug.mem_mb,
        "driver_url": f"{KSTEP_URL}/{driver.relative_to(KSTEP)}",
        "fixes": fixes,
        "plot": f"{RESULTS_URL}/repro_{bug.name}/plot.png" if bug.plot_format else None,   # results are published for every bug with a plot format
    }
NODE = next(iter(W.glob("build/emsdk/node/*/bin/node")), shutil.which("node"))


def build():
    if not (SITE / "qemu" / "qemu-system-aarch64.wasm").exists():
        raise SystemExit("no wasm build; run ./setup.sh")
    if os.uname().machine != "aarch64":
        raise SystemExit("the playground image is arm64; build the site on an arm64 host")

    # data.json: cache-busting version and the bug catalog, derived from reproduce.py's Bug table
    rev = subprocess.check_output(["git", "-C", W, "rev-parse", "--short", "HEAD"], text=True).strip()
    version = f"{rev}-{datetime.now(timezone.utc):%Y%m%d%H%M}"
    (SITE / "data.json").write_text(json.dumps({"version": version, "bugs": [catalog(b) for b in BUGS + BUGS_EXTRA]}, indent=1))

    # Playground image: kSTEP's build/v6.18 (Linux v6.18 for arm64, shared with the repro
    # scripts), rebuilt from the current kmod and user.c so the page and the driver it talks to
    # are always published together. On first run this checks out and builds the kernel (~10 min).
    if not (KSTEP / "build" / "v6.18" / "linux").exists():
        checkout(ref="v6.18", kernel="v6.18", tarball=True, set_current=False)
    b = Build("v6.18")
    build_kstep(b)
    (SITE / "images" / "cli").mkdir(parents=True, exist_ok=True)
    for f in (b.kernel, b.rootfs):
        shutil.copy(f, SITE / "images" / "cli" / f.name)
    size = subprocess.check_output(["du", "-sh", SITE], text=True).split()[0]
    print(f"site/: {size}; {len(BUGS) + len(BUGS_EXTRA)} bugs; version {version}")
    return version


def serve(port: int):
    print(f"http://localhost:{port}/")
    os.execvp(sys.executable, [sys.executable, "-m", "http.server", "--bind", "127.0.0.1", "--directory", str(SITE), str(port)])


def deploy(version: str):
    # Refuse to publish a page whose playground image does not speak its protocol.
    if subprocess.run([NODE, "--wasm-lazy-compilation", W / "run.mjs", "--check"]).returncode:
        raise SystemExit("deploy aborted: rebuild the playground image from the current kmod and user.c")
    origin = subprocess.check_output(["git", "-C", W, "remote", "get-url", "origin"], text=True).strip()
    with tempfile.TemporaryDirectory() as tmp:
        shutil.copytree(SITE, tmp, dirs_exist_ok=True)
        system(f"git init -q -b gh-pages && git add -A && "
               f"git -c user.name=build.py -c user.email=deploy@kstep commit -q -m 'Deploy {version}' && "
               f"git push -q --force {origin} gh-pages", cwd=Path(tmp))
    print(f"pushed gh-pages ({version})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("serve").add_argument("port", type=int, nargs="?", default=8080)
    sub.add_parser("deploy")
    args = parser.parse_args()
    version = build()
    if args.cmd == "serve":
        serve(args.port)
    elif args.cmd == "deploy":
        deploy(version)
