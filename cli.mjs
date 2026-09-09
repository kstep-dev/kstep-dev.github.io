#!/usr/bin/env node
// Drive kSTEP's `cli` driver inside the wasm QEMU, headless: the round-robin demo.
//   ./cli.mjs --kernel <image> [--tasks 3] [--ticks 30]
// Requires an image whose kmod has the `cli` driver (kmod/cli/cli.c).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIOS, runKstep } from './site/kstep.mjs';

const W = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] ?? ''] : []).filter(x => x.length));
const kernel = args.kernel ?? 'sync_wakeup_buggy', tasks = Number(args.tasks ?? 3), ticks = Number(args.ticks ?? 30);
const kstep = process.env.KSTEP_DIR ?? (fs.existsSync(path.join(W, '..', '..', 'run.py')) ? path.join(W, '..', '..') : path.join(W, '..', 'kstep'));
const kdir = path.join(kstep, 'build', kernel), qdir = path.join(W, 'site', 'qemu');
const Module = (await import(path.join(qdir, 'qemu-system-x86_64.js'))).default;

// Replies arrive as 'cli' lines; commands are answered strictly in order.
const waiters = [];
const { send } = await runKstep(Module, {
  files: { kernel: fs.readFileSync(path.join(kdir, 'kernel')), rootfs: fs.readFileSync(path.join(kdir, 'rootfs.cpio')),
           bios: Object.fromEntries(BIOS.map(f => [f, fs.readFileSync(path.join(qdir, f))])) },
  driver: 'cli', smp: 2, mem: 128, cli: true,
  onLine: (ch, line) => { if (ch === 'cli') waiters.shift()?.(JSON.parse(line)); },
});
const cmd = (line) => new Promise(r => { waiters.push(r); if (line !== null) send(line); });

const t0 = Date.now();
const ready = await cmd(null);   // the driver announces itself
console.error(`ready after ${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(ready));
const pids = [];
for (let i = 0; i < tasks; i++) pids.push((await cmd('create')).pid);
const timeline = [];
for (let i = 0; i < ticks; i++) { await cmd('tick'); timeline.push((await cmd('curr')).pid); }
for (const pid of [...pids, 0]) console.log(String(pid || 'idle').padStart(6), timeline.map(p => p === pid ? '#' : '.').join(''));
for (const pid of pids) { const s = await cmd(`stat ${pid}`); console.log(`stat ${pid}: runtime=${(s.sum_exec_runtime / 1e6).toFixed(1)}ms vruntime=${(s.vruntime / 1e6).toFixed(1)}ms weight=${s.weight}`); }
await cmd('exit');
console.error(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
