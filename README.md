# kSTEP on WebAssembly

Runs [kSTEP](https://github.com/kstep-dev/kstep) unmodified inside a QEMU
compiled to wasm64 with Emscripten, either headless under Node or in a
browser. The aarch64 `virt` guest, kernel images, and the boot arguments from
kSTEP's `run.py` are reused as-is; kSTEP itself needs no changes.

QEMU is pinned to the v11.1.0 release plus one patch: Kohei Tokunaga's wasm
JIT backend (the `wasm64-tcg-b` branch of https://github.com/ktock/qemu,
33 commits) rebased onto the release. Upstream QEMU can already target wasm64
but only with the TCI interpreter, which is about 4x slower for kSTEP.

## Measured (default driver, 2 vCPUs, aarch64 host without KVM)

| QEMU                                              | Driver done | kstep.jsonl vs native |
|---------------------------------------------------|-------------|------------------------|
| native `qemu-system-aarch64`, TCG                 | 0.65 s      | baseline               |
| this build (v11.1.0 + JIT patch), Node 24         | 10 s        | identical              |
| upstream, TCI interpreter, V8 `--wasm-lazy-compilation` | 40 s  | differs (see Notes)    |
| upstream, TCI interpreter, V8 `--liftoff-only`    | 140 s       | not captured           |

## Layout

| File          | Purpose |
|---------------|---------|
| `build.sh`    | `setup` (apt, emsdk 4.0.23, meson) -> `deps` (zlib, libffi, pixman, glib for wasm64) -> `qemu` (v11.1.0 + `patches/`) |
| `patches/`    | the JIT backend patch applied on top of the pinned QEMU release |
| `run.mjs`, `run.sh` | headless runner for Node; `run.sh` finds emsdk's Node and passes the V8 flag |
| `index.html`  | browser UI: pick kernel, driver, vCPUs; streams the console; downloads results |
| `coi-serviceworker.min.js` | adds the COOP/COEP headers static hosts cannot send (MIT, gzuidhof/coi-serviceworker) |
| `deploy.sh`   | stages the site (page + wasm + kernel images) in `build/site` and force-pushes it to `gh-pages` |
| `serve.sh`    | stages the same site and serves it with `python3 -m http.server` for local use |

Everything generated lives under `build/` (gitignored). kSTEP images come from
`$KSTEP_DIR/build/<kernel>/{kernel,rootfs.cpio}` (built by `make KERNEL=<kernel>`).
`KSTEP_DIR` defaults to `../..` when this repo is checked out as kSTEP's
`docs/web` submodule, else to a sibling `../kstep` checkout.

## Usage

```sh
./build.sh                    # ~15 min first time; ./build.sh qemu rebuilds QEMU only (~5 min)

./run.sh --kernel v6.14 --driver default --smp 2
#   guest console -> stdout, runner status -> stderr, --quiet hides the console
#   results -> results/<kernel>-<driver>/{qemu.log,kstep.jsonl,kstep.cov}

./serve.sh 8080 v6.14         # local: http://localhost:8080/
./deploy.sh v6.14             # publish: https://kstep-dev.github.io/web/
```

Both `serve.sh` and `deploy.sh` take kernel names (default: every kernel under
`$KSTEP_DIR/build`). `deploy.sh` pushes `build/site` as an orphan `gh-pages`
branch, so no history accumulates there; GitHub Pages is set to serve that
branch. The service worker installs on first load and reloads the page once so
SharedArrayBuffer becomes available.

vCPUs always run under MTTCG, one host thread each. Browsers need wasm
Memory64: Chrome 133+ or Firefox 134+ (Safari would need a wasm32 build via
QEMU's `--enable-wasm64-32bit-address-limit`, not done here).

## Notes

* **Memory.** The wasm heap is fixed at 2300 MB (`-sTOTAL_MEMORY`). V8 also
  needs a few GB while optimizing the 20 MB module; `--wasm-lazy-compilation`
  keeps that bounded. `--liftoff-only --no-wasm-tier-up` is the safe fallback
  if Node gets OOM-killed, at roughly 3x the run time.
* **Exit.** QEMU does not exit on guest reboot under Emscripten; both runners
  detect completion from the console log.
* **Correctness.** This build reproduces the native `kstep.jsonl` exactly. The
  TCI-only upstream build, at ~60x slowdown, differed in which task was current
  on CPU 1 at steps 2-4, so something in the default driver's wakeup path still
  depends on wall time. Worth a look in kSTEP before trusting very slow hosts.
* **Rebasing the patch.** Moving `QEMU_TAG` means re-applying `patches/`; expect
  a handful of context conflicts and new `outop_*` entries to stub in
  `tcg/wasm64/tcg-target.c.inc` as TCG grows ops.
* **Not tried / dropped.** A virt-only device config (`--with-devices-aarch64`)
  cut QEMU compile time from ~5 min to ~80 s but only shrank the wasm by 5-25%
  and kept tripping Kconfig dependencies, so the default device set is used.
  Lowering the JIT's `INSTANTIATE_NUM` threshold was not measured.
