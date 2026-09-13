// Shared by index.html (browser) and run.mjs (Node): boot kSTEP's `cli` driver in the wasm
// QEMU and talk to it.
//
//   const { cmd, done } = await runKstep(Module, { files, smp, mem, params, onConsole, onEvent });
//   await cmd(null);                 // the driver's ready line
//   const reply = await cmd('tick'); // one command in flight at a time, replies in order
//   const { panic } = await done;    // QEMU never exits under Emscripten: the console's reboot line marks the end
//
// files: { kernel, rootfs } as Uint8Array / ArrayBuffer (the arm64 Image and the initramfs).
// params: extra kSTEP module parameters after the `--` (topology=, capacity=, ...).
// The driver's JSON port (/dev/hvc0 in the guest) is one ordered stream: command replies
// (an "ok" or "error" field) interleaved with events and records ("type"). Replies resolve
// the pending cmd(); everything else goes to onEvent(record, line). Kernel console lines go
// to onConsole(line). locateFile/wasmBinary are passed through to the Emscripten module.

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
    // Two Emscripten device nodes: the PL011 console (write-only) and the driver's hvc0, a
    // virtio console port on virtio-mmio (one virtqueue kick per write where a UART costs one
    // MMIO exit per byte), opened read-write as a pipe chardev so commands can go in.
    '-chardev', 'file,id=c0,path=/dev/console0', '-serial', 'chardev:c0',
    '-device', 'virtio-serial-device,id=vs0',
    '-chardev', 'pipe,id=c1,path=/dev/hvc0', '-device', 'virtconsole,bus=vs0.0,nr=0,chardev=c1',
  ];
}

export async function runKstep(Module, { files, smp, mem, params, onConsole, onEvent, locateFile, wasmBinary, log = console.error }) {
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });
  const waiters = [], inq = [];   // pending cmd() resolvers; bytes queued for the guest's hvc0
  const cmd = (line) => new Promise(r => {
    waiters.push(r);
    if (line !== null) for (const b of new TextEncoder().encode(line + '\n')) inq.push(b);
  });
  const lineSink = (onLine) => { let buf = ''; return (byte) => { if (byte === 10) { onLine(buf); buf = ''; } else buf += String.fromCharCode(byte); }; };
  const console_ = lineSink((line) => {
    onConsole?.(line);
    if (line.includes('reboot: Restarting system') || line.includes('Kernel panic'))
      resolveDone({ panic: line.includes('Kernel panic') });
  });
  const hvc0 = lineSink((line) => { const o = JSON.parse(line); if ('type' in o) onEvent?.(o, line); else waiters.shift()?.(o); });
  const module = await Module({
    locateFile, wasmBinary,
    arguments: qemuArgs({ smp, mem, params }),
    preRun: [(m) => {
      m.FS.writeFile('/kernel', new Uint8Array(files.kernel));
      m.FS.writeFile('/rootfs.cpio', new Uint8Array(files.rootfs));
      m.FS.createDevice('/dev', 'console0', null, console_);
      // FS ops run on the main thread (QEMU's thread is proxied to it), so the queue is plain JS state.
      const dev = m.FS.makedev(64, 1);
      m.FS.registerDevice(dev, {
        open(stream) { stream.seekable = false; },
        close() {},
        read(stream, buffer, offset, length) {
          let n = 0;
          while (n < length && inq.length) buffer[offset + n++] = inq.shift();
          if (n === 0) throw new m.FS.ErrnoError(6);   // EAGAIN: nothing queued
          return n;
        },
        write(stream, buffer, offset, length) { for (let i = 0; i < length; i++) hvc0(buffer[offset + i]); return length; },
        poll() { return (inq.length ? 1 : 0) | 4; },   // POLLIN when a command is queued, always POLLOUT
      });
      m.FS.mkdev('/dev/hvc0', 0o666, dev);
    }],
    print: (s) => log('[qemu] ' + s),
    printErr: (s) => { if (!s.includes('unsupported syscall')) log('[qemu] ' + s); },
  });
  return { module, cmd, done };
}
