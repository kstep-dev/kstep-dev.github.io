// Shared by index.html (browser) and run.mjs (Node): boot kSTEP's `cli` driver in the wasm
// QEMU and talk to it.
//
//   const { cmd, state, done } = await runKstep(Module, { files, smp, mem, params, onConsole, onEvent });
//   await cmd(null);                 // the driver's ready line
//   const reply = await cmd('tick'); // one command in flight at a time, replies in order
//   const { cpus, tasks } = state(); // the machine's state, read out of guest memory
//   const { panic } = await done;    // QEMU never exits under Emscripten: the console's reboot line marks the end
//
// files: { kernel, rootfs } as Uint8Array / ArrayBuffer (the arm64 Image and the initramfs).
// params: extra kSTEP module parameters after the `--` (topology=, capacity=, ...).
// The driver's JSON port (/dev/hvc0 in the guest) is one ordered stream: command replies
// (a "timestamp" and no "type") interleaved with trace events ("type"). Replies resolve the
// pending cmd(); events go to onEvent(record, line). Kernel console lines go to onConsole(line).
// State is not in the stream: the driver rewrites a table in guest memory after every command
// (kmod/state.h) and reports its physical address on the ready line; QEMU's monitor turns that
// into an offset in the wasm heap (gpa2hva) and state() decodes the table in place.
// locateFile/wasmBinary are passed through to the Emscripten module.

export function qemuArgs({ smp, mem, params = {} }) {
  const isol = smp > 2 ? `1-${smp - 1}` : '1';   // kSTEP's run.py arguments for aarch64
  const append = `rw nokaslr loglevel=7 sched_verbose isolcpus=nohz,managed_irq,${isol} irqaffinity=0 ` +
    `rcu_nocbs=${isol} nohz_full=${isol} init=/user panic=-1 console=ttyAMA0 earlycon -- driver=cli` +
    Object.entries(params).filter(([, v]) => v).map(([k, v]) => ` ${k}=${v}`).join('');
  return [
    '-machine', 'virt', '-cpu', 'cortex-a57', '-smp', String(smp), '-m', `${mem}M`,
    '-accel', 'tcg,tb-size=64,thread=multi',
    '-kernel', '/kernel', '-initrd', '/rootfs.cpio', '-append', append,
    '-nographic', '-nodefaults', '-no-reboot',
    // Emscripten device nodes: the PL011 console (write-only), the driver's hvc0, a virtio
    // console port on virtio-mmio (one virtqueue kick per write where a UART costs one MMIO exit
    // per byte) opened read-write as a pipe chardev so commands can go in, and QEMU's own monitor.
    '-chardev', 'file,id=c0,path=/dev/console0', '-serial', 'chardev:c0',
    '-device', 'virtio-serial-device,id=vs0',
    '-chardev', 'pipe,id=c1,path=/dev/hvc0', '-device', 'virtconsole,bus=vs0.0,nr=0,chardev=c1',
    '-chardev', 'pipe,id=c2,path=/dev/monitor', '-monitor', 'chardev:c2',
  ];
}

