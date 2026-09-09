// Shared by index.html (browser) and run.mjs (Node): how to boot a kSTEP image in the
// wasm QEMU and get its output back.
//
//   const { done } = await runKstep(Module, { files, driver, smp, mem, onLine, locateFile });
//   const { panic } = await done;
//
// files: { kernel, rootfs, bios: { 'bios-256k.bin': ..., } } as Uint8Array / ArrayBuffer.
// onLine(channel, line) is called for every complete line, channel 'console' (kernel
// console, chardev 0) or 'jsonl' (driver output, chardev 1); coverage (chardev 2) is
// dropped. QEMU does not exit on guest reboot under Emscripten, so `done` resolves when
// the console shows the reboot or a kernel panic.

export const BIOS = ['bios-256k.bin', 'linuxboot_dma.bin', 'kvmvapic.bin'];

// kSTEP's run.py arguments for x86_64, plus tsc_early_khz: QEMU on a wasm host derives the
// guest TSC from the JS clock (1 GHz, but only as fine as performance.now(), 1 ms in Safari),
// and the kernel's PIT/HPET TSC calibration divides by zero when two reads coincide.
export function bootArgs({ driver, smp }) {
  const isol = smp > 2 ? `1-${smp - 1}` : '1';
  return `rw nokaslr loglevel=7 sched_verbose isolcpus=nohz,managed_irq,${isol} irqaffinity=0 ` +
    `rcu_nocbs=${isol} nohz_full=${isol} init=/user panic=-1 console=ttyS0 tsc=nowatchdog ` +
    `tsc_early_khz=1000000 -- driver=${driver}`;
}

export function qemuArgs({ driver, smp, mem }) {
  return [
    '-smp', String(smp), '-cpu', 'max', '-m', `${mem}M`, '-L', '/bios',
    '-accel', 'tcg,tb-size=500,thread=multi',
    '-kernel', '/kernel', '-initrd', '/rootfs.cpio', '-append', bootArgs({ driver, smp }),
    '-nographic', '-nodefaults', '-no-reboot',
    // /dev/kstep0..2 are Emscripten device nodes whose write callbacks push bytes to us.
    '-chardev', 'file,id=c0,path=/dev/kstep0', '-serial', 'chardev:c0',
    '-chardev', 'file,id=c1,path=/dev/kstep1', '-serial', 'chardev:c1',
    '-chardev', 'file,id=c2,path=/dev/kstep2', '-serial', 'chardev:c2',
  ];
}

export async function runKstep(Module, { files, driver, smp, mem, onLine, locateFile, log = console.error }) {
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });
  const channels = { 0: 'console', 1: 'jsonl' };
  const lines = { console: '', jsonl: '' };
  const sink = (i) => (byte) => {
    const ch = channels[i];
    if (!ch) return;
    if (byte !== 10) { lines[ch] += String.fromCharCode(byte); return; }
    const line = lines[ch]; lines[ch] = '';
    onLine(ch, line);
    if (ch === 'console' && (line.includes('reboot: Restarting system') || line.includes('Kernel panic')))
      resolveDone({ panic: line.includes('Kernel panic') });
  };
  const module = await Module({
    locateFile,
    arguments: qemuArgs({ driver, smp, mem }),
    preRun: [(m) => {
      m.FS.mkdir('/bios');
      for (const [name, data] of Object.entries(files.bios)) m.FS.writeFile(`/bios/${name}`, new Uint8Array(data));
      m.FS.writeFile('/kernel', new Uint8Array(files.kernel));
      m.FS.writeFile('/rootfs.cpio', new Uint8Array(files.rootfs));
      for (let i = 0; i < 3; i++) m.FS.createDevice('/dev', `kstep${i}`, null, sink(i));
    }],
    print: (s) => log('[qemu] ' + s),
    printErr: (s) => { if (!s.includes('unsupported syscall')) log('[qemu] ' + s); },
  });
  return { module, done };
}
