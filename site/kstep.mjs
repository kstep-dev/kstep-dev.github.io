// Shared by index.html (browser) and run.mjs (Node): boot kSTEP's `cli` driver in the wasm
// QEMU and talk to it.
//
//   const { cmd, shm, events, snapshot } = await runKstep(Module, { files, smp, mem, onConsole, locateFile });
//   await cmd(null);                 // the driver's ready line
//   const stream = await snapshot(); // the machine as it is now, to boot from next time (below)
//   const reply = await cmd('tick'); // one command in flight at a time, replies in order
//   const { cpus, tasks } = shm();   // the machine's state, read out of guest memory
//   const trace = events();          // trace records seen since the last call
//
// QEMU never exits under Emscripten: the console's `reboot:` or `Kernel panic` line (onConsole)
// marks the end.
// files: { kernel, rootfs } as Uint8Array / ArrayBuffer (the arm64 Image and the initramfs), or
// { snapshot, ready }: a migration stream from snapshot() and the ready line it was taken at, so
// the machine resumes where that boot stood (~0.3 s instead of ~4 s) and cmd(null) answers at
// once. A snapshot fits only the QEMU build, smp and mem it was taken with.
// The machine itself is set with cli commands, not boot parameters.
// The three channels are Emscripten device nodes named as in crates/core/src/qemu.rs: the
// kernel log, kSTEP's own (kmod/io.c) and QEMU's monitor. kSTEP's is one ordered stream: command replies
// (a "timestamp" and no "type") interleaved with trace events ("type"). Replies resolve the
// pending cmd(); events are queued for events(). Because the stream is ordered, every event of a
// command has arrived by the time its reply resolves.
// State is not in the stream: the driver rewrites a region of guest memory after every command
// (kmod/shm.h); the ready line reports its physical address, QEMU's monitor turns that into an
// offset in the wasm heap (gpa2hva), and shm() decodes a copy of it with kSTEP's Rust decoder.
// locateFile is passed through to the Emscripten module; QEMU's own stdout and stderr go to console.error.

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

// The staged image's files for an smp, as runKstep takes them: its snapshot when it has one for
// that smp (run.mjs --snapshot: the machine at the driver's ready line, gzip'd, with the ready
// line and the console lines of that boot in a JSON next to it), else the kernel and initramfs.
// get(name) reads a file of the stage as an ArrayBuffer, null when it is not there.
export async function image(smp, get) {
  const meta = await get(`snap-${smp}.json`);
  if (!meta) return { kernel: await get('kernel'), rootfs: await get('rootfs.cpio') };
  const gz = await get(`snap-${smp}.bin.gz`);
  const snapshot = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const { ready, console } = JSON.parse(new TextDecoder().decode(meta));
  return { snapshot, ready, console };
}

export async function runKstep(Module, { files, smp, mem, onConsole, locateFile }) {
  const core = await loadCore();
  const lineSink = (onLine) => { let buf = ''; return (byte) => { if (byte === 10) { onLine(buf); buf = ''; } else buf += String.fromCharCode(byte); }; };
  // A bidirectional device: send() queues a line as the guest's input, next() resolves with the
  // guest's next output line. FS ops run on the main thread (QEMU's thread is proxied to it),
  // so the queues are plain JS state.
  const pipe = (m, path, minor) => {
    const inq = [], lines = [], readers = [], dev = m.FS.makedev(64, minor);
    const sink = lineSink((line) => (readers.shift() ?? ((l) => lines.push(l)))(line));
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
    return {
      send: (line) => { for (const b of new TextEncoder().encode(line + '\n')) inq.push(b); },
      next: () => lines.length ? Promise.resolve(lines.shift()) : new Promise(r => readers.push(r)),
    };
  };
  let kstep, mon, bytes, fsys;
  const trace = [];   // trace records from the stream, drained by events()
  // The module's memory, created here so guest RAM can be read: 1 GB (setup.sh's TOTAL_MEMORY),
  // shared between the vCPU workers and this thread.
  const wasmMemory = new WebAssembly.Memory({ initial: 16384, maximum: 16384, shared: true });
  await Module({
    locateFile, wasmMemory,
    arguments: core.qemu_args(smp, mem, !!files.snapshot),
    preRun: [(m) => {
      fsys = m.FS;
      if (files.snapshot) m.FS.writeFile('/snap', new Uint8Array(files.snapshot));
      else { m.FS.writeFile('/kernel', new Uint8Array(files.kernel)); m.FS.writeFile('/rootfs.cpio', new Uint8Array(files.rootfs)); }
      m.FS.createDevice('/', 'kernel.log', null, lineSink((line) => onConsole?.(line)));
      kstep = pipe(m, '/kstep', 1);
      mon = pipe(m, '/monitor', 2);
    }],
    print: (s) => console.error('[qemu] ' + s),
    printErr: (s) => console.error('[qemu] ' + s),
  });
  // One command in flight at a time: the reply is the next record without a "type"; the trace
  // events a command's hooks wrote come before it on the same ordered stream.
  const cmd = async (line) => {
    let reply;
    if (line === null && files.ready) reply = files.ready;   // a resumed machine's driver printed its ready line before the snapshot
    else {
      if (line !== null) kstep.send(line);
      for (;;) { const o = JSON.parse(await kstep.next()); if ('type' in o) trace.push(o); else { reply = o; break; } }
    }
    if (line === null && reply.shm !== undefined) {   // the ready line names the shared region; map it once
      mon.send(`gpa2hva 0x${reply.shm.toString(16)}`);
      for (;;) {   // the monitor echoes the command first; the answer is a host virtual address, an offset into the wasm heap
        const m = /Host virtual address for 0x[0-9a-f]+ .* is 0x([0-9a-f]+)/.exec(await mon.next());
        if (m) { bytes = new Uint8Array(wasmMemory.buffer, parseInt(m[1], 16), core.shm_size()); break; }
      }
    }
    return reply;
  };
  const shm = () => { for (;;) { const st = core.shm_decode(bytes.slice()); if (st) return st; } };
  const events = () => trace.splice(0);   // the records seen since the last call
  // The machine's state as a migration stream (RAM and devices; zero pages are skipped, so it is
  // ~14 MB for 64 MB of RAM, ~3 MB gzip'd). Between commands the guest is idle, so the stream
  // converges at once. The monitor answers nothing once the machine is stopped, which the stream's
  // completion does, so its end is read from the file: it stops growing and closes with the JSON
  // device description that follows the stream's EOF marker. The machine stays stopped.
  const snapshot = async () => {
    mon.send('migrate file:/snap');
    let size = 0, same = 0;
    for (;;) {
      await new Promise(r => setTimeout(r, 200));
      let now = 0; try { now = fsys.stat('/snap').size; } catch {}
      same = now > 0 && now === size ? same + 1 : 0; size = now;
      if (same >= 3) break;
    }
    const stream = fsys.readFile('/snap');
    if (stream[stream.length - 1] !== 0x7d) throw new Error('snapshot: incomplete migration stream');   // '}'
    return stream;
  };
  return { cmd, shm, events, snapshot };
}
