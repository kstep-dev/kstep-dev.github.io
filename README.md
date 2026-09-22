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
| `site/` | the published site. Tracked: `index.html` (markup and a bootstrap), `viz.mjs` (the whole front end), `style.css`, `kstep.mjs`, `figures/`, `assets/` (paper PDF), `coi-serviceworker.min.js`, `uPlot.iife.min.js` and `uPlot.min.css` (vendored, not a CDN: the page is cross-origin isolated). Generated, gitignored: `qemu/` (from `setup.sh`), `data.json`, `images/<kernel>/` (a playground image per supported LTS kernel and its `snap-5.{bin.gz,json}`: the machine at the driver's ready line for 4 CPUs + driver, which the page resumes instead of booting; a layout of up to 4 CPUs resumes it too, the driver keeping the CPUs beyond the layout idle) and `kstep_core.js` + `kstep_core_bg.wasm` (from `kstep viz`) |
| `site/viz.mjs` | the front end: session state, the VM transport, the figures, the tables and the topology editor. `index.html` fetches `data.json` for the version stamp (which busts this module's cache) and calls its `init()` |
| `pagetest.mjs` | `site/viz.mjs` under Node with a DOM stub: it loads the module, drives the controls and checks a plain load, redraws, the figure toggles and `?charts=` links. A `kstep viz deploy` gate |
| `site/kstep.mjs` | shared by the page and `run.mjs`: the Emscripten device nodes, the `cli` driver's command/reply protocol, completion detection, `snapshot()` (the machine as a migration stream, `migrate file:` on the monitor) and resuming from one (`-incoming`), and the calls into kSTEP's core (`kstep_core.js`: QEMU's arguments and the decoder for the machine's state, `crates/core` built for wasm32) |
| `setup.sh` | one-time: `setup` (apt, emsdk, meson), `deps` (zlib, libffi, pixman, glib for wasm64), `qemu` (aarch64-softmmu, virt machine only, into `site/qemu/`) |
| `kstep viz` (in the parent repo: `../kstep.sh viz`) | builds the site: compiles `crates/core` for wasm32 into `site/kstep_core.js` + `kstep_core_bg.wasm`, writes `site/data.json` (version stamp and the bug catalog from `bugs.yaml`) and rebuilds and copies a playground image per supported LTS kernel (kSTEP's `build/v5.15` .. `build/v6.18`, arm64, with the current kmod and user.c, checked out and built on first run) into `site/images/<kernel>/` and snapshots each at the driver's ready line for the page's default machine (`run.mjs --snapshot`: `snap-5.bin.gz`, ~3 MB, resumed in ~0.3 s instead of a ~4 s boot; an image that did not change keeps its snapshot; layouts over 4 CPUs boot cold). That is `kstep viz build`; plain `kstep viz [--port N]` builds the same way first, incrementally, then serves `site/` locally, and `kstep viz serve` only serves (page edits show on a reload), and `kstep viz deploy` builds, gates on `pagetest.mjs` and `run.mjs --check` and force-pushes `site/` as the orphan `gh-pages` branch. Needs `rustup target add wasm32-unknown-unknown` and `cargo install wasm-bindgen-cli` at the version in `Cargo.lock` |
| `run.mjs` | the playground headless under Node (>= 20): the round-robin demo (who ran on which CPU), `--bench <s>` for `tick`/`top` latency, `--check` to verify the staged image answers every verb the page uses and its snapshot resumes (the deploy gate), `--snapshot` to write the snapshot for `--smp` (default 5) next to `--image`; a run resumes from the image's snapshot when there is one, `--cold` boots regardless |
| `site/index.html` | the front page: the playground, which boots a kernel with the `cli` driver on a configurable machine (sockets × clusters × cores × threads, per-core capacity), creates tasks and ticks the scheduler; a stack of uPlot figures over the same ticks (one toggle per figure, grouped per task and per CPU, the set living in `?charts=`) sharing one window, one zoom and one crosshair, with Placement -- a row per CPU, shared out among the tasks on it -- shown by default, and a table of each task's counters with nice, affinity, pause/wake and kill controls; then the Workload (tasks and cgroups), the Scheduler (each CPU's queues, one block per class) and the Machine (CPU statistics and sched domains), with a folded Topology editor above the charts |

`KSTEP_DIR` is the kSTEP checkout for `run.mjs`; it defaults to `..` (this repo as kSTEP's
`website` submodule). Everything else generated lives in `build/`.

## Usage

```sh
./setup.sh                            # first time ~15 min; ./setup.sh qemu rebuilds QEMU only
./run.mjs [--build v6.18]             # the playground headless: round-robin demo; --bench for latency, --check for the deploy gate
../kstep.sh viz build                 # the decoder, the playground image (kSTEP's build/v6.18) and its snapshot into site/
../kstep.sh viz [--port 8080]         # build (incrementally), then http://localhost:8080/
../kstep.sh viz serve                 # serve site/ as it is, no build
./pagetest.mjs                        # the front end under Node: no browser, no VM
../kstep.sh viz deploy                # https://kstep-dev.github.io/ (gated on both checks)
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

The Charts section is the run: one column per tick, the window set by the wheel (pan) and the
column width (ctrl or cmd wheel to zoom), and every figure handed that same window so a column
cannot drift between two of them. Figures plot the kernel's own values, so the axis means what the
Tasks and CPUs tables mean. Placement is the default: a row per CPU, shared out at each tick among
the tasks on that CPU, solid for the one that ran and faint for those queued behind it.

The Topology editor starts folded above the charts. It is a draft: presets, dimensions, and per-core capacities do
not affect the running session until Restart. Discard restores the running
configuration. Layouts have at most eight experiment CPUs, plus CPU 0 for the
driver. Restart stores the configuration in the URL and resets the experiment.

The status bar above Topology shows startup progress, elapsed time, and the latest
kernel console line. Once ready, the preview disappears. Expand Show logs for the
kernel console and kSTEP trace; errors expand the logs automatically.
