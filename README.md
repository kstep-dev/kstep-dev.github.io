# kstep-dev.github.io

The kSTEP project page, https://kstep-dev.github.io/. Its centerpiece is the playground:
[kSTEP](https://github.com/kstep-dev/kstep) inside QEMU compiled to WebAssembly, booting an
arm64 kernel with the interactive `cli` driver so visitors can create tasks, tick the scheduler,
and watch who runs where. The kernel image ships with the site; the site itself is the page
plus a 13 MB QEMU build. Below the playground, a static catalog of the reproduced bugs.

QEMU is the `qemu/` submodule, https://github.com/kstep-dev/qemu branch `kstep`: upstream
v11.1.1 plus Kohei Tokunaga's wasm64 JIT backend (https://github.com/ktock/qemu, branch
`wasm64-tcg-b`, squashed into one commit and rebased) and one commit of kSTEP tuning (1 GB
wasm heap, JIT threshold 300, 4 virtio-mmio slots, a device list of just the virt machine
and the virtio console). Upstream QEMU can target wasm64 too but only with the TCI
interpreter, about 4x slower. To move to a newer QEMU: rebase the two commits onto the new
tag (v10.2.50 -> v11.1.1 needed no code change), rebuild with `./setup.sh qemu`, then
`./run.mjs --cold` and `--bench`; snapshots are per QEMU build, so `kstep viz build` retakes them.

## Layout

