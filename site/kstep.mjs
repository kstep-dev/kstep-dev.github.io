// Shared by index.html (browser) and run.mjs (Node): boot kSTEP's `cli` driver in the wasm
// QEMU and talk to it.
//
//   const { cmd, shm, done } = await runKstep(Module, { files, smp, mem, params, onConsole, onEvent });
//   await cmd(null);                 // the driver's ready line
//   const reply = await cmd('tick'); // one command in flight at a time, replies in order
//   const { cpus, tasks } = shm();   // the machine's state, read out of guest memory
//   const trace = events();          // trace records seen since the last call
//   const { panic } = await done;    // QEMU never exits under Emscripten: the console's reboot line marks the end
//
// files: { kernel, rootfs } as Uint8Array / ArrayBuffer (the arm64 Image and the initramfs).
// params: extra kSTEP module parameters after the `--` (the machine itself is set with
// cli commands, not boot parameters).
// The driver's JSON port (/dev/hvc0 in the guest) is one ordered stream: command replies
// (a "timestamp" and no "type") interleaved with trace events ("type"). Replies resolve the
// pending cmd(); events go to onEvent(record, line) and are queued for events(). Because the
// stream is ordered, every event of a command has arrived by the time its reply resolves.
// State is not in the stream: the driver rewrites a region of guest memory
// after every command (kmod/shm.h); the ready line
// reports its physical address, QEMU's monitor turns that into an offset in the wasm heap
// (gpa2hva), and shm() decodes it in place.
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

