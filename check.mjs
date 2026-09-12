#!/usr/bin/env node
// Boot the playground image (site/images/cli) and check it understands every driver verb the
// page uses. deploy.sh runs this before publishing so the page and the image never drift.
//   ./check.mjs   (exit 1 on any missing verb)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIOS, runKstep } from './site/kstep.mjs';

const W = path.dirname(fileURLToPath(import.meta.url));
const image = path.join(W, 'site', 'images', 'cli');
const qdir = path.join(W, 'site', 'qemu');
const Module = (await import(path.join(qdir, 'qemu-system-x86_64.js'))).default;
const waiters = [];
let cpuRecords = [];
const { send } = await runKstep(Module, {
  files: { kernel: fs.readFileSync(path.join(image, 'kernel')), rootfs: fs.readFileSync(path.join(image, 'rootfs.cpio')), bios: Object.fromEntries(BIOS.map(f => [f, fs.readFileSync(path.join(qdir, f))])) },
  driver: 'cli', smp: 2, mem: 64, cli: true,
  onLine: (ch, line) => { if (ch === 'jsonl') { const o = JSON.parse(line); if (o.type === 'cpu') cpuRecords.push(o); if (!('type' in o)) waiters.shift()?.(o); } },
});
const cmd = (l) => new Promise(r => { waiters.push(r); if (l !== null) send(l); });
await cmd(null);
const pid = (await cmd('create')).task;
// one command per verb the page sends; only "unknown command" counts as a failure
const verbs = ['tick', 'top', `task ${pid}`, `nice ${pid} 0`, `policy ${pid} normal`, `affinity ${pid} 1`, `pause ${pid}`, `wake ${pid}`, 'cgroup-create /check', 'cgroup-weight /check 100', 'cgroup-cpus /check 1', `attach ${pid} /check`, `kill ${pid}`];
const missing = [];
for (const v of verbs) { const r = await cmd(v); if (r.error === 'unknown command') missing.push(v.split(' ')[0]); }
cpuRecords = [];
await cmd('top');
const cpu = cpuRecords.find(r => r.cpu === 1);
const fields = ['current', 'nr_running', 'capacity', 'nr_switches', 'cfs_util_avg', 'cfs_load_avg', 'cfs_runnable_avg'];
const statsOk = cpuRecords.length === 1 && cpu && typeof cpu.idle === 'boolean' && fields.every(k => Number.isFinite(cpu[k]) && cpu[k] >= 0);
await cmd('exit');
if (!statsOk) { console.error('playground image lacks valid CPU/runqueue snapshots; rebuild it from the current kmod'); process.exit(1); }
if (missing.length) { console.error(`playground image lacks: ${missing.join(', ')}`); process.exit(1); }
console.log(`playground image: all ${verbs.length} verbs answered; CPU/runqueue snapshot verified`);
process.exit(0);
