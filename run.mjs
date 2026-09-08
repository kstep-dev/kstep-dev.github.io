// Run a kSTEP driver inside the wasm-compiled x86_64 QEMU under Node.
//
//   ./run.sh --kernel sync_wakeup_buggy [--driver sync_wakeup] [--smp 3] [--mem 512] [--out dir] [--quiet]
//
// Loads $KSTEP_DIR/build/<kernel>/{kernel,rootfs.cpio} (KSTEP_DIR defaults to ../.. as
// kSTEP's docs/web submodule, else ../kstep) and SeaBIOS into Emscripten's in-memory
// FS, boots with the arguments kSTEP's run.py uses on x86_64, streams the guest console
// to stdout, and copies qemu.log / kstep.jsonl / kstep.cov to --out when the driver
// exits. The three chardevs write to Emscripten device nodes whose JS write callbacks
// push bytes to us as they are produced, so nothing is polled. QEMU itself does not exit
// on guest reboot under Emscripten, so completion is detected from the console stream.
// --driver defaults to the kernel name minus _buggy/_fixed.
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

// One collector per channel: bytes arrive one at a time from the device callback.
const quiet = 'quiet' in args;
const chan = { 'qemu.log': [], 'kstep.jsonl': [], 'kstep.cov': [] };
let line = '';
const onConsoleLine = (l) => {
  if (!quiet) process.stdout.write(l + '\n');
  if (l.includes('reboot: Restarting system') || l.includes('Kernel panic')) finish(l.includes('Kernel panic') ? 1 : 0);
};
const sink = (name) => (byte) => {
  chan[name].push(byte);
  if (name === 'qemu.log') { if (byte === 10) { onConsoleLine(line); line = ''; } else line += String.fromCharCode(byte); }
};
const finish = (code) => {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [f, bytes] of Object.entries(chan)) fs.writeFileSync(path.join(outDir, f), Buffer.from(bytes));
  console.error(`[${elapsed()}s] driver finished; results in ${outDir}`);
  process.exit(code);
};

let mod;
mod = await Module({
  arguments: [
    '-smp', String(smp), '-cpu', 'max', '-m', `${mem}M`, '-L', '/bios',
    '-accel', 'tcg,tb-size=500,thread=multi',
    '-kernel', '/kernel', '-initrd', '/rootfs.cpio', '-append', bootArgs,
    '-nographic', '-nodefaults', '-no-reboot',
    '-chardev', 'file,id=char0,path=/dev/kstep0', '-serial', 'chardev:char0',
    '-chardev', 'file,id=char1,path=/dev/kstep1', '-serial', 'chardev:char1',
    '-chardev', 'file,id=char2,path=/dev/kstep2', '-serial', 'chardev:char2',
  ],
  preRun: [(m) => {
    m.FS.mkdir('/bios');
    for (const f of ['bios-256k.bin', 'linuxboot_dma.bin', 'kvmvapic.bin'])
      m.FS.writeFile(`/bios/${f}`, fs.readFileSync(path.join(qdir, 'pc-bios', f)));
    m.FS.writeFile('/kernel', fs.readFileSync(path.join(kdir, 'kernel')));
    m.FS.writeFile('/rootfs.cpio', fs.readFileSync(path.join(kdir, 'rootfs.cpio')));
    Object.keys(chan).forEach((name, i) => m.FS.createDevice('/dev', `kstep${i}`, null, sink(name)));
  }],
  print: (s) => console.log('[qemu]', s),
  printErr: (s) => { if (!s.includes('unsupported syscall')) console.error('[qemu]', s); },
});
console.error(`[${elapsed()}s] qemu instantiated (${kernel}, driver=${driver}, smp=${smp}, mem=${mem}M)`);
