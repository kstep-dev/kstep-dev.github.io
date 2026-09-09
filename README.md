# kSTEP on WebAssembly

Runs [kSTEP](https://github.com/kstep-dev/kstep) unmodified inside a QEMU
compiled to WebAssembly, in a browser at https://kstep-dev.github.io/web/ or
headless under Node. The x86_64 guest, the prebuilt kernel images committed in
[kstep-dev/build](https://github.com/kstep-dev/build), and the boot arguments
from kSTEP's `run.py` are used as-is. The page fetches the images from that
repo on GitHub at the commit kSTEP's `build` submodule pins, so the site itself
is only the 13 MB QEMU build.

QEMU is Kohei Tokunaga's `wasm64-tcg-b` branch of https://github.com/ktock/qemu
(QEMU 10.2.50 plus his 33-commit wasm JIT backend), pinned to a commit in
`build.sh`. Upstream QEMU can target wasm64 too but only with the TCI
interpreter, about 4x slower for kSTEP.

## Files

| File | Purpose |
|------|---------|
| `site/` | the published site: `index.html`, `kstep.mjs`, `figures/` and `coi-serviceworker.min.js` are tracked; `qemu/` (wasm, JS loader, SeaBIOS) is put there by `build.sh` and `data.json` by `deploy.sh`, both gitignored |
| `build.sh` | `setup` (apt, emsdk 4.0.23, meson) -> `deps` (zlib, libffi, pixman, glib cross-built for wasm64) -> `qemu` (x86_64-softmmu, copied into `site/qemu/`) |
| `deploy.sh` | writes `site/data.json` (version stamp, image base URL, and the bug catalog: `reproduce.py`'s Bug table joined with the README results table and the images in the build repo) and force-pushes `site/` as the orphan `gh-pages` branch |
| `serve.sh` | same `data.json`, then `python3 -m http.server` on `site/` |
| `site/kstep.mjs` | shared by the page and `run.mjs`: QEMU arguments, image/BIOS loading, output device nodes, completion detection |
| `run.mjs` | headless test harness (Node >= 20): runs an image with the same code path as the page; used for timing and for byte-comparing traces against native QEMU |

`index.html` is the project page with the reproducer at its center: a table of
the reproduced bugs (title, driver source, fix commit, vCPUs) with a `buggy` and
a `fixed` button per row. A run boots that image with the driver, vCPU count and
RAM `reproduce.py` uses, streams the kernel console and the driver's
`kstep.jsonl` into two panes with copy/download, and shows the paper's plot for
comparison. Below it: the abstract, the architecture figure, and links. Bug
titles come from the old site's cards (`docs/website`) when present, otherwise
the driver name. A free-form mode (choose driver and sizes) is not exposed. `coi-serviceworker.min.js` (MIT,
gzuidhof/coi-serviceworker) adds the COOP/COEP headers static hosts cannot send.
Toolchain and sources live under `build/` (gitignored). `KSTEP_DIR` points at a
kSTEP checkout and defaults to `../..` (this repo as kSTEP's `docs/web`
submodule) or `../kstep`; `run.mjs` reads images from `$KSTEP_DIR/build/<kernel>/`.

## Usage

```sh
./build.sh                          # ~15 min first time; ./build.sh qemu rebuilds QEMU only (~1 min)
./run.mjs --kernel sync_wakeup_buggy # driver, vCPUs, RAM from reproduce.py via site/data.json; console -> stdout, status -> stderr, results -> results/<kernel>-<driver>/
./serve.sh 8080                     # http://localhost:8080/
./deploy.sh                         # https://kstep-dev.github.io/web/
```

## How it works

* **Loading.** `index.html` imports the Emscripten module, fetches kernel and
  initramfs from GitHub plus SeaBIOS from the site, writes them into
  Emscripten's in-memory FS, and starts QEMU with the same arguments `run.py`
  uses on x86_64. Every vCPU is a Web Worker (MTTCG); single-threaded TCG
  aborts in this backend (`icount_enabled()` assertion).
* **Output.** The three chardevs write to `/dev/kstep0..2`, Emscripten device
  nodes whose JavaScript write callbacks receive each byte as QEMU emits it, so
  the console and the driver's `kstep.jsonl` stream into the page without
  polling. QEMU does not exit on guest reboot under Emscripten, so the reboot
  line on the console marks completion.
* **Headers.** Browsers expose SharedArrayBuffer (needed for threads) only with
  COOP/COEP headers. GitHub Pages cannot send them, so the service worker adds
  them and reloads the page once on first visit.
* **wasm32.** The build uses QEMU's `--enable-wasm64-32bit-address-limit`: 64-bit
  pointers in C, wasm32 output. It therefore runs on engines without Memory64
  (Safari, Chrome < 133, Firefox < 134). The heap ends up at 2 GB, so guest RAM
  is limited to 1024 MB, which is why `long_balance` (4096 MB) is excluded.
* **Caching.** The page fetches `data.json` uncached and appends its
  `version` to the wasm/js/bios URLs, so a new deploy is never served from a
  browser's cache of the previous one.

## Measured (aarch64 host, no KVM, Node 24)

| Guest, driver | Native QEMU TCG | This build |
|---------------|-----------------|------------|
| x86_64 `sync_wakeup_buggy`, `sync_wakeup`, 3 vCPUs | 1.1-1.4 s | 8-9 s, trace identical to native QEMU 11.1 |
| aarch64 v6.14, `default`, 2 vCPUs (aarch64 build of the same QEMU) | 0.65 s | 10 s, trace identical |

The wasm traces match native QEMU of the same generation byte for byte. The
published `sync_wakeup` result was made with QEMU 8.2 and differs in one step,
so that trace depends on the emulator version rather than on wasm.

## Boot arguments specific to wasm

`tsc_early_khz=1000000` is added to run.py's x86 arguments. QEMU on a wasm host
has no cycle counter and synthesizes the guest TSC from the JS monotonic clock
(nanoseconds, so 1 GHz), which is only as fine as `performance.now()`: 1 ms in
Safari. The kernel's PIT/HPET TSC calibration then reads identical TSC values
and divides by zero (`pit_hpet_ptimer_calibrate_cpu`, seen on 6.15-rc3).
Giving it the frequency skips that calibration. Do not add this to run.py:
under KVM the TSC runs at the host frequency.

## Resolved: x86 init panic under slow emulation

Images built before 2026-09-09 occasionally panic at module load with a NULL
dereference in `hrtimer_active` from `kstep_tick_init`, always together with
`APIC timer disabled due to verification failure` in the boot log. Cause:
kSTEP's x86 config (allnoconfig-based) lacked `CONFIG_X86_PM_TIMER`, so the
kernel verified the LAPIC timer calibration against jiffies, a 100-tick window
with a 2-tick tolerance that a 6-20x slower guest fails now and then. With the
LAPIC timer marked broken no CPU ever enters high-res tick mode, the per-CPU
`sched_timer` is never initialized, and kSTEP cancels it anyway. Native QEMU
never hit it, and it is not a JIT bug (same rate with the JIT disabled). Fix
in kSTEP: `CONFIG_X86_PM_TIMER=y` in `linux/config.kstep.x86_64`, which makes
the kernel calibrate against the ACPI PM timer and skip the jiffies check
(8/8 clean runs here, and ~15% faster boot); `kmod/tick.c` additionally waits
for the timer to exist and panics with a clear message otherwise. Images in
the build repo need a rebuild to pick this up.
