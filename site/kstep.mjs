// Shared by index.html (browser) and run.mjs (Node): boot kSTEP's `cli` driver in the wasm
// QEMU and talk to it.
//
//   const { cmd, shm, events } = await runKstep(Module, { files, smp, mem, onConsole });
//   await cmd(null);                 // the driver's ready line
//   const reply = await cmd('tick'); // one command in flight at a time, replies in order
//   const { cpus, tasks } = shm();   // the machine's state, read out of guest memory
//   const trace = events();          // trace records seen since the last call
//
// QEMU never exits under Emscripten: the console's `reboot:` or `Kernel panic` line (onConsole)
// marks the end.
// files: { kernel, rootfs } as Uint8Array / ArrayBuffer (the arm64 Image and the initramfs).
// The machine itself is set with cli commands, not boot parameters.
// The three channels are Emscripten device nodes named as in crates/core/src/qemu.rs: the
// console, the driver's port and QEMU's monitor. The driver's JSON port is one ordered stream: command replies
// (a "timestamp" and no "type") interleaved with trace events ("type"). Replies resolve the
// pending cmd(); events are queued for events(). Because the stream is ordered, every event of a
// command has arrived by the time its reply resolves.
// State is not in the stream: the driver rewrites a region of guest memory after every command
// (kmod/shm.h); the ready line reports its physical address, QEMU's monitor turns that into an
// offset in the wasm heap (gpa2hva), and shm() decodes a copy of it with kSTEP's Rust decoder.
// locateFile is passed through to the Emscripten module.

// kSTEP's core (crates/core, compiled to wasm and placed next to this file by `kstep viz`) knows
// QEMU's arguments and decodes the machine's state (shm.rs, whose structs are generated from
// kmod/shm.h). It runs in its own wasm instance, so the region is copied out of QEMU's memory
// per call: a few hundred KB. JS owns that memory and so the seqlock retry: a null result means
// mid-update.
async function loadCore() {
  const v = new URL(import.meta.url).search;   // the page's cache-busting ?v=, carried over
  const core = await import(`./kstep_core.js${v}`);
  const wasm = new URL(`./kstep_core_bg.wasm${v}`, import.meta.url);
  // fetch() has no file: scheme under Node; hand the bytes over there
  const bytes = typeof window === 'undefined' ? (await import('node:fs')).readFileSync(wasm) : undefined;
  await core.default({ module_or_path: bytes ?? wasm });
  return core;
}

export async function runKstep(Module, { files, smp, mem, onConsole, locateFile, log = console.error }) {
  const core = await loadCore();
  const waiters = [];   // pending cmd() resolvers
  const lineSink = (onLine) => { let buf = ''; return (byte) => { if (byte === 10) { onLine(buf); buf = ''; } else buf += String.fromCharCode(byte); }; };
  // A bidirectional device: bytes we queue are the guest's input, its output goes to the sink.
  // FS ops run on the main thread (QEMU's thread is proxied to it), so the queue is plain JS state.
  const pipe = (m, path, minor, onLine) => {
    const inq = [], sink = lineSink(onLine), dev = m.FS.makedev(64, minor);
    m.FS.registerDevice(dev, {
      open(stream) { stream.seekable = false; },
      close() {},
      read(stream, buffer, offset, length) {
        let n = 0;
        while (n < length && inq.length) buffer[offset + n++] = inq.shift();
        if (n === 0) throw new m.FS.ErrnoError(6);   // EAGAIN: nothing queued
        return n;
      },
      write(stream, buffer, offset, length) { for (let i = 0; i < length; i++) sink(buffer[offset + i]); return length; },
      poll() { return (inq.length ? 1 : 0) | 4; },   // POLLIN when input is queued, always POLLOUT
    });
    m.FS.mkdev(path, 0o666, dev);
    return (line) => { for (const b of new TextEncoder().encode(line + '\n')) inq.push(b); };
  };
  let sendCmd, sendMon, resolveHva, bytes;
  const trace = [];   // trace records from the stream, drained by events()
  const hva = new Promise(r => { resolveHva = r; });
  // The module's memory, created here so guest RAM can be read: 1 GB (setup.sh's TOTAL_MEMORY),
  // shared between the vCPU workers and this thread.
  const wasmMemory = new WebAssembly.Memory({ initial: 16384, maximum: 16384, shared: true });
  await Module({
    locateFile, wasmMemory,
    arguments: core.qemu_args(smp, mem),
    preRun: [(m) => {
      m.FS.writeFile('/kernel', new Uint8Array(files.kernel));
      m.FS.writeFile('/rootfs.cpio', new Uint8Array(files.rootfs));
      m.FS.createDevice('/dev', 'console', null, lineSink((line) => onConsole?.(line)));
      sendCmd = pipe(m, '/dev/port', 1, (line) => { const o = JSON.parse(line); if ('type' in o) trace.push(o); else waiters.shift()?.(o); });
      sendMon = pipe(m, '/dev/monitor', 2, (line) => { const m = /Host virtual address for 0x[0-9a-f]+ .* is 0x([0-9a-f]+)/.exec(line); if (m) resolveHva(parseInt(m[1], 16)); });
    }],
    print: (s) => log('[qemu] ' + s),
    printErr: (s) => { if (!s.includes('unsupported syscall')) log('[qemu] ' + s); },
  });
  const cmd = async (line) => {
    const reply = await new Promise(r => { waiters.push(r); if (line !== null) sendCmd(line); });
    if (line === null && reply.shm !== undefined) {   // the ready line names the shared region; map it once
      sendMon(`gpa2hva 0x${reply.shm.toString(16)}`);
      const at = await hva;   // a host virtual address is an offset into the wasm heap
      bytes = new Uint8Array(wasmMemory.buffer, at, core.shm_size());
    }
    return reply;
  };
  const shm = () => { for (;;) { const st = core.shm_decode(bytes.slice()); if (st) return st; } };
  const events = () => trace.splice(0);   // the records seen since the last call
  return { cmd, shm, events };
}
