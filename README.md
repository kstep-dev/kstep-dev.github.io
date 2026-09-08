# kSTEP on WebAssembly

Runs [kSTEP](https://github.com/kstep-dev/kstep) unmodified inside a QEMU
compiled to wasm64 with Emscripten, either headless under Node or in a
browser: https://kstep-dev.github.io/web/. The x86_64 guest, the prebuilt
kernel images from the [kstep-dev/build](https://github.com/kstep-dev/build)
repo, and the boot arguments from kSTEP's `run.py` are reused as-is; kSTEP
itself needs no changes. The published page fetches the images straight from
that repo on GitHub, so the site only carries the 12 MB QEMU build.

QEMU is Kohei Tokunaga's `wasm64-tcg-b` branch of https://github.com/ktock/qemu
(QEMU 10.2.50 plus his 33-commit wasm JIT backend), pinned to a commit in
`build.sh`. Upstream QEMU can already target wasm64 but only with the TCI
interpreter, which is about 4x slower for kSTEP. Rebasing the backend onto the
v11.1.0 release was tried (see Notes) and shelved.

## Measured (aarch64 host without KVM, Node 24)

| Guest / QEMU                                             | Driver done | kstep.jsonl |
|----------------------------------------------------------|-------------|-------------|
| x86_64 `sync_wakeup_buggy`, native QEMU 8.2 TCG           | 1.4 s       | matches the published results repo |
| x86_64 `sync_wakeup_buggy`, this build (wasm32-lowered)   | 8.3-8.6 s   | identical to native QEMU 11.1; one line differs from QEMU 8.2 (see Notes) |
| aarch64 v6.14 `default`, native TCG                       | 0.65 s      | baseline |
| aarch64 v6.14 `default`, same QEMU built for aarch64      | 10 s        | identical |
| aarch64, upstream TCI interpreter instead of the JIT      | 40-140 s    | differs |

## Layout

| File          | Purpose |
|---------------|---------|
| `build.sh`    | `setup` (apt, emsdk 4.0.23, meson) -> `deps` (zlib, libffi, pixman, glib for wasm64) -> `qemu` (x86_64-softmmu from the pinned branch) |
| `run.mjs`, `run.sh` | headless runner for Node; `run.sh` finds emsdk's Node and passes the V8 flag |
| `index.html`  | browser UI: pick kernel (driver, vCPUs, RAM prefilled from `reproduce.py`); streams the console; downloads results |
| `coi-serviceworker.min.js` | adds the COOP/COEP headers static hosts cannot send (MIT, gzuidhof/coi-serviceworker) |
| `deploy.sh`   | stages the site (page + wasm + SeaBIOS + `kernels.json`) in `build/site` and force-pushes it to `gh-pages` |
| `serve.sh`    | stages the same site with the local `build/` images copied in and serves it with `python3 -m http.server` |

Everything generated lives under `build/` (gitignored). kSTEP images come from
`$KSTEP_DIR/build/<kernel>/{kernel,rootfs.cpio}` (built by `make KERNEL=<kernel>`).
`KSTEP_DIR` defaults to `../..` when this repo is checked out as kSTEP's
`docs/web` submodule, else to a sibling `../kstep` checkout.

## Usage

```sh
./build.sh                    # ~15 min first time; ./build.sh qemu rebuilds QEMU only

./run.sh --kernel sync_wakeup_buggy          # driver, vCPUs default from the kernel name / reproduce.py
#   guest console -> stdout, runner status -> stderr, --quiet hides the console
#   results -> results/<kernel>-<driver>/{qemu.log,kstep.jsonl,kstep.cov}

./serve.sh 8080               # local: http://localhost:8080/, kernels from $KSTEP_DIR/build
./deploy.sh                   # publish: https://kstep-dev.github.io/web/
```

`deploy.sh` writes `kernels.json` from the images committed in the build repo
plus `num_cpus`/`mem_mb` parsed out of `reproduce.py`, and points `base` at
`raw.githubusercontent.com/kstep-dev/build/<commit pinned by kSTEP's build submodule>`; the browser fetches the
kernel and initramfs from there at run time. It pushes `build/site` as an
orphan `gh-pages` branch, so no history accumulates. The service worker
installs on first load and reloads the page once so SharedArrayBuffer becomes
available.

vCPUs always run under MTTCG, one host thread each. Guest RAM is capped at
1024 MB: the wasm heap is fixed at 2 GB (the wasm32 lowering clamps the
requested 2300 MB), so `long_balance` (4096 MB in `reproduce.py`) does not fit.

The binary is built with QEMU's `--enable-wasm64-32bit-address-limit`: the C
code keeps 64-bit pointers but Emscripten lowers the output to wasm32 with a
4 GB address limit, so it runs on engines without Memory64 (Safari, Chrome
before 133, Firefox before 134) as well as on current ones. Dropping the flag
gives a true wasm64 binary that needs Memory64 support.

## Notes

* **Memory.** The wasm heap is fixed at 2300 MB (`-sTOTAL_MEMORY`). V8 also
  needs a few GB while optimizing the 20 MB module; `--wasm-lazy-compilation`
  keeps that bounded. `--liftoff-only --no-wasm-tier-up` is the safe fallback
  if Node gets OOM-killed, at roughly 3x the run time.
* **Output path.** The three chardevs write to `/dev/kstep0..2`, Emscripten
  device nodes whose JavaScript write callbacks receive every byte as QEMU emits
  it, so console lines are pushed to the page (and to stdout in `run.mjs`)
  without polling. QEMU does not exit on guest reboot under Emscripten; both
  runners treat the reboot line on the console as completion.
* **Single-threaded TCG** (`thread=single`) aborts in this backend with
  `Assertion failed: icount_enabled()`; only MTTCG is usable.
* **Correctness.** Native QEMU reproduces the published `kstep.jsonl` for
  `sync_wakeup_buggy` exactly. Under wasm (6-20x slower) the trace usually
  differs in one step (a wakeup lands a tick late) and, when the host is
  overloaded, kthread pids and the tick count until the bug triggers change
  too. The aarch64 v6.14 default driver was stable across a dozen wasm runs.
  So the emulation is faithful, but kSTEP's stepping still has wall-clock
  dependence (kthreadd creation order, IPI tick delivery) that only shows on
  slow hosts. Worth fixing in kSTEP before treating browser traces as
  authoritative.
* **Rebase attempt.** The 33 commits apply to v11.1.0 with two one-line context
  fixes, the `wasm64_32bit_address_limit` build option, and seven new
  `outop_*` stubs. That build ran aarch64 kSTEP correctly but x86_64 guests hit
  an intermittent NULL dereference in `kstep_tick_init` (`tick_get_tick_sched`
  returning 0), never with the JIT disabled and never on the original branch,
  so a translation is miscompiled somewhere in the rebased combination. Not
  yet isolated; the original branch is used instead.
* **Not tried / dropped.** A virt-only device config (`--with-devices-aarch64`)
  cut QEMU compile time from ~5 min to ~80 s but only shrank the wasm by 5-25%
  and kept tripping Kconfig dependencies, so the default device set is used.
  Lowering the JIT's `INSTANTIATE_NUM` threshold was not measured.