// kmod/shm.h, byte for byte: little-endian, u32/u64 fields, natural alignment.
// The region describes itself (kmod/shm.h): the header carries where each table starts, how wide
// its records are and how many fit, so nothing here hardcodes a stride or an offset. Only magic,
// layout and gen sit at fixed places. LAYOUT is bumped by the kmod when a record's fields change
// meaning without changing its size -- everything that resizes is already caught by the strides.
const MAGIC = 0x5054536b, LAYOUT = 2;
const HDR_SIZE = 96;       // the header itself; a change here bumps LAYOUT
const SHM_MAX = 1 << 20;   // a sanity bound on what the header may claim, before we map it
const TASK_STATES = ['running', 'runnable', 'sleeping', 'blocked'];
const POLICIES = { 0: 'normal', 1: 'fifo', 2: 'rr', 3: 'batch', 5: 'idle' };   // the kernel's SCHED_* numbers
const cstr = (bytes, o, n) => new TextDecoder().decode(bytes.slice(o, o + Math.max(0, bytes.subarray(o, o + n).indexOf(0))));   // slice: TextDecoder refuses shared memory
// Read the shape once, and refuse a region this decoder was not built for rather than reading
// plausible nonsense out of it.
function shmLayout(view) {
  const u32 = (o) => view.getUint32(o, true);
  const magic = u32(0), layout = u32(4);
  if (magic !== MAGIC) throw new Error(`not a kSTEP shared region (magic ${magic.toString(16)})`);
  if (layout !== LAYOUT) throw new Error(`shm layout ${layout}, this page speaks ${LAYOUT}: rebuild the image from the current kmod`);
  const L = {
    cpuOff: u32(32), cpuStride: u32(36), taskOff: u32(40), taskStride: u32(44),
    cgroupOff: u32(48), cgroupStride: u32(52), domainOff: u32(56), domainStride: u32(60),
    maxCpus: u32(64), maxTasks: u32(68), maxCgroups: u32(72), maxDomains: u32(76),
    maxGroups: u32(80), groupStride: u32(84),
  };
  L.size = L.domainOff + L.maxDomains * L.domainStride;
  if (!(L.size > 0 && L.size <= SHM_MAX)) throw new Error(`shm header claims ${L.size} bytes`);
  return L;
}
function decodeShm(view, bytes, L) {
  for (;;) {
    const gen = view.getUint32(8, true);
    if (gen & 1) continue;   // the writer is mid-update
    const ncpus = view.getUint32(16, true), ntasks = view.getUint32(20, true), ngroups = view.getUint32(24, true);
    const ndomains = view.getUint32(28, true);
    if (ncpus > L.maxCpus || ntasks > L.maxTasks || ngroups > L.maxCgroups || ndomains > L.maxDomains) continue;   // mid-update
    const u32 = (o) => view.getUint32(o, true), u64 = (o) => Number(view.getBigUint64(o, true));
    const cpus = Array.from({ length: ncpus }, (_, i) => { const o = L.cpuOff + i * L.cpuStride; return {
      cpu: u32(o), current: u32(o + 4), idle: !!u32(o + 8), capacity: u32(o + 12), freq: u32(o + 16), nr_running: u64(o + 24), nr_switches: u64(o + 32),
      min_vruntime: u64(o + 40), cfs_util_avg: u64(o + 48), cfs_load_avg: u64(o + 56), cfs_runnable_avg: u64(o + 64),
      // what the balancer reads, as against what the runqueue holds
      h_nr_runnable: u64(o + 72), next_balance_in: u32(o + 80) }; });
    const tasks = Array.from({ length: ntasks }, (_, i) => { const o = L.taskOff + i * L.taskStride; const flags = u32(o + 20); return {
      task: u32(o), state: TASK_STATES[u32(o + 4)], cpu: u32(o + 8), policy: POLICIES[u32(o + 12)] ?? '?', nice: view.getInt32(o + 16, true),
      eligible: !!(flags & 1), delayed: !!(flags & 2), cpus: u64(o + 24), weight: u64(o + 32), sum_exec_runtime: u64(o + 40), vruntime: u64(o + 48),
      deadline: u64(o + 56), slice: u64(o + 64), cgroup: cstr(bytes, o + 72, 32) }; });
    // the cgroups the kernel holds, the root ("/") first, in tree order
    const groups = Array.from({ length: ngroups }, (_, i) => { const o = L.cgroupOff + i * L.cgroupStride; return {
      path: cstr(bytes, o, 40), cpus: u64(o + 40), weight: u32(o + 48) }; });
    // the sched domains the kernel built, per CPU and innermost first -- not the topology asked for
    const domains = Array.from({ length: ndomains }, (_, i) => { const o = L.domainOff + i * L.domainStride; const n = u32(o + 4); return {
      cpu: u32(o), span: u64(o + 8), name: cstr(bytes, o + 16, 8), flags: cstr(bytes, o + 24, 160),
      imbalance_pct: u32(o + 184), balance_interval: u32(o + 188),
      busy_factor: u32(o + 192), cache_nice_tries: u32(o + 196),
      nr_balance_failed: u32(o + 200), last_balance_ago: u32(o + 204),
      groups: Array.from({ length: Math.min(n, L.maxGroups) }, (_, j) => { const g = o + 208 + j * L.groupStride; return {
        span: u64(g), capacity: u32(g + 8), min_capacity: u32(g + 12), max_capacity: u32(g + 16), weight: u32(g + 20) }; }) }; });
    if (view.getUint32(8, true) === gen) return { timestamp: view.getUint32(12, true), cpus, tasks, groups, domains };
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
  let sendCmd, sendMon, resolveHva, view, bytes, layout;
  const trace = [];   // trace records from the stream, drained by events()
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
      sendCmd = pipe(m, '/dev/hvc0', 1, (line) => { const o = JSON.parse(line); if ('type' in o) { trace.push(o); onEvent?.(o, line); } else waiters.shift()?.(o); });
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
      // the header first, since it says how big the rest is and whether we can read it at all
      layout = shmLayout(new DataView(wasmMemory.buffer, at, HDR_SIZE));
      bytes = new Uint8Array(wasmMemory.buffer, at, layout.size);
      view = new DataView(wasmMemory.buffer, at, layout.size);
    }
    return reply;
  };
  const shm = () => decodeShm(view, bytes, layout);
  const events = () => trace.splice(0);   // the records seen since the last call
  return { module, cmd, shm, events, done };
}