// kmod/state.h, byte for byte: little-endian, u32/u64 fields, natural alignment.
const HDR = 16, CPU_STRIDE = 64, TASK_STRIDE = 104, MAX_CPUS = 8, MAX_TASKS = 64;
const STATE_SIZE = HDR + MAX_CPUS * CPU_STRIDE + MAX_TASKS * TASK_STRIDE;
const TASK_STATES = ['running', 'runnable', 'sleeping', 'blocked'];
const POLICIES = { 0: 'normal', 1: 'fifo', 2: 'rr', 3: 'batch', 5: 'idle' };   // the kernel's SCHED_* numbers
function decodeState(view, bytes) {
  for (;;) {
    const gen = view.getUint32(0, true);
    if (gen & 1) continue;   // the writer is mid-update
    const ncpus = view.getUint32(8, true), ntasks = view.getUint32(12, true);
    const u32 = (o) => view.getUint32(o, true), u64 = (o) => Number(view.getBigUint64(o, true));
    const cpus = Array.from({ length: ncpus }, (_, i) => { const o = HDR + i * CPU_STRIDE; return {
      cpu: u32(o), current: u32(o + 4), idle: !!u32(o + 8), capacity: u32(o + 12), nr_running: u64(o + 16), nr_switches: u64(o + 24),
      min_vruntime: u64(o + 32), cfs_util_avg: u64(o + 40), cfs_load_avg: u64(o + 48), cfs_runnable_avg: u64(o + 56) }; });
    const tasks = Array.from({ length: ntasks }, (_, i) => { const o = HDR + MAX_CPUS * CPU_STRIDE + i * TASK_STRIDE; const flags = u32(o + 20); return {
      task: u32(o), state: TASK_STATES[u32(o + 4)], cpu: u32(o + 8), policy: POLICIES[u32(o + 12)] ?? '?', nice: view.getInt32(o + 16, true),
      eligible: !!(flags & 1), delayed: !!(flags & 2), cpus: u64(o + 24), weight: u64(o + 32), sum_exec_runtime: u64(o + 40), vruntime: u64(o + 48),
      deadline: u64(o + 56), slice: u64(o + 64), cgroup: new TextDecoder().decode(bytes.slice(o + 72, o + 72 + bytes.subarray(o + 72, o + 104).indexOf(0))) }; });   // slice: TextDecoder refuses shared memory
    if (view.getUint32(0, true) === gen) return { timestamp: view.getUint32(4, true), cpus, tasks };
  }
}

export async function runKstep(Module, { files, smp, mem, params, onConsole, onEvent, locateFile, wasmBinary, log = console.error }) {
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });
  const waiters = [];   // pending cmd() resolvers
  const lineSink = (onLine) => { let buf = ''; return (byte) => { if (byte === 10) { onLine(buf); buf = ''; } else buf += String.fromCharCode(byte); }; };
  const console_ = lineSink((line) => {
    onConsole?.(line);
    if (line.includes('reboot: Restarting system') || line.includes('Kernel panic'))
      resolveDone({ panic: line.includes('Kernel panic') });
  });
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
  let sendCmd, sendMon, resolveHva, view, bytes;
  const hva = new Promise(r => { resolveHva = r; });
  // The module's memory, created here so guest RAM can be read: 1 GB (setup.sh's TOTAL_MEMORY),
  // shared between the vCPU workers and this thread.
  const wasmMemory = new WebAssembly.Memory({ initial: 16384, maximum: 16384, shared: true });
  const module = await Module({
    locateFile, wasmBinary, wasmMemory,
    arguments: qemuArgs({ smp, mem, params }),
    preRun: [(m) => {
      m.FS.writeFile('/kernel', new Uint8Array(files.kernel));
      m.FS.writeFile('/rootfs.cpio', new Uint8Array(files.rootfs));
      m.FS.createDevice('/dev', 'console0', null, console_);
      sendCmd = pipe(m, '/dev/hvc0', 1, (line) => { const o = JSON.parse(line); if ('type' in o) onEvent?.(o, line); else waiters.shift()?.(o); });
      sendMon = pipe(m, '/dev/monitor', 2, (line) => { const m = /Host virtual address for 0x[0-9a-f]+ .* is 0x([0-9a-f]+)/.exec(line); if (m) resolveHva(parseInt(m[1], 16)); });
    }],
    print: (s) => log('[qemu] ' + s),
    printErr: (s) => { if (!s.includes('unsupported syscall')) log('[qemu] ' + s); },
  });
  const cmd = async (line) => {
    const reply = await new Promise(r => { waiters.push(r); if (line !== null) sendCmd(line); });
    if (line === null && reply.state !== undefined) {   // the ready line names the state table; map it once
      sendMon(`gpa2hva 0x${reply.state.toString(16)}`);
      const at = await hva;   // a host virtual address is an offset into the wasm heap
      bytes = new Uint8Array(wasmMemory.buffer, at, STATE_SIZE);
      view = new DataView(wasmMemory.buffer, at, STATE_SIZE);
    }
    return reply;
  };
  const state = () => decodeState(view, bytes);
  return { module, cmd, state, done };
}
