#!/usr/bin/env node
// Boot the playground image the site points at and check it understands every driver verb
// the page uses. deploy.sh runs this before publishing so the page and the image never drift.
//   ./check.mjs [site/data.json]   (exit 1 on any missing verb)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIOS, runKstep } from './site/kstep.mjs';

const W = path.dirname(fileURLToPath(import.meta.url));
const { playground: play } = JSON.parse(fs.readFileSync(process.argv[2] ?? path.join(W, 'site', 'data.json')));
const base = play.base.startsWith('http') ? play.base : `file://${path.join(W, 'site', play.base)}`;
const get = async (name) => {
  const url = `${base}/${play.image}/${name}`;
  if (url.startsWith('file://')) return fs.readFileSync(url.slice(7));
  const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer());
};
const qdir = path.join(W, 'site', 'qemu');
const Module = (await import(path.join(qdir, 'qemu-system-x86_64.js'))).default;
const waiters = [];
const { send } = await runKstep(Module, {
  files: { kernel: await get('kernel'), rootfs: await get('rootfs.cpio'), bios: Object.fromEntries(BIOS.map(f => [f, fs.readFileSync(path.join(qdir, f))])) },
  driver: 'cli', smp: 2, mem: play.mem_mb, cli: true,
  onLine: (ch, line) => { if (ch === 'jsonl') { const o = JSON.parse(line); if (!('type' in o)) waiters.shift()?.(o); } },
});
const cmd = (l) => new Promise(r => { waiters.push(r); if (l !== null) send(l); });
await cmd(null);
const pid = (await cmd('create')).task;
// one command per verb the page sends; only "unknown command" counts as a failure
const verbs = ['tick', 'top', `task ${pid}`, `nice ${pid} 0`, `policy ${pid} normal`, `affinity ${pid} 1`, `pause ${pid}`, `wake ${pid}`, 'cgroup-create /check', 'cgroup-weight /check 100', 'cgroup-cpus /check 1', `attach ${pid} /check`, `kill ${pid}`];
const missing = [];
for (const v of verbs) { const r = await cmd(v); if (r.error === 'unknown command') missing.push(v.split(' ')[0]); }
await cmd('exit');
if (missing.length) { console.error(`image at ${play.base}/${play.image} lacks: ${missing.join(', ')}`); process.exit(1); }
console.log(`image at ${play.base}/${play.image}: all ${verbs.length} verbs answered`);
process.exit(0);
