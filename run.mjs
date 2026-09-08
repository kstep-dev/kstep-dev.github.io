// Run a kstep driver inside a wasm-compiled QEMU under Node.
//
//   $NODE --wasm-lazy-compilation run.mjs [--kernel v6.14] [--driver default] [--smp 2] [--out results] [--quiet]
//
// Guest console goes to stdout; runner status goes to stderr. --quiet suppresses the console.
//
// Preloads $KSTEP_DIR/build/<kernel>/{kernel,rootfs.cpio} (KSTEP_DIR defaults to ../.. as a kstep submodule, else ../kstep)
// into Emscripten's in-memory FS,
// boots the aarch64 virt machine with the same arguments run.py uses, polls the
// guest console, and copies qemu.log / kstep.jsonl / kstep.cov to --out when the
// driver exits. QEMU itself does not exit on guest reboot under Emscripten, so
// completion is detected from the console log.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const W = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]] : []).filter(x => x.length));
const kernel = args.kernel ?? 'v6.14';
const driver = args.driver ?? 'default';
const smp = Number(args.smp ?? 2);
const outDir = args.out ?? path.join(W, 'results', `${kernel}-${driver}`);
const kdir = path.join(process.env.KSTEP_DIR ?? (fs.existsSync(path.join(W, '..', '..', 'run.py')) ? path.join(W, '..', '..') : path.join(W, '..', 'kstep')), 'build', kernel);

const Module = (await import(path.join(W, 'build', 'qemu', 'build', 'qemu-system-aarch64.js'))).default;
const isol = smp > 2 ? `1-${smp - 1}` : '1';
const bootArgs = `rw nokaslr loglevel=7 sched_verbose isolcpus=nohz,managed_irq,${isol} irqaffinity=0 rcu_nocbs=${isol} nohz_full=${isol} init=/user panic=-1 console=ttyS0 -- driver=${driver}`;
const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);

let mod;
mod = await Module({
  arguments: [
    '-machine', 'virt', '-cpu', 'cortex-a57', '-smp', String(smp), '-m', '512M',
    '-accel', 'tcg,tb-size=500,thread=multi',
    '-kernel', '/kernel', '-initrd', '/rootfs.cpio', '-append', bootArgs,
    '-nographic', '-nodefaults', '-no-reboot',
    '-chardev', 'file,id=char0,path=/out/qemu.log', '-device', 'pci-serial,chardev=char0',
    '-chardev', 'file,id=char1,path=/out/kstep.jsonl', '-device', 'pci-serial,chardev=char1',
    '-chardev', 'file,id=char2,path=/out/kstep.cov', '-device', 'pci-serial,chardev=char2',
  ],
  preRun: [(m) => {
    m.FS.writeFile('/kernel', fs.readFileSync(path.join(kdir, 'kernel')));
    m.FS.writeFile('/rootfs.cpio', fs.readFileSync(path.join(kdir, 'rootfs.cpio')));
    m.FS.mkdir('/out');
  }],
  print: (s) => console.log('[qemu]', s),
  printErr: (s) => { if (!s.includes('unsupported syscall')) console.error('[qemu]', s); },
});
console.error(`[${elapsed()}s] qemu instantiated (smp=${smp})`);

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
