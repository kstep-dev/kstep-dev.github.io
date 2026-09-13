# kstep-dev.github.io

The kSTEP project page, https://kstep-dev.github.io/. Its centerpiece is the playground:
[kSTEP](https://github.com/kstep-dev/kstep) inside QEMU compiled to WebAssembly, booting an
arm64 kernel with the interactive `cli` driver so visitors can create tasks, tick the scheduler,
and watch who runs where. The kernel image ships with the site; the site itself is the page
plus a 13 MB QEMU build. Below the playground, a static catalog of the reproduced bugs.

QEMU is Kohei Tokunaga's `wasm64-tcg-b` branch of https://github.com/ktock/qemu
(QEMU 10.2.50 plus his wasm JIT backend), pinned to a commit in `setup.sh`.
Upstream QEMU can target wasm64 too but only with the TCI interpreter, about 4x slower.

## Layout

| Path | Purpose |
|------|---------|
| `site/` | the published site. Tracked: `index.html` (playground + bug catalog + paper), `style.css`, `kstep.mjs`, `figures/`, `assets/` (paper PDF), `coi-serviceworker.min.js`. Generated, gitignored: `qemu/` (from `setup.sh`), `data.json` and `images/cli/` (from `build.py`) |
| `site/kstep.mjs` | shared by the page and `run.mjs`: QEMU arguments, image loading, the `cli` driver's command/reply protocol, completion detection |
| `setup.sh` | one-time: `setup` (apt, emsdk, meson), `deps` (zlib, libffi, pixman, glib for wasm64), `qemu` (aarch64-softmmu, virt machine only, into `site/qemu/`) |
| `build.py` | builds the site: writes `site/data.json` (version stamp and the bug catalog, derived from kSTEP's `reproduce.py` Bug table) and rebuilds and copies the playground image (kSTEP's `build/v6.18`: Linux v6.18 for arm64 with the current kmod and user.c, checked out and built on first run) into `site/images/`; `build.py serve [port]` then serves `site/` locally, `build.py deploy` gates on `run.mjs --check` and force-pushes `site/` as the orphan `gh-pages` branch |
| `run.mjs` | the playground headless under Node (>= 20): the round-robin demo (who ran on which CPU), `--bench <s>` for `tick`/`top` latency, `--check` to verify the staged image answers every verb the page uses (the deploy gate) |
| `site/index.html` | the front page: the playground, which boots a kernel with the `cli` driver on a configurable machine (sockets × clusters × cores × threads, per-core capacity), creates tasks and ticks the scheduler; a timeline of who ran on which CPU, and a table of each task's counters with nice, affinity, pause/wake and kill controls; live CPU/runqueue statistics below Cgroups and a folded Topology editor above the timeline |

`KSTEP_DIR` is the kSTEP checkout; it defaults to `..` (this repo as kSTEP's
`website` submodule) or `../kstep`. Everything else generated lives in `build/`.

## Usage

```sh
./setup.sh                            # first time ~15 min; ./setup.sh qemu rebuilds QEMU only
./run.mjs [--build v6.18]             # the playground headless: round-robin demo; --bench for latency, --check for the deploy gate
./build.py serve 8080                 # http://localhost:8080/ ; builds the playground image (kSTEP's build/v6.18) first
./build.py deploy                     # https://kstep-dev.github.io/
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
* **Output.** The three chardevs (the 16550 console, and virtio console ports for the
  JSON channel and coverage: one virtqueue kick per write, where the 16550 cost one port
  I/O exit per byte) write to Emscripten device nodes whose JavaScript callbacks receive
  the bytes as QEMU emits them: no polling. QEMU never
  exits under Emscripten, so the reboot line on the console marks completion, and
  a new run reloads the page.
* **Why arm64.** The guest is kSTEP's aarch64 build on QEMU's `virt` machine, the same
  arguments as `run.py` on an arm64 host. It reaches the kmod about 1 s sooner than the x86
  `pc` machine did (no SeaBIOS, no ACPI or PCI enumeration, no LAPIC/TSC calibration), needs
  no firmware blobs, and its clock is the architected timer, so none of the x86 workarounds
  (`tsc_early_khz` for the coarse JS clock, `CONFIG_X86_PM_TIMER`, PVH to skip bzImage
  decompression) apply. The kernel is the 6 MB `Image`; the site is built on an arm64 host.
* **Speed.** About 8 to 14 s per run in Node on this host, versus about 1 s for
  native QEMU TCG; traces match native QEMU of the same version byte for byte.

## CPU overview and configuration

The CPUs section shows read-only `type: "cpu"` records emitted by the CLI driver's
`top` command, one per isolated CPU before the final reply. The overview shows
current task, `nr_running`, capacity, and fair-class PELT utilization (1024 is a
full CPU; RT/DL utilization is excluded). The same table also shows fair load and
runnable averages, root CFS minimum vruntime, and cumulative context switches.
Older images show unavailable counters rather than inferred runqueue values;
`run.mjs --check` requires these records before deployment.

The Topology editor starts folded above the timeline. It is a draft: presets, dimensions, and per-core capacities do
not affect the running session until Restart. Discard restores the running
configuration. Layouts have at most eight experiment CPUs, plus CPU 0 for the
driver. Restart stores the configuration in the URL and resets the experiment.

The status bar above Topology shows startup progress, elapsed time, and the latest
kernel console line. Once ready, the preview disappears. Expand Show logs for the
kernel console and kSTEP trace; errors expand the logs automatically.