| Path | Purpose |
|------|---------|
| `site/` | the published site. Tracked: `index.html` (markup and a bootstrap), `viz.mjs` (the whole front end), `style.css`, `kstep.mjs`, `figures/`, `assets/` (paper PDF), `coi-serviceworker.min.js`, `uPlot.iife.min.js` and `uPlot.min.css` (vendored, not a CDN: the page is cross-origin isolated). Generated, gitignored: `qemu/` (from `setup.sh`), `data.json`, `images/<kernel>/` (a playground image per supported LTS kernel and its `snap-5.{bin.gz,json}`: the machine at the driver's ready line for 4 CPUs + driver, which the page resumes instead of booting; a layout of up to 4 CPUs resumes it too, the driver keeping the CPUs beyond the layout idle) and `kstep_core.js` + `kstep_core_bg.wasm` (from `kstep viz`) |
| `site/viz.mjs` | the front end: session state, the VM transport, the figures, the tables and the topology editor. `index.html` fetches `data.json` for the version stamp (which busts this module's cache) and calls its `init()` |
| `pagetest.mjs` | `site/viz.mjs` under Node with a DOM stub: it loads the module, drives the controls and checks a plain load, redraws, the figure toggles and `?charts=` links. A `kstep viz deploy` gate |
| `site/kstep.mjs` | shared by the page and `run.mjs`: the Emscripten device nodes, the `cli` driver's command/reply protocol, completion detection, `snapshot()` (the machine as a migration stream, `migrate file:` on the monitor) and resuming from one (`-incoming`), and the calls into kSTEP's core (`kstep_core.js`: QEMU's arguments and the decoder for the machine's state, `crates/core` built for wasm32) |
| `qemu/` | submodule: the QEMU source `setup.sh qemu` builds (shallow, branch `kstep` of kstep-dev/qemu) |
| `cross.meson` | meson cross file for the wasm64 dependencies (`setup.sh deps`) |
| `setup.sh` | one-time: `setup` (apt, emsdk), `deps` (zlib, libffi, glib for wasm64), `qemu` (aarch64-softmmu, virt machine only, into `site/qemu/`) |
| `kstep viz` (in the parent repo: `../kstep.sh viz`) | builds the site: compiles `crates/core` for wasm32 into `site/kstep_core.js` + `kstep_core_bg.wasm`, writes `site/data.json` (version stamp and the bug catalog from `bugs.yaml`) and rebuilds and copies a playground image per supported LTS kernel (kSTEP's `build/v5.15` .. `build/v6.18`, arm64, with the current kmod and user.c, checked out and built on first run) into `site/images/<kernel>/` and snapshots each at the driver's ready line for the page's default machine (`run.mjs --snapshot`: `snap-5.bin.gz`, ~3 MB, resumed in ~0.3 s instead of a ~4 s boot; an image that did not change keeps its snapshot; layouts over 4 CPUs boot cold). That is `kstep viz build`; plain `kstep viz [--port N]` builds the same way first, incrementally, then serves `site/` locally, and `kstep viz serve` only serves (page edits show on a reload), and `kstep viz deploy` builds, gates on `pagetest.mjs` and `run.mjs --check` and force-pushes `site/` as the orphan `gh-pages` branch. Needs `rustup target add wasm32-unknown-unknown` and `cargo install wasm-bindgen-cli` at the version in `Cargo.lock` |
| `run.mjs` | the playground headless under Node (>= 20): the round-robin demo (who ran on which CPU), `--bench <s>` for `tick`/`policy-fair` latency, `--check` to verify the staged image answers every verb the page uses and its snapshot resumes (the deploy gate), `--snapshot` to write the snapshot for `--smp` (default 5) next to `--image`; a run resumes from the image's snapshot when there is one, `--cold` boots regardless |
| `site/index.html` | the front page: the playground, which boots a kernel with the `cli` driver on a configurable machine (sockets × clusters × cores × threads, per-core capacity), creates tasks and ticks the scheduler; a stack of uPlot figures over the same ticks (one toggle per figure, grouped per task and per CPU, the set living in `?charts=`) sharing one window, one zoom and one crosshair, with Placement -- a row per CPU, shared out among the tasks on it -- shown by default; then the Workload (tasks and cgroups as an outline, with policy, nice or priority, affinity and cgroup controls per task), the Scheduler (a box per CPU with its class queues), the Load balancer (the sched domains as nested boxes down to the CPUs, one running bar each coloured by the balancer's class, the balance countdowns and a log of what moved) and the Topology editor; a control bar under the scenarios holds the kernel selector, the clock and the kernel's status |

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
* **emsdk.** Pinned to 6.0.10 (since 2026-09-24; 4.0.23 before, whose proxied poll() leaked
  a setTimeout per call, 1.6 GB of JS heap after 90 s of ticks, and needed a patch to the
  SDK). QEMU keeps g_poll() over Emscripten's ppoll(), which truncates the timeout to whole
  ms and so busy-waited on sub-ms timers (the fork's meson.build; with ppoll, 6.x was 25%
  slower to boot and 30-50% slower per command than 4.0.23, without it the two are level).
  The fork's emscripten.txt lists `wasmMemory` in `INCOMING_MODULE_JS_API`, which 6.x dropped
  from the default, and kstep.mjs's `send()` notifies the device node, since a blocked poll
  wakes only on a notification. After an SDK bump, `rm -rf build/deps qemu/build`.
* **Where a command's time goes.** Profiled 2026-09-24 with Linux perf (`node
  --perf-basic-prof`, a build relinked with `--profiling-funcs`). During `--bench` the
  driver's vCPU is half JIT'd guest code and 14% TB dispatch (every TB returns to C between
  wasm instances); chaining TBs inside wasm (tail calls) is the lever left. Fixed that day,
  together boot 3.5 -> 2.7 s, `tick` 1.9 -> 1.4 ms, `nice` 1.15 -> 0.8 ms: ioeventfd off
  (qemu.rs, for every TCG run on virtio-mmio; an eventfd is a JS pipe on the page's
  thread) and 128-bit guest accesses (arm64 LDP/STP) as two 64-bit ones with the inline
  TLB fast path instead of a helper (tcg-op-ldst.c). No gain: `INSTANTIATE_NUM` 30/100/1000, `-sSUPPORT_LONGJMP=wasm`,
  -O3 compiles and links.
* **Single-threaded TCG (`thread=single`) loses.** Tried 2026-09-22 for the IPI fan-out
  (`smp_call_function_single` per command): boot 7.4-9.5 s vs 3.6 s, `tick` 4.8 vs 2.3 ms,
  `nice` alike, since boot and each tick run on every vCPU and a round-robin thread
  serializes them. It also needs a backend fix: the wasm64 TB prologue loads `env` into a
  wasm global only when that global is still zero, so an instance created under one vCPU
  keeps its `env` when the same thread later runs another vCPU (first symptom: the
  `icount_enabled()` assert in `cpu_loop_exec_tb`). Loading `env` from the context on
  every entry fixes it at no measurable cost to `thread=multi`; not applied, since the
  playground stays on MTTCG.
* **Memory.** The wasm heap is 1 GB (the fork's emscripten.txt; upstream says 2 GB) and
  the translation cache 64 MB; the playground guest
  gets 64 MB (the kernel leaves ~44 MB free at 5 CPUs; kSTEP touches ~20 MB). A run
  peaks around 0.6 GB of process memory.
* **Output.** Three chardevs, all Emscripten device nodes whose JavaScript callbacks
  receive the bytes as QEMU emits them: the kernel console on the PL011 UART (a
  write-only file), kSTEP's JSON channel on a virtio console port (one virtqueue kick per
  record) and the QEMU monitor. Machine state is not on the channel: after each reply the
  page reads the region kmod/shm.h describes straight out of guest RAM, which is the wasm
  heap. QEMU never
  exits under Emscripten, so the reboot line on the console marks completion, and
  a new run reloads the page.
* **Why arm64.** The guest is kSTEP's aarch64 build on QEMU's `virt` machine, the same
  arguments as `kstep run` on an arm64 host. It reaches the kmod about 1 s sooner than the x86
  `pc` machine did (no SeaBIOS, no ACPI or PCI enumeration, no LAPIC/TSC calibration), needs
  no firmware blobs, and its clock is the architected timer, so none of the x86 workarounds
  (`tsc_early_khz` for the coarse JS clock, `CONFIG_X86_PM_TIMER`, PVH to skip bzImage
  decompression) apply. The kernel is the 6 MB `Image`; the site is built on an arm64 host.
* **Speed.** About 8 to 14 s per run in Node on this host, versus about 1 s for
  native QEMU TCG; traces match native QEMU of the same version byte for byte.

## CPU overview and configuration

The CPUs section reads each isolated CPU from the shared state region (kmod/shm.h),
rewritten after every command: current task, `nr_running`, capacity, frequency, and the
root fair queue's PELT utilization (1024 is a full CPU; RT/DL utilization is excluded),
runnable and load averages, and cumulative context switches. `run.mjs --check` verifies
the region decodes before deployment.

The Charts section is the run: one column per tick, the window set by the wheel (pan) and the
column width (ctrl or cmd wheel to zoom), and every figure handed that same window so a column
cannot drift between two of them. Figures plot the kernel's own values, so the axis means what the
Workload table and the Load balancer's bars mean. Placement is the default: a row per CPU, shared
out at each tick among the tasks on that CPU, solid for the one that ran and faint for those
queued behind it.

The Scheduler section is a box per CPU: what runs there, then the real-time and fair queues with
something on them, the fair one as an outline of cgroup entities and tasks with the kernel's own
eligibility, pick and lag. The Load balancer section is the sched domain tree the kernel built,
one box per span down to CPU cards, each with one bar -- running time over capacity, coloured by
the balancer's class of that group (has spare, fully busy, overloaded) -- and a countdown to its
next balance; contention and load are on the bar's hover, a level's flags and knobs on its name.
Under it, up to five lines of what moved: the balances that ran and the migrations, per command.

The Topology editor at the bottom is a draft: threads, cores, clusters, sockets and per-core
capacities do not affect the running session until Restart, which stores the machine in the URL
and reboots. Layouts of up to four CPUs resume the staged snapshot; larger ones boot cold. The
control bar under the scenarios has the kernel selector (one image per supported LTS kernel), the
clock and, at its right, the kernel's status with the log toggle.
