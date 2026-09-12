# kstep-dev.github.io

The kSTEP project page, https://kstep-dev.github.io/. Its centerpiece is the playground:
[kSTEP](https://github.com/kstep-dev/kstep) inside QEMU compiled to WebAssembly, booting an
x86 kernel with the interactive `cli` driver so visitors can create tasks, tick the scheduler,
and watch who runs where. The kernel image ships with the site; the site itself is the page
plus a 13 MB QEMU build. Below the playground, a static catalog of the reproduced bugs.

QEMU is Kohei Tokunaga's `wasm64-tcg-b` branch of https://github.com/ktock/qemu
(QEMU 10.2.50 plus his wasm JIT backend), pinned to a commit in `setup.sh`.
Upstream QEMU can target wasm64 too but only with the TCI interpreter, about 4x slower.

## Layout

| Path | Purpose |
|------|---------|
| `site/` | the published site. Tracked: `index.html` (playground + bug catalog + paper), `style.css`, `kstep.mjs`, `figures/`, `assets/` (paper PDF), `coi-serviceworker.min.js`. Generated, gitignored: `qemu/` (from `setup.sh`), `data.json` and `images/cli/` (from `build.sh`) |
| `site/kstep.mjs` | shared by the page and `run.mjs`: QEMU arguments, image loading, output plumbing, completion detection |
| `setup.sh` | one-time: `setup` (apt, emsdk, meson), `deps` (zlib, libffi, pixman, glib for wasm64), `qemu` (x86_64-softmmu into `site/qemu/`) |
| `build.sh` | builds the site: writes `site/data.json` (the bug table from kSTEP's `reproduce.py` and README, version stamp) and builds and copies the playground image (kSTEP's `build/cli`: Linux v6.18 for x86_64 with the current kmod and user.c, created on first run; `PLAYGROUND_LOCAL=<build dir>` overrides) into `site/images/` |
| `deploy.sh` | `build.sh`, then `check.mjs` as a gate, then force-pushes `site/` as the orphan `gh-pages` branch |
| `serve.sh` | `build.sh`, then serves `site/` locally with `python3 -m http.server` |
| `check.mjs` | boots the playground image the site points at and checks it answers every verb the page uses; `deploy.sh` runs it before publishing |
| `run.mjs` | the same run, headless under Node (>= 20): for timing and for comparing traces against native QEMU; with `--build cli` it drives the playground's driver (round-robin demo), and `--bench <s>` measures `tick` and `top` latency |
| `site/index.html` | the front page: the playground, which boots a kernel with the `cli` driver on a configurable machine (sockets × clusters × cores × threads, per-core capacity), creates tasks and ticks the scheduler; a timeline of who ran on which CPU, and a table of each task's counters with nice, affinity, pause/wake and kill controls; live CPU/runqueue statistics below Cgroups and a folded Topology editor above the timeline |

`KSTEP_DIR` is the kSTEP checkout; it defaults to `..` (this repo as kSTEP's
`website` submodule) or `../kstep`. Everything else generated lives in `build/`.

## Usage

```sh
./setup.sh                            # first time ~15 min; ./setup.sh qemu rebuilds QEMU only
./run.mjs --build sync_wakeup_buggy   # console -> stdout, results -> results/<build>-<driver>/
./serve.sh 8080                       # http://localhost:8080/ ; builds the playground image (kSTEP's build/cli, Linux v6.18) first
./deploy.sh                           # https://kstep-dev.github.io/
```

## Notes

* **Threads.** Each vCPU is a Web Worker (MTTCG). That needs SharedArrayBuffer,
  which browsers grant only with COOP/COEP headers; GitHub Pages cannot send them,
  so the service worker adds them and reloads the page once on first visit.
* **wasm32.** QEMU is built with `--enable-wasm64-32bit-address-limit` (64-bit
  pointers in C, wasm32 output) so it also runs where Memory64 is missing
  (Safari, older Chrome and Firefox).
* **Memory.** The wasm heap is 1 GB (`setup.sh` patches QEMU's emscripten
  config, which says 2 GB) and the translation cache 64 MB; the playground guest
  gets 64 MB (the kernel leaves ~44 MB free at 5 CPUs; kSTEP touches ~20 MB). A run
  peaks around 0.6 GB of process memory.
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

## CPU overview and configuration

The CPUs section shows read-only `type: "cpu"` records emitted by the CLI driver's
`top` command, one per isolated CPU before the final reply. The overview shows
current task, `nr_running`, capacity, and fair-class PELT utilization (1024 is a
full CPU; RT/DL utilization is excluded). The same table also shows fair load and
runnable averages, root CFS minimum vruntime, and cumulative context switches.
Older images show unavailable counters rather than inferred runqueue values;
`check.mjs` requires these records before deployment.

The Topology editor starts folded above the timeline. It is a draft: presets, dimensions, and per-core capacities do
not affect the running session until Restart. Discard restores the running
configuration. Layouts have at most eight experiment CPUs, plus CPU 0 for the
driver. Restart stores the configuration in the URL and resets the experiment.

The status bar above Topology shows startup progress, elapsed time, and the latest
kernel console line. Once ready, the preview disappears. Expand Show logs for the
kernel console and kSTEP trace; errors expand the logs automatically.
