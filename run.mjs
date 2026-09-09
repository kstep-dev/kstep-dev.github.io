#!/usr/bin/env node
// Run a kSTEP image headless under Node (>= 20), the way the web page does (see site/kstep.mjs).
//
//   ./run.mjs --kernel sync_wakeup_buggy [--driver sync_wakeup] [--smp 3] [--mem 512] [--out dir] [--quiet]
//   (no system node? emsdk ships one: build/emsdk/node/*/bin/node run.mjs ...)
//
// Reads $KSTEP_DIR/build/<kernel>/{kernel,rootfs.cpio} (KSTEP_DIR defaults to ../.. as kSTEP's
// docs/website submodule, else ../kstep) and the QEMU build from site/qemu/. Console -> stdout,
// status -> stderr, results -> --out (default results/<kernel>-<driver>/).
// --driver defaults to the kernel name minus _buggy/_fixed; --smp/--mem to reproduce.py's
// values when site/data.json exists, else 2 / 128.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIOS, runKstep } from './site/kstep.mjs';

const W = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] ?? ''] : []).filter(x => x.length));
const kernel = args.kernel ?? 'sync_wakeup_buggy';
let defaults = { driver: kernel.replace(/_(buggy|fixed)$/, ''), num_cpus: 2, mem_mb: 128 };
try {  // defaults from site/data.json (deploy.sh), i.e. reproduce.py's values for the bug
  const b = JSON.parse(fs.readFileSync(path.join(W, 'site', 'data.json'))).bugs.find(b => Object.values(b.images).includes(kernel));
  if (b) defaults = { driver: b.name, num_cpus: b.num_cpus, mem_mb: b.mem_mb };
} catch {}
const driver = args.driver ?? defaults.driver, smp = Number(args.smp ?? defaults.num_cpus), mem = Number(args.mem ?? defaults.mem_mb);
const outDir = args.out ?? path.join(W, 'results', `${kernel}-${driver}`);
const kstep = process.env.KSTEP_DIR ?? (fs.existsSync(path.join(W, '..', '..', 'run.py')) ? path.join(W, '..', '..') : path.join(W, '..', 'kstep'));
const kdir = path.join(kstep, 'build', kernel), qdir = path.join(W, 'site', 'qemu');
const t0 = Date.now(), elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);

const Module = (await import(path.join(qdir, 'qemu-system-x86_64.js'))).default;
const out = { console: [], jsonl: [] };
const { done } = await runKstep(Module, {
  files: {
    kernel: fs.readFileSync(path.join(kdir, 'kernel')),
    rootfs: fs.readFileSync(path.join(kdir, 'rootfs.cpio')),
    bios: Object.fromEntries(BIOS.map(f => [f, fs.readFileSync(path.join(qdir, f))])),
  },
  driver, smp, mem,
  onLine: (ch, line) => { out[ch].push(line); if (ch === 'console' && !('quiet' in args)) process.stdout.write(line + '\n'); },
});
console.error(`[${elapsed()}s] qemu started (${kernel}, driver=${driver}, smp=${smp}, mem=${mem}M)`);
const { panic } = await done;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'qemu.log'), out.console.join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'kstep.jsonl'), out.jsonl.join('\n') + '\n');
console.error(`[${elapsed()}s] ${panic ? 'kernel panic' : 'driver finished'}; results in ${outDir}`);
process.exit(panic ? 1 : 0);
