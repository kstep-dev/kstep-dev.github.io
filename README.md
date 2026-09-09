# kstep-dev.github.io

The kSTEP project page, https://kstep-dev.github.io/. Its centerpiece runs
[kSTEP](https://github.com/kstep-dev/kstep) inside QEMU compiled to WebAssembly:
pick a reproduced scheduler bug, and the buggy or fixed kernel boots in the browser
and streams the kernel console and the driver's trace. Kernel images come from the
[kstep-dev/build](https://github.com/kstep-dev/build) repo at the commit kSTEP's
`build` submodule pins; the site itself is the page plus a 13 MB QEMU build.

QEMU is Kohei Tokunaga's `wasm64-tcg-b` branch of https://github.com/ktock/qemu
(QEMU 10.2.50 plus his wasm JIT backend), pinned to a commit in `build.sh`.
Upstream QEMU can target wasm64 too but only with the TCI interpreter, about 4x slower.

## Layout

| Path | Purpose |
|------|---------|
| `site/` | the published site. Tracked: `index.html`, `kstep.mjs`, `figures/`, `assets/` (paper PDF), `coi-serviceworker.min.js`. Generated, gitignored: `qemu/` (from `build.sh`) and `data.json` (from `deploy.sh`) |
| `site/kstep.mjs` | shared by the page and `run.mjs`: QEMU arguments, image loading, output plumbing, completion detection |
| `build.sh` | `setup` (apt, emsdk, meson), `deps` (zlib, libffi, pixman, glib for wasm64), `qemu` (x86_64-softmmu into `site/qemu/`) |
| `deploy.sh` | writes `site/data.json` (the bug table from kSTEP's `reproduce.py` and README, image URLs, version stamp) and force-pushes `site/` as the orphan `gh-pages` branch |
| `serve.sh` | same `data.json`, served locally with `python3 -m http.server` |
| `run.mjs` | the same run, headless under Node (>= 20): for timing and for comparing traces against native QEMU |
| `cli.mjs` | drives kSTEP's `cli` driver (kmod/cli) over a fourth serial port: the interactive round-robin demo, headless |
| `site/play.html` | the playground: boots a kernel with the `cli` driver on a configurable machine (sockets × clusters × cores × threads, per-core capacity), creates tasks and ticks the scheduler; a timeline of who ran on which CPU, and a table of each task's counters with nice, affinity, pause/wake and kill controls |

`KSTEP_DIR` is the kSTEP checkout; it defaults to `../..` (this repo as kSTEP's
`docs/website` submodule) or `../kstep`. Everything else generated lives in `build/`.

## Usage

```sh
./build.sh                            # first time ~15 min; ./build.sh qemu rebuilds QEMU only
./run.mjs --kernel sync_wakeup_buggy  # console -> stdout, results -> results/<image>-<driver>/
./serve.sh 8080                       # http://localhost:8080/ ; the playground image comes from ../../build/cli if present (or PLAYGROUND_LOCAL=<dir>)
./deploy.sh                           # https://kstep-dev.github.io/
```

## Notes

* **Threads.** Each vCPU is a Web Worker (MTTCG). That needs SharedArrayBuffer,
  which browsers grant only with COOP/COEP headers; GitHub Pages cannot send them,
  so the service worker adds them and reloads the page once on first visit.
* **wasm32.** QEMU is built with `--enable-wasm64-32bit-address-limit` (64-bit
  pointers in C, wasm32 output) so it also runs where Memory64 is missing
  (Safari, older Chrome and Firefox).
* **Memory.** The wasm heap is 1 GB (`build.sh` patches QEMU's emscripten
  config, which says 2 GB) and the translation cache 64 MB; guests get the 128 MB
  `reproduce.py` specifies (kSTEP touches ~20 MB). A run peaks around 0.6 GB of
  process memory. `long_balance` (4 GB guest) is left out of the page.
* **Output.** The three serial chardevs write to Emscripten device nodes whose
  JavaScript callbacks receive each byte as QEMU emits it: no polling. QEMU never
  exits under Emscripten, so the reboot line on the console marks completion, and
  a new run reloads the page.
* **Boot arguments.** Those of kSTEP's `run.py`, plus `tsc_early_khz=1000000`:
  on a wasm host QEMU derives the guest TSC from the JavaScript clock, which is
  as coarse as `performance.now()` (1 ms in Safari), and the kernel's TSC
  calibration divides by zero on it. Never add this to `run.py`; under KVM the
  TSC runs at the host frequency.
* **Kernel config.** Images need `CONFIG_X86_PM_TIMER=y` (in kSTEP since
  2026-09-09). Without it the kernel verifies the LAPIC timer against jiffies,
  which fails now and then at emulation speed, disables the timer, and kSTEP
  then crashes at init because no CPU ever enters high-res tick mode.
* **Speed.** About 8 to 14 s per run in Node on this host, versus about 1 s for
  native QEMU TCG; traces match native QEMU of the same version byte for byte.
