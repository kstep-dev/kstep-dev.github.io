// Run a kSTEP driver inside the wasm-compiled x86_64 QEMU under Node.
//
//   ./run.sh --kernel sync_wakeup_buggy [--driver sync_wakeup] [--smp 3] [--mem 512] [--out dir] [--quiet]
//
// Loads $KSTEP_DIR/build/<kernel>/{kernel,rootfs.cpio} (KSTEP_DIR defaults to ../.. as
// kSTEP's docs/web submodule, else ../kstep) and SeaBIOS into Emscripten's in-memory
// FS, boots with the arguments kSTEP's run.py uses on x86_64, streams the guest console
// to stdout, and copies qemu.log / kstep.jsonl / kstep.cov to --out when the driver
// exits. QEMU itself does not exit on guest reboot under Emscripten, so completion is
// detected from the console log. --driver defaults to the kernel name minus _buggy/_fixed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const W = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] ?? ''] : []).filter(x => x.length));
const kernel = args.kernel ?? 'sync_wakeup_buggy';
const driver = args.driver ?? kernel.replace(/_(buggy|fixed)$/, '');
const smp = Number(args.smp ?? 2);
const mem = Number(args.mem ?? 512);
const outDir = args.out ?? path.join(W, 'results', `${kernel}-${driver}`);
const kstep = process.env.KSTEP_DIR ?? (fs.existsSync(path.join(W, '..', '..', 'run.py')) ? path.join(W, '..', '..') : path.join(W, '..', 'kstep'));
const kdir = path.join(kstep, 'build', kernel);
const qdir = path.join(W, 'build', 'qemu');

const Module = (await import(path.join(qdir, 'build', 'qemu-system-x86_64.js'))).default;
const isol = smp > 2 ? `1-${smp - 1}` : '1';
const bootArgs = `rw nokaslr loglevel=7 sched_verbose isolcpus=nohz,managed_irq,${isol} irqaffinity=0 rcu_nocbs=${isol} nohz_full=${isol} init=/user panic=-1 console=ttyS0 tsc=nowatchdog -- driver=${driver}`;
const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);

let mod;
mod = await Module({
  arguments: [
    '-smp', String(smp), '-cpu', 'max', '-m', `${mem}M`, '-L', '/bios',
    '-accel', 'tcg,tb-size=500,thread=multi',
    '-kernel', '/kernel', '-initrd', '/rootfs.cpio', '-append', bootArgs,
    '-nographic', '-nodefaults', '-no-reboot',
    '-chardev', 'file,id=char0,path=/out/qemu.log', '-serial', 'chardev:char0',
    '-chardev', 'file,id=char1,path=/out/kstep.jsonl', '-serial', 'chardev:char1',
    '-chardev', 'file,id=char2,path=/out/kstep.cov', '-serial', 'chardev:char2',
  ],
  preRun: [(m) => {
    m.FS.mkdir('/bios');
    for (const f of ['bios-256k.bin', 'linuxboot_dma.bin', 'kvmvapic.bin'])
      m.FS.writeFile(`/bios/${f}`, fs.readFileSync(path.join(qdir, 'pc-bios', f)));
    m.FS.writeFile('/kernel', fs.readFileSync(path.join(kdir, 'kernel')));
    m.FS.writeFile('/rootfs.cpio', fs.readFileSync(path.join(kdir, 'rootfs.cpio')));
    m.FS.mkdir('/out');
  }],
  print: (s) => console.log('[qemu]', s),
  printErr: (s) => { if (!s.includes('unsupported syscall')) console.error('[qemu]', s); },
});
console.error(`[${elapsed()}s] qemu instantiated (${kernel}, driver=${driver}, smp=${smp}, mem=${mem}M)`);

// Stream the guest console (in-memory /out/qemu.log) to stdout as it grows,
// and stop once the driver has exited or the kernel panicked.
let printed = 0;
const quiet = 'quiet' in args;
setInterval(() => {
  let log = '';
  try { log = mod.FS.readFile('/out/qemu.log', { encoding: 'utf8' }); } catch { return; }
  const lastNl = log.lastIndexOf('\n') + 1;   // only emit complete lines
  if (lastNl > printed) {
    if (!quiet) process.stdout.write(log.slice(printed, lastNl));
    printed = lastNl;
  }
  if (log.includes('reboot: Restarting system') || log.includes('Kernel panic')) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of ['qemu.log', 'kstep.jsonl', 'kstep.cov']) {
      try { fs.writeFileSync(path.join(outDir, f), mod.FS.readFile(`/out/${f}`)); } catch {}
    }
    console.error(`[${elapsed()}s] driver finished; results in ${outDir}`);
    process.exit(log.includes('Kernel panic') ? 1 : 0);
  }
}, 500);
