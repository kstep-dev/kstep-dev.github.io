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
| `build.sh` | `setup` (apt, emsdk 4.0.23, meson) -> `deps` (zlib, libffi, pixman, glib cross-built for wasm64) -> `qemu` (x86_64-softmmu) |
| `run.mjs`, `run.sh` | headless runner; `run.sh` finds emsdk's Node and passes `--wasm-lazy-compilation` |
| `index.html` | browser UI: pick a kernel (driver, vCPUs, RAM prefilled from `reproduce.py`), watch the console and driver output stream, download results |
| `coi-serviceworker.min.js` | adds the COOP/COEP headers static hosts cannot send (MIT, gzuidhof/coi-serviceworker) |
| `deploy.sh` | stages page + wasm + SeaBIOS + `kernels.json` in `build/site` and force-pushes it as the orphan `gh-pages` branch |
| `serve.sh` | stages the same site and serves it with `python3 -m http.server` |

Everything generated lives under `build/` (gitignored). `KSTEP_DIR` points at a
kSTEP checkout and defaults to `../..` (this repo as kSTEP's `docs/web`
submodule) or `../kstep`. `run.sh` reads images from `$KSTEP_DIR/build/<kernel>/`.

## Usage

```sh
./build.sh                          # ~15 min first time; ./build.sh qemu rebuilds QEMU only (~1 min)
./run.sh --kernel sync_wakeup_buggy # console -> stdout, status -> stderr, results -> results/<kernel>-<driver>/
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
  is capped at 1024 MB and `long_balance` (4096 MB) does not fit.
* **Caching.** `deploy.sh` stamps a version into the wasm/js/bios URLs so a
  new deploy is never served from a browser's cache of the previous one.

## Measured (aarch64 host, no KVM, Node 24)

| Guest, driver | Native QEMU TCG | This build |
|---------------|-----------------|------------|
| x86_64 `sync_wakeup_buggy`, `sync_wakeup`, 3 vCPUs | 1.1-1.4 s | 8-9 s, trace identical to native QEMU 11.1 |
| aarch64 v6.14, `default`, 2 vCPUs (aarch64 build of the same QEMU) | 0.65 s | 10 s, trace identical |

The wasm traces match native QEMU of the same generation byte for byte. The
published `sync_wakeup` result was made with QEMU 8.2 and differs in one step,
so that trace depends on the emulator version rather than on wasm.

## Known issue: kSTEP init race under slow emulation

x86_64 images occasionally panic at module load with a NULL dereference in
`hrtimer_active` from `kstep_tick_init`. Cause: kSTEP cancels each CPU's
`tick_sched.sched_timer`, which the kernel only initializes once that CPU
switches to high-resolution tick mode after the `tsc` clocksource replaces
`tsc-early`. At 6-20x slowdown the module can load before the isolated CPUs
got there. It never happens natively, and it is not a JIT bug (it also
reproduces with the JIT disabled, and native QEMU 11.1 traces match). The fix
is in kSTEP (`kmod/tick.c`: wait for `sched_timer.base` before cancelling);
images in the build repo predate it. Rebasing the JIT onto QEMU v11.1.0 was
tried and works, but is shelved because that build is slower and therefore
lost this race more often.
