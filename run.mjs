#!/usr/bin/env node
// The playground headless under Node (>= 20; emsdk ships one: build/emsdk/node/*/bin/node).
//
//   ./run.mjs [--build v6.18 | --image DIR] [--smp 3] [--mem 64] [--tasks 3] [--ticks 30]  # round-robin demo: who ran where
//   ./run.mjs --bench [10]         # per-command latency: `tick`s, then `top`s, N seconds each
//   ./run.mjs --check              # deploy gate: the staged image (site/images/cli) answers every verb the page uses
//
// Boots build/<build>/{kernel,rootfs.cpio} from the kSTEP checkout (KSTEP_DIR, default ..) in
// site/qemu/'s QEMU, the way site/kstep.mjs does for the page. Console -> stderr with --verbose.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runKstep } from './site/kstep.mjs';

const W = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') ? '' : all[i + 1] ?? ''] : []).filter(x => x.length));
const kstep = process.env.KSTEP_DIR ?? path.join(W, '..');
const image = args.image ?? ('check' in args ? path.join(W, 'site', 'images', 'cli') : path.join(kstep, 'build', args.build ?? 'v6.18'));
const smp = Number(args.smp ?? 3), mem = Number(args.mem ?? 64), cpus = smp - 1;
const t0 = Date.now(), elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);

const Module = (await import(path.join(W, 'site', 'qemu', 'qemu-system-aarch64.js'))).default;
const { cmd, shm } = await runKstep(Module, {
  files: { kernel: fs.readFileSync(path.join(image, 'kernel')), rootfs: fs.readFileSync(path.join(image, 'rootfs.cpio')) },
  smp, mem,
  onConsole: (line) => { if ('verbose' in args) process.stderr.write(line + '\n'); },
});
console.error(`[${elapsed()}s] ready`, JSON.stringify(await cmd(null)), `(${image}, smp=${smp}, mem=${mem}M)`);

if ('check' in args) {
  const pid = (await cmd('create')).task;
  // one command per verb the page sends; only "unknown command" counts as missing
  const verbs = ['tick', `policy-fair ${pid} normal 0`, `policy-rt ${pid} fifo 50`, `policy-fair ${pid} normal`, `affinity ${pid} 1`, 'cpu-freq 1=512', `pause ${pid}`, `wake ${pid}`,
    'cgroup-create /check', 'cgroup-weight /check 100', 'cgroup-cpus /check 1', `cgroup-attach /check ${pid}`, `kill ${pid}`];
  const missing = [];
  for (const v of verbs) if ((await cmd(v)).error === 'unknown command') missing.push(v.split(' ')[0]);
  const st = shm(), cpu = st.cpus.find(r => r.cpu === 1), fair = st.cfs.find(r => r.cpu === 1), rt = st.rt.find(r => r.cpu === 1);
  const ok = (r, fields) => r && fields.every(k => Number.isFinite(r[k]) && r[k] >= 0);
  // the runqueue's own record, then each class's queue on it (kmod/shm.h's tables)
  const statsOk = ok(cpu, ['current', 'nr_running', 'capacity', 'freq', 'nr_switches']) && typeof cpu.idle === 'boolean'
    && ok(fair, ['util_avg', 'load_avg', 'runnable_avg', 'h_nr_runnable']) && ok(rt, ['nr_running', 'highest_prio', 'rt_runtime']);
  // the sched domains the page shows: at least one level, with groups and the kernel's flag names
  const dom = shm().domains?.[0];
  const domOk = dom && dom.name && dom.flags && dom.groups.length >= 2 && dom.imbalance_pct > 0;
  await cmd('exit');
  if (!statsOk) { console.error('playground image lacks valid CPU/runqueue snapshots; rebuild it from the current kmod'); process.exit(1); }
  if (!domOk) { console.error('playground image reports no sched domains; rebuild it from the current kmod'); process.exit(1); }
  if (missing.length) { console.error(`playground image lacks: ${missing.join(', ')}`); process.exit(1); }
  console.log(`playground image: all ${verbs.length} verbs answered; CPU/runqueue and sched-domain snapshots verified`);
} else if ('bench' in args) {
  const seconds = Number(args.bench || 10);
  for (let i = 0; i < Number(args.tasks ?? 3); i++) await cmd('create');
  for (const verb of ['tick', `nice ${1} 0`]) {
    const t = performance.now(); let n = 0;
    while (performance.now() - t < seconds * 1000) { await cmd(verb); n++; }
    const ms = (performance.now() - t) / n;
    console.log(`${verb.padEnd(5)} ${n} in ${seconds}s: ${ms.toFixed(2)} ms/cmd, ${(1000 / ms).toFixed(0)}/s (smp=${smp})`);
  }
  await cmd('exit');
} else {
  const pids = [];
  for (let i = 0; i < Number(args.tasks ?? 3); i++) pids.push((await cmd('create')).task);
  const timeline = [];
  for (let i = 0; i < Number(args.ticks ?? 30); i++) {   // a step: one tick, whose snapshot says who is running where
    await cmd('tick');
    timeline.push(Array.from({ length: cpus }, (_, c) => shm().cpus.find(o => o.cpu === c + 1)?.current ?? 0));
  }
  console.log('tasks', pids.join(' '));
  for (let c = 0; c < cpus; c++) console.log(`cpu${c + 1}`.padEnd(6), timeline.map(t => t[c] ? String(t[c]) : '.').join(''));
  const st = shm(), fairOf = new Map(st.entities.filter(e => e.task).map(e => [e.task, e]));   // a task's fair record, by task number
  for (const s of st.tasks) console.log(`task ${s.task}: ${s.state} cpu=${s.cpu} runtime=${(s.sum_exec_runtime / 1e6).toFixed(1)}ms vruntime=${((fairOf.get(s.task)?.vruntime ?? 0) / 1e6).toFixed(1)}ms`);
  await cmd('exit');
}
console.error(`[${elapsed()}s] done`);
process.exit(0);
