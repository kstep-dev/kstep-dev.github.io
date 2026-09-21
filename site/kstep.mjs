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
// The region describes itself: the header carries one descriptor per table (count, capacity,
// offset, stride), so nothing here hardcodes where a table is or how wide its records are. Only
// magic, layout and gen sit at fixed places. LAYOUT is bumped by the kmod when a record's fields
// change meaning without changing its size -- everything that resizes is already caught by the
// strides.
const MAGIC = 0x5054536b, LAYOUT = 6;
const HDR_SIZE = 160;      // the header itself; a change here bumps LAYOUT
// kmod/shm.h's enum kstep_shm_tables, in order: the machine and the tasks, then a queue table and
// a member table per scheduling class
const TABLES = ['cpus', 'tasks', 'groups', 'domains', 'cfs', 'entities', 'rt', 'rt_entities'];
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
  const L = { tables: {} };
  TABLES.forEach((name, i) => { const o = 16 + i * 16; L.tables[name] = { countAt: o, max: u32(o + 4), off: u32(o + 8), stride: u32(o + 12) }; });
  L.maxGroups = u32(16 + TABLES.length * 16); L.groupStride = u32(20 + TABLES.length * 16);
  L.size = Math.max(...Object.values(L.tables).map(t => t.off + t.max * t.stride));
  if (!(L.size > 0 && L.size <= SHM_MAX)) throw new Error(`shm header claims ${L.size} bytes`);
  return L;
}
function decodeShm(view, bytes, L) {
  for (;;) {
    const gen = view.getUint32(8, true);
    if (gen & 1) continue;   // the writer is mid-update
    const u32 = (o) => view.getUint32(o, true), u64 = (o) => Number(view.getBigUint64(o, true));
    // one table: its records as `decode` reads them, at the stride the kmod declared
    const table = (name, decode) => { const t = L.tables[name], n = u32(t.countAt);
      if (n > t.max) return null;   // mid-update
      return Array.from({ length: n }, (_, i) => decode(t.off + i * t.stride)); };
    // struct kstep_shm_se, the block a task record and a group-entity record share. The flags are
    // the kernel's answers (kmod/shm.h): the page draws them and derives nothing.
    const se = (o) => { const flags = u32(o); return { eligible: !!(flags & 1), delayed: !!(flags & 2), on_rq: !!(flags & 4), curr: !!(flags & 8), pick: !!(flags & 16),
      share: u32(o + 4) / 1024, weight: u64(o + 8), sum_exec_runtime: u64(o + 16), vruntime: u64(o + 24), deadline: u64(o + 32), slice: u64(o + 40), lag: Number(view.getBigInt64(o + 48, true)) }; };
    // the runqueue itself: nothing here belongs to one class; each class's queue on the CPU is a
    // record in that class's table, joined by cpu
    const cpus = table('cpus', (o) => ({
      cpu: u32(o), current: u32(o + 4), idle: !!u32(o + 8), capacity: u32(o + 12), freq: u32(o + 16), next_balance_in: u32(o + 20),
      nr_running: u64(o + 24), nr_switches: u64(o + 32) }));
    // the cgroups the kernel holds, the root ("/") first, in tree order: their configuration.
    // Decoded before the tasks and entities, which name their cgroup by its row here.
    const groups = table('groups', (o) => ({ path: cstr(bytes, o, 40), cpus: u64(o + 40), weight: u32(o + 48) }));
    const groupPath = (i) => groups?.[i]?.path ?? '/';
    // a task's identity and attributes; what its class makes of it is that class's record with
    // this task number (entities for the fair classes, rt_entities for fifo and rr)
    const tasks = table('tasks', (o) => ({
      task: u32(o), state: TASK_STATES[u32(o + 4)], cpu: u32(o + 8), policy: POLICIES[u32(o + 12)] ?? '?', nice: view.getInt32(o + 16, true),
      rt_priority: u32(o + 20), cgroup: groupPath(u32(o + 24)), cpus: u64(o + 32), sum_exec_runtime: u64(o + 40) }));
    // the fair class: its root queue on each CPU, and every entity on the class -- a task's
    // (task > 0) or a cgroup's group entity on one CPU (task 0), which is what the parent queue
    // actually picks between and no task record shows. The kernel keeps no per-cgroup total, so
    // neither does this.
    const cfs = table('cfs', (o) => ({ cpu: u32(o), min_vruntime: u64(o + 8), util_avg: u64(o + 16), load_avg: u64(o + 24), runnable_avg: u64(o + 32),
      h_nr_runnable: u64(o + 40) }));   // what the balancer reads, as against what the runqueue holds
    const entities = table('entities', (o) => ({ task: u32(o), cgroup: groupPath(u32(o + 4)), cpu: u32(o + 8), ...se(o + 16) }));
    // the real-time class: its queue on each CPU, and the tasks on it. Flags are the kernel's
    // answers (kmod/shm.h): the head of the highest list is the pick, none while throttled.
    const rt = table('rt', (o) => ({ cpu: u32(o), nr_running: u32(o + 4), highest_prio: u32(o + 8), throttled: !!u32(o + 12),
      rt_time: u64(o + 16), rt_runtime: u64(o + 24) }));
    const rt_entities = table('rt_entities', (o) => { const flags = u32(o + 8); return { task: u32(o), cpu: u32(o + 4),
      on_rq: !!(flags & 1), curr: !!(flags & 2), pick: !!(flags & 4), position: u32(o + 12), time_slice: u32(o + 16) }; });
    // the sched domains the kernel built, per CPU and innermost first -- not the topology asked for
    const domains = table('domains', (o) => { const n = u32(o + 4); return {
      cpu: u32(o), span: u64(o + 8), name: cstr(bytes, o + 16, 8), flags: cstr(bytes, o + 24, 160),
      imbalance_pct: u32(o + 184), balance_interval: u32(o + 188),
      busy_factor: u32(o + 192), cache_nice_tries: u32(o + 196),
      nr_balance_failed: u32(o + 200), last_balance_ago: u32(o + 204),
      groups: Array.from({ length: Math.min(n, L.maxGroups) }, (_, j) => { const g = o + 208 + j * L.groupStride; return {
        span: u64(g), capacity: u32(g + 8), min_capacity: u32(g + 12), max_capacity: u32(g + 16), weight: u32(g + 20) }; }) }; });
    if (!cpus || !groups || !tasks || !domains || !cfs || !entities || !rt || !rt_entities) continue;   // a count ran past its table: mid-update
    if (view.getUint32(8, true) === gen) return { timestamp: view.getUint32(12, true), cpus, tasks, groups, domains, cfs, entities, rt, rt_entities };
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
