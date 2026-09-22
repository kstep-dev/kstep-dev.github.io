// The playground: the page's whole front end. index.html is markup and a bootstrap that fetches
// data.json and calls init() with it; everything else is here.
//
// The shape of it: a session's state lives in module-level bindings (tasks, snapshots, charts,
// machine, ...), the VM is driven through kstep.mjs's cmd(), and every command leaves a snapshot
// of the shared region that the figures are drawn from. One window -- which ticks are on screen --
// is computed once per draw and handed to every chart, so a column cannot drift between them.
const $ = (id) => document.getElementById(id);
const status = $('status'), log = $('log'), con = $('console');
const bootStarted = performance.now();
let startup = true, statusTimer = 0;
const updateElapsed = () => { $('boot-elapsed').textContent = ` · ${((performance.now() - bootStarted) / 1000).toFixed(1)} s`; };
const setStatus = (s, bad = false, busy = false) => {
  status.textContent = s; status.className = bad ? 'bad' : '';
  startup = busy;
  clearInterval(statusTimer);
  if (busy) { updateElapsed(); statusTimer = setInterval(updateElapsed, 100); }
  else { $('boot-elapsed').textContent = ''; $('boot-preview').hidden = true; }
  if (bad) $('kernel-logs').open = true;
};
setStatus('Loading kernel…', false, true);

let V = '', bugs = [];   // the version stamp and the bug catalog, from data.json (see init)

// ---- reproduced bugs: a static catalog ----
function renderBugs() {
  const link = (text, href) => { const a = document.createElement('a'); a.textContent = text; a.href = href; return a; };
  const tbody = $('bugs').querySelector('tbody');
  // Two columns, like the table in the kSTEP README: everything about the bug on the left, the plot on the right.
  const line = (label, ...nodes) => { const div = document.createElement('div'); if (label) { const b = document.createElement('b'); b.textContent = label + ': '; div.append(b); } div.append(...nodes); return div; };
  for (const b of bugs) {
    const tr = tbody.insertRow();
    const info = tr.insertCell();
    const title = document.createElement('b'); title.textContent = b.name; info.append(line('', title));
    if (b.driver_url) info.append(line('Driver', link(b.name + '.c', b.driver_url)));
    if (b.fixes.length) info.append(line('Fix', ...b.fixes.flatMap((x, i) => i ? [', ', link(x.label, x.url)] : [link(x.label, x.url)])));
    const pl = tr.insertCell(); if (b.plot) { const img = document.createElement('img'); img.src = b.plot; img.alt = `${b.name}: buggy vs fixed`; img.loading = 'lazy'; img.onerror = () => img.remove(); pl.append(img); }
  }
}
const { image, runKstep } = await import(`./kstep.mjs?v=${V}`);

// ---- session state ----
const tasks = [];            // [{id, stat, alive}] in creation order; the driver names tasks 1, 2, .. by creation
let domains = [];            // the sched domains the kernel built, refreshed with every snapshot
const snapshots = [];        // per tick: {tasks: Map(id->stat), cpus: Map(cpu->stat)}; the run, and the x axis
let ncpus = 1;
let cpuRecords = new Map();   // per CPU, with the class queues on it joined in as .fair and .rt (see cmd)
let taskRecords = new Map();  // per task, with its class's record joined in as .fair or .rt
const ms = (ns) => ns === undefined ? '' : (ns / 1e6).toFixed(1);
// Colours are fixed per creation order, so a task keeps its colour in the charts after it exits.
const colorOf = (task) => { const i = tasks.findIndex(t => t.id === task); return i < 0 ? 'gray' : `hsl(${(i * 67) % 360}, 60%, 50%)`; };   // comma syntax: Safari's canvas parser

// ---- machine: sockets of clusters of core types (CPU 0 stays kSTEP's own) ----
// Mirrors KSTEP_SHM_CPUS, which mirrors the module's own KSTEP_NR_CPUS: the form refuses what the
// shared region could not report. The booted region says so itself in its header, so a mismatch
// here only ever costs a rejected form, never a misread.
const MAX_CPUS = 32;
const SNAPSHOT_CPUS = 4;   // test CPUs in the staged snapshot (run.mjs --snapshot, smp 5): layouts up to this resume instead of booting
// A machine is sockets of clusters of cores, and a core is its threads and what it is worth. At
// eight CPUs there is no reason to compress equal cores into a count: listing them is simpler, and
// it lets the picture below be the form, with a core as a thing you click rather than a number you
// type. Nesting is the grouping, so there is nothing to number and no way to name a cluster that
// is not there: levels nest by construction and the kernel's domain builder cannot be handed a
// shape it would choke on. Capacity sits on the core because that is the thing that has one --
// which is what lets big and little cores share a cluster, as an arm64 DSU does. It is what the
// hardware is, so it is sent once at boot; changing it under a running kernel would reinterpret
// PELT signals gathered at the old capacity.
// kSTEP's spec is KEY=group|group;... : threads of a core form an SMT group, cores of a cluster a
// CLS group, and a socket is both the MC (shared last-level cache) and the PKG group, named only
// when there is more than one. A CPU not named at a level is alone there. CAP groups are
// cpulist:capacity. CPU 0 is never named; CPUs are numbered 1.. across the tree in order.
const core = (threads = 1, cap = 1024) => ({ threads, cap });
const mach = (...sockets) => ({ sockets });   // socket -> cluster -> cores
const one = (...cores) => mach([cores]);      // the common machine: one socket, one cluster
let machine = one(core(2), core(2));          // what the VM booted with
const eachCore = function* (m) {
  for (const [si, clusters] of m.sockets.entries())
    for (const [ci, cores] of clusters.entries())
      for (const [oi, c] of cores.entries()) yield { c, si, ci, oi };
};
const allCores = (m) => [...eachCore(m)].map(e => e.c);
const asMachine = (m) => mach(...m.sockets.map(cl => cl.map(cs => cs.map(c => ({ ...c })))));
const capsOf = (m) => allCores(m).flatMap(c => Array(c.threads).fill(c.cap ?? 1024));
const nCpus = (m) => allCores(m).reduce((n, c) => n + c.threads, 0);
// ids[cpu] = the socket, cluster and core that CPU belongs to; cached per machine object.
function cpuIds(m) {
  const ids = [];
  let cpu = 1, core = 0, cluster = 0;
  for (const [si, clusters] of m.sockets.entries())
    for (const cores of clusters) {
      for (const c of cores) {
        for (let t = 0; t < c.threads; t++) ids[cpu++] = { socket: si, cluster, core };
        core++;
      }
      cluster++;
    }
  return ids;
}
const idsOf = (m) => (m.ids ??= cpuIds(m));
const socketOf = (m, cpu) => idsOf(m)[cpu]?.socket ?? 0;
const clusterOf = (m, cpu) => idsOf(m)[cpu]?.cluster ?? 0;
const coreOf = (m, cpu) => idsOf(m)[cpu]?.core ?? 0;
// The CPUs a core got, which the picture writes on its threads.
function coreCpus(m, si, ci, oi) {
  let first = 1;
  for (const e of eachCore(m)) {
    if (e.si === si && e.ci === ci && e.oi === oi)
      return Array.from({ length: e.c.threads }, (_, i) => first + i);
    first += e.c.threads;
  }
  return [];
}
const groupSpec = (m, id) => { const g = new Map(); for (let c = 1; c <= nCpus(m); c++) { const k = id(m, c); if (!g.has(k)) g.set(k, []); g.get(k).push(c); } return [...g.values()].map(l => l.join(',')).join('|'); };
// Only what differs from a machine of single-thread cores in one socket: SMT when a core has
// threads, CLS always (the form always has clusters), MC and PKG when there are several sockets.
function topoSpec(m) {
  const parts = [`CPUS=${nCpus(m)}`];   // the test CPUs; a larger VM keeps the rest idle and unseen, so one snapshot serves every smaller machine
  if (allCores(m).some(c => c.threads > 1)) parts.push(`SMT=${groupSpec(m, coreOf)}`);
  parts.push(`CLS=${groupSpec(m, clusterOf)}`);
  if (m.sockets.length > 1) parts.push(`MC=${groupSpec(m, socketOf)}`, `PKG=${groupSpec(m, socketOf)}`);
  const caps = new Map();
  capsOf(m).forEach((cap, i) => { if (cap !== 1024) caps.set(cap, [...(caps.get(cap) ?? []), i + 1]); });
  if (caps.size) parts.push(`CAP=${[...caps].map(([cap, cpus]) => `${cpus.join(',')}:${cap}`).join('|')}`);
  return parts.join(';');
}
const topoLevels = (spec) => spec.split(';').map(e => e.split('=')[0]).filter(k => k !== 'CAP' && k !== 'CPUS');   // the levels a spec names
let layout = { first: 0, last: 0, width: 0, visible: 0 };   // the ticks the charts are showing
// ---- the window: which ticks the charts show ----
// The wheel pans and CELL -- the column width -- zooms; between them they fix the window, and
// every chart is handed it rather than working one out. That is why a column cannot drift
// between two charts.
let CELL = 8;
const LABEL_W = 48, CELL_MIN = 2, CELL_MAX = 24;
// `first` is the leftmost tick on screen and `follow` keeps it pinned to the newest one, so a
// running session scrolls itself. Panning away turns following off; panning back to the end turns
// it on again.
let first = 0, follow = true;
function computeWindow() {
  const W = $('charts').clientWidth || document.body.clientWidth;
  const visible = Math.max(1, Math.floor((W - LABEL_W - 4) / CELL));
  const maxFirst = Math.max(0, snapshots.length - visible);
  if (follow || first >= maxFirst) { first = maxFirst; follow = true; }
  layout = { first, last: Math.min(snapshots.length, first + visible), width: W, visible };
}
function panBy(ticks) {
  const next = Math.max(0, first + ticks);
  if (next === first) return;
  follow = false;   // computeWindow turns it back on if this lands at the live edge
  first = next;
  draw();
}
function draw() {
  computeWindow();
  drawCharts(layout);
}

// ---- figures: any per-task or per-CPU signal over the run's ticks ----
// One entry per signal worth watching change, and the toggles above the charts are built from it:
// adding or dropping a figure is a line here, and the drawing code never has to know. `domain`
// picks the series (a line per task, or per CPU) and `get` pulls the number out of that record --
// the kernel's own number, plotted as it stands, so the axis means what the Tasks and CPUs tables
// mean. Because snapshots holds whole records, ticking a figure on re-plots the run already
// recorded instead of needing it replayed.
//
// Deliberately a subset of what the tables show: a constant is a table cell, not a line. Slice and
// capacity never move within a session (capacity is set at boot, and changing it reboots), and
// nice and weight are two units for one number that only steps when you set it yourself.
const NS = (v) => v / 1e6;

const CHART_H = 116;
const LANE_INSET = 0.12;   // the gap above and below a row's bars, as a fraction of the row
// A row that is a gridline makes a lane look like a near miss: the task is *at* cpu1, not just
// above it. So a lanes figure draws each CPU as a band instead, and its lanes sit inside one.
// drawClear runs after the canvas is cleared and before the series, so the bands stay behind.
// A CPU's row is shared out, at each tick, among just the tasks that are on that CPU then --
// not among every task that exists. So a CPU running one task fills its whole row, exactly like
// a row to itself, and a CPU with three tasks queued splits into three. The row stays full
// whatever the task count, which fixed lanes could not do: they thinned as tasks were created,
// including for CPUs those tasks never touched. Depth is read from how finely a row is divided,
// and from the queues figure beside it; the row itself always reads as one CPU's worth of time.
// Solid means the task was running there in that tick; faint means it was queued on that CPU
// and waiting, which is the part a one-row-per-CPU view has no room for.
// Bars, not lines, because the y value is an identity: there is nothing between two rows to
// interpolate through, and a bar states residence where a line would imply passage.
function drawLanes(u2, ch) {
  const { left, top, width, height } = u2.bbox, ctx = u2.ctx, xs = u2.data[0];
  if (!xs.length || !ch.series?.length) return;
  const rows = Math.max(1, Math.round(u2.scales.y.max - u2.scales.y.min));
  const rowH = height / rows, inset = rowH * LANE_INSET;
  const colW = xs.length > 1
    ? Math.abs(u2.valToPos(xs[1], 'x', true) - u2.valToPos(xs[0], 'x', true))
    : width;
  ctx.save();
  ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
  const byRow = new Map();
  for (let d = 0; d < xs.length; d++) {
    byRow.clear();
    for (let i = 0; i < ch.series.length; i++) {           // who is on each CPU at this tick
      const v = u2.data[i + 1][d];
      if (v == null) continue;
      if (!byRow.has(v)) byRow.set(v, []);
      byRow.get(v).push(i);
    }
    const x = u2.valToPos(xs[d], 'x', true) - colW / 2, w = Math.max(1, colW - 0.5);
    for (const [v, idxs] of byRow) {
      const rowTop = Math.min(u2.valToPos(v - 0.5, 'y', true), u2.valToPos(v + 0.5, 'y', true));
      const laneH = (rowH - 2 * inset) / idxs.length;      // creation order, so the split is stable
      idxs.forEach((i, j) => {
        ctx.fillStyle = ch.series[i][2];
        ctx.globalAlpha = ch.ran?.[i][d] === false ? 0.22 : 1;
        ctx.fillRect(x, rowTop + inset + j * laneH, w, Math.max(1, laneH - 0.5));
      });
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawRows(u2) {
  const { left, top, width, height } = u2.bbox, ctx = u2.ctx;
  const lo = Math.round(u2.scales.y.min + 0.5), hi = Math.round(u2.scales.y.max - 0.5);
  ctx.save();
  ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
  for (let v = lo; v <= hi; v++) {
    const y0 = u2.valToPos(v - 0.5, 'y', true), y1 = u2.valToPos(v + 0.5, 'y', true);
    ctx.fillStyle = (v - lo) % 2 ? 'rgba(128,128,128,0.13)' : 'rgba(128,128,128,0.05)';
    ctx.fillRect(left, Math.min(y0, y1), width, Math.abs(y1 - y0));
  }
  ctx.restore();
}

// The series for the current metric: [key, label, colour], a line each.
const seriesOf = (fig) => fig.domain === 'task'
  ? tasks.map(t => [t.id, String(t.id), colorOf(t.id)])
  : Array.from({ length: ncpus }, (_, i) => [i + 1, `cpu ${i + 1}`, `hsl(${(i * 97) % 360}, 45%, 45%)`]);
// The metric for one series at one tick; undefined where there is no record, which draws a gap.
// Values are the kernel's own, not offsets from anything: the axis then means what the Tasks and
// CPUs tables mean, and a number does not change because the window was scrolled.
function sample(fig, key, tick) {
  const r = snapshots[tick]?.[fig.domain === 'task' ? 'tasks' : 'cpus'].get(key);
  return r === undefined ? undefined : fig.get(r);
}

// ---- figures: the charts worth drawing, each a metric read one way ----
// A curated list, not the cross-product of every metric and every way of reading one: only a
// handful of those combinations answer a question anyone asks, so those get a title and an
// explanation and the rest are not offered. Adding a figure is an entry here, and nothing else.
const FIGURES = {
  placement: { title: 'Placement', domain: 'task', get: (r) => r.cpu, integer: true, invert: true, lanes: true,
    note: 'one row per CPU, split among its tasks each tick: solid ran, faint waited' },
  cputime:   { title: 'cpu time', domain: 'task', get: (r) => NS(r.sum_exec_runtime),
    note: 'slope is that task’s share of the machine: parallel lines are an even split, a fan is a weighted one, a flat line is a task getting nothing' },
  // fair-class metrics read the task's fair record, so a task under fifo or rr draws a gap
  vruntime:  { title: 'vruntime', domain: 'task', get: (r) => r.fair && NS(r.fair.vruntime),
    note: 'runtime divided by weight, so under a fair split every task’s line climbs at the same rate whatever its nice — among tasks in the same cgroup, each cgroup having a queue and a virtual clock of its own' },
  lag:       { title: 'lag', domain: 'task', eevdf: true, get: (r) => r.fair && NS(r.fair.lag),
    note: 'the queue’s average vruntime minus the task’s, so zero is exactly fair, above it the task is owed time and below it has run ahead; unlike vruntime it is comparable across queues and does not jump when a task moves' },
  deadline:  { title: 'deadline', domain: 'task', eevdf: true, get: (r) => r.fair && NS(r.fair.deadline),
    note: 'EEVDF runs the eligible task with the earliest deadline, so the lowest line is the one that should be running' },
  queues:    { title: 'Runnable tasks', domain: 'cpu',  get: (r) => r.fair?.h_nr_runnable, integer: true,
    note: 'the balancer’s own count, h_nr_runnable, which leaves out a task queued only by delayed dequeue: it moves work to even these out, per unit of capacity rather than per task' },
  util:      { title: 'Fair utilization', domain: 'cpu',  get: (r) => r.fair?.util_avg,
    note: 'PELT, where 1024 is a full CPU; it is frequency-invariant, so it says what the work would need at full speed' },
  load:      { title: 'Fair load', domain: 'cpu',  get: (r) => r.fair?.load_avg,
    note: 'weighted demand, not a task count: nice changes it without any task appearing or leaving' },
};

// ---- the charts: as many as you want, stacked, all on the same ticks ----
// A chart is one figure and its uPlot instance. They all share one x window, so a point sits
// under the tick that produced it; dragging to zoom is off because the window is the wheel's and
// the column width's to set, and one chart must not move it out from under the others. The set lives in the URL
// (?charts=cputime,util), like the machine does, so a view is a link. uPlot owns each chart's
// axes, crosshair and legend; clicking a legend entry hides that series, and the crosshair is
// shared by every chart.
const charts = [];
const fgColor = () => getComputedStyle(document.body).color;
let chartPadRight = 0, xRange = [0, 1];

const uplotOpts = (W, series, ch) => { const fig = ch.fig; return {
  width: W, height: CHART_H,
  padding: [8, chartPadRight, 0, 0],
  // one crosshair across every chart in the stack
  cursor: { y: false, drag: { x: false, y: false }, points: { size: 5 }, sync: { key: 'kstep-ticks' } },
  legend: { live: true },
  ...(fig.lanes ? { hooks: { drawClear: [drawRows], draw: [(u2) => drawLanes(u2, ch)] } } : {}),
  scales: {
    x: { time: false, range: () => xRange },
    // Where the number is an identity rather than a magnitude -- a CPU, a task -- the axis runs
    // downward, so it reads the same way as the lists that name them: cpu1 first, like the Tasks
    // table starts at task 1, and the eye can go straight down from either. "since" is read against zero, so keep zero in view; "value"
    // just fits the data, and a count or an identity gets whole numbers and half a step of air.
    y: { dir: fig.invert ? -1 : 1,
         range: (u2, lo, hi) => {
           if (fig.integer) return [Math.round(lo) - 0.5, Math.round(hi) + 0.5];   // whole rows, lanes and all
           return hi === lo ? [lo, lo + 1] : uPlot.rangeNum(lo, hi, 0.1, true);
         } },
  },
  axes: [
    { size: 22, stroke: fgColor, grid: { show: false }, ticks: { size: 3, stroke: fgColor } },
    { size: LABEL_W, stroke: fgColor, ticks: { size: 3, stroke: fgColor },
      grid: fig.lanes ? { show: false } : { stroke: () => 'rgba(128,128,128,0.18)', width: 1 },
      ...(fig.integer ? { splits: (u2, ai, lo, hi) => {
        const out = []; for (let v = Math.ceil(lo); v <= Math.floor(hi); v++) out.push(v); return out; } } : {}) },
  ],
  // An identity or a count holds its value until it changes; joining the samples with a diagonal
  // would draw a task drifting between two CPUs, which never happens. Steps say what took place.
  series: [{ label: 'tick' }, ...series.map(([, label, color]) =>
    ({ label, stroke: color, width: 1.5, spanGaps: false,
       ...(fig.lanes ? { stroke: 'transparent', width: 0, points: { show: false } } : {}) }))],
}; };

function makeChart(id) {
  const fig = FIGURES[id];
  if (!fig) return null;
  const ch = { id, fig, u: null, shape: '' };
  ch.root = document.createElement('div'); ch.root.className = 'chart';
  const head = document.createElement('div'); head.className = 'chart-head';
  const title = document.createElement('b'); title.textContent = fig.title;
  const note = document.createElement('span'); note.className = 'note'; note.textContent = '— ' + fig.note;
  head.append(title, note);
  ch.mount = document.createElement('div');
  ch.root.append(head, ch.mount);
  $('charts').append(ch.root);
  charts.push(ch);
  return ch;
}
// the chart set is a URL parameter, updated in place so sharing a view needs no reboot
const saveCharts = () => {
  const p = new URLSearchParams(location.search);
  charts.length ? p.set('charts', charts.map(c => c.id).join(',')) : p.delete('charts');
  history.replaceState(null, '', `${location.pathname}?${p}`);
};

function drawOne(ch, first, last, W) {
  const series = seriesOf(ch.fig);
  const xs = [], ys = series.map(() => []);
  // A lanes figure also records whether the task was actually on the CPU at that tick or only
  // queued there, which is the difference between the solid blocks and the faint ones.
  const ran = ch.fig.lanes ? series.map(() => []) : null;
  for (let c = first; c < last; c++) {
    xs.push(c);
    series.forEach(([key], i) => {
      const v = sample(ch.fig, key, c);
      ys[i].push(v === undefined ? null : v);
      if (ran) ran[i].push(snapshots[c]?.tasks.get(key)?.state === 'running');
    });
  }
  ch.series = series; ch.ran = ran;   // the bar painter needs the colours, the lanes and the states
  const data = [xs, ...ys];
  // padRight is in the shape because uPlot fixes padding at construction: a resize needs a rebuild
  const shape = [ch.id, chartPadRight, series.length, series.map(([k, l]) => k + l).join(',')].join('|');
  if (!ch.u || ch.shape !== shape) {
    ch.u?.destroy();
    ch.u = new uPlot(uplotOpts(W, series, ch), data, ch.mount);
    ch.shape = shape;
  } else {
    ch.u.setSize({ width: W, height: CHART_H });
    ch.u.setData(data);
  }
}

// The figures do not work out their own window: they are handed the one computeWindow() set,
// so a column cannot drift between two of them. LABEL_W of y axis, then exactly `visible` x CELL of
// plot, which puts tick c at the centre of column c.
function drawCharts({ first, last, width: W, visible }) {
  if (!W) return;
  chartPadRight = Math.max(0, W - LABEL_W - visible * CELL);
  xRange = [first - 0.5, first - 0.5 + visible];
  for (const ch of charts) drawOne(ch, first, last, W);
}

// The stack is exactly the ticked figures, always in catalog order, so ticking one twice puts it
// in the same place both times. One control for both directions: no second way to remove a
// figure, and so nothing to keep in step with a second way.
function setCharts(ids) {
  const want = new Set(ids);
  for (const ch of [...charts]) { ch.u?.destroy(); ch.root.remove(); }
  charts.length = 0;
  for (const id of Object.keys(FIGURES)) if (want.has(id)) makeChart(id);
  for (const [id, box] of picks) { box.checked = want.has(id); box.parentElement.classList.toggle('on', box.checked); }
  saveCharts(); draw();
}
// One toggle per figure, grouped by what it is about: what is available and what is shown are the
// same list, so there is nothing else to keep in step. They are real checkboxes under the styling,
// which keeps the keyboard and screen-reader behaviour for free.
const picks = new Map();
{
  const rows = { task: 'Per task', cpu: 'Per CPU' };
  for (const [domain, label] of Object.entries(rows)) {
    const row = document.createElement('div'); row.className = 'pick-row';   // the row names the series, so the titles do not repeat it
    const name = document.createElement('span'); name.className = 'pick-label'; name.textContent = label;
    row.append(name);
    for (const [id, f] of Object.entries(FIGURES)) {
      if (f.domain !== domain) continue;
      const chip = document.createElement('label'), box = document.createElement('input');
      chip.className = 'chip'; chip.title = f.note;
      box.type = 'checkbox';
      box.onchange = () => setCharts([...picks].filter(([, b]) => b.checked).map(([k]) => k));
      chip.append(box, document.createTextNode(f.title));
      row.append(chip);
      picks.set(id, box);
    }
    $('figure-picks').append(row);
  }
}

// Zoom is the column width: every chart's x range is computed from CELL, so widening it is the
// whole of zooming, and computeWindow() stays the one authority on the window.
function zoomAt(clientX, delta) {
  const next = Math.min(CELL_MAX, Math.max(CELL_MIN, CELL + (delta < 0 ? 1 : -1)));
  if (next === CELL) return;
  const x = Math.max(LABEL_W, clientX - $('charts').getBoundingClientRect().left);
  const tick = first + (x - LABEL_W) / CELL;   // the tick under the pointer stays under it
  CELL = next;
  if (!follow) first = Math.max(0, Math.round(tick - (x - LABEL_W) / CELL));
  draw();
}
const onWheel = (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) return zoomAt(e.clientX, e.deltaY);
  const px = e.deltaX || e.deltaY;
  panBy(Math.trunc(px / CELL) || Math.sign(px));   // at least one column, whatever the wheel sends
};
addEventListener('resize', draw);
$('charts').addEventListener('wheel', onWheel, { passive: false });

// ---- layout table: one row per cluster, which is the machine's shape ----
// The draft the form is editing; the VM reboots into it, since only the CPU count needs one.
let draft = one(core(2), core(2));
const sig = (m) => m.sockets.map(cl => cl.map(cs => cs.map(c => `${c.threads}@${c.cap ?? 1024}`).join()).join('|')).join(';');
const button = (label, cls, title, onclick) => {
  const b = document.createElement('button');
  b.textContent = label; b.className = cls; b.title = title; b.setAttribute('aria-label', title);
  b.onclick = onclick;
  return b;
};
const addBtn = (label, title, onclick) => button(label, 'act', title, onclick);
const binBtn = (title, onclick) => button('\u2715', 'act rm', title, onclick);
const boxName = (text) => { const el = document.createElement('span'); el.className = 'name'; el.textContent = text; return el; };
// The picture is the form. Every box is the thing it draws -- a socket, a cluster, a core -- and
// its buttons add to or remove that thing, so there is no second place where the machine is
// described in words. A core shows the CPUs its threads will be, and its capacity as a bar as well
// as a number, since the point of a mixed cluster is that the cores are not the same size.
// Every cluster keeps at least one core and every socket at least one cluster. Pruned before
// drawing, not after: removing a cluster's last core has to take the cluster with it in the same
// pass, or the box it left behind is what you see. In place, so no array a button was drawn
// against is ever swapped out from under it.
function prune(m) {
  for (const clusters of m.sockets)
    for (let i = clusters.length - 1; i >= 0; i--) if (!clusters[i].length) clusters.splice(i, 1);
  for (let i = m.sockets.length - 1; i >= 0; i--) if (!m.sockets[i].length) m.sockets.splice(i, 1);
  if (!m.sockets.length) m.sockets.push([[core()]]);
}
function renderLayout() {
  prune(draft);
  const box = $('cpu-layout');
  box.replaceChildren();
  const room = nCpus(draft) < MAX_CPUS;
  const manySockets = draft.sockets.length > 1;
  const lastCore = allCores(draft).length < 2;
  draft.sockets.forEach((clusters, si) => {
    const sock = document.createElement('div'); sock.className = 'socket';
    // Each box's header names it and carries what can be done to it: add one of what it holds,
    // and remove it. So the buttons sit on the thing they act on rather than beside it.
    const sh = document.createElement('header');
    sh.append(boxName('socket'));
    if (room) sh.append(addBtn('+ cluster', 'Add a cluster to this socket', () => { draft.sockets[si].push([core()]); renderLayout(); }));
    if (manySockets) sh.append(binBtn('Remove this socket', () => { draft.sockets.splice(si, 1); renderLayout(); }));
    sock.append(sh);
    const row = document.createElement('div'); row.className = 'clusters';
    clusters.forEach((cores, ci) => {
      const clus = document.createElement('div'); clus.className = 'cluster';
      const ch = document.createElement('header');
      ch.append(boxName('cluster'));
      if (room) ch.append(addBtn('+ core', 'Add a core to this cluster', () => { draft.sockets[si][ci].push(core(1, c0(cores).cap)); renderLayout(); }));
      if (clusters.length > 1 || manySockets)
        ch.append(binBtn('Remove this cluster', () => {
          draft.sockets[si].splice(ci, 1);
          if (!draft.sockets[si].length && draft.sockets.length > 1) draft.sockets.splice(si, 1);
          renderLayout();
        }));
      clus.append(ch);
      const cs = document.createElement('div'); cs.className = 'cores';
      cores.forEach((c, oi) => cs.append(coreBox(c, cores, oi, si, ci, room, lastCore)));
      clus.append(cs); row.append(clus);
    });
    sock.append(row); box.append(sock);
  });
  if (room) box.append(addBtn('+ socket', 'Add a socket', () => { draft.sockets.push([[core()]]); renderLayout(); }));
  refreshLayout();
}
const c0 = (cores) => cores.at(-1) ?? core();
// One core: its threads as the CPUs they will be, what it is worth, and what can be done to it.
function coreBox(c, cores, oi, si, ci, room, lastCore) {
  const el = document.createElement('div'); el.className = 'core';
  const h = document.createElement('header');
  h.append(boxName('core'), addBtn('+ thread', 'Add a thread to this core: one more CPU', () => { c.threads++; renderLayout(); }));
  if (!lastCore) h.append(binBtn('Remove this core', () => { draft.sockets[si][ci].splice(oi, 1); renderLayout(); }));
  el.append(h);
  // "cpu capacity" is the kernel's own term (arch_scale_cpu_capacity) and says which it is: per
  // CPU, not the core's total, so each of a core's threads gets this value -- which is what CAP
  // takes. Edits go through refreshLayout, not renderLayout, so a box is not rebuilt under the
  // cursor mid-type.
  const field = (label, opts, get, set) => {
    const row = document.createElement('div'); row.className = 'caprow';
    const lbl = document.createElement('span'); lbl.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'capnum';
    Object.assign(inp, opts);
    inp.value = get();
    inp.setAttribute('aria-label', `${label} of the core on cpu ${coreCpus(draft, si, ci, oi)[0] ?? '?'}`);
    // A number outside the range is simply not taken: the model keeps its last good value, the
    // box is marked until it reads one again, and leaving the field puts the good value back. So
    // a half-typed or empty field never makes the machine invalid, and 0 never reaches it.
    inp.oninput = () => {
      const v = parseInt(inp.value);
      const ok = Number.isFinite(v) && v >= opts.min && v <= opts.max;
      inp.classList.toggle('bad', !ok);
      if (ok) { set(v); refreshLayout(); }
    };
    inp.onblur = () => { inp.value = get(); inp.classList.remove('bad'); refreshLayout(); };
    row.append(lbl, inp);
    return row;
  };
  // One line: the threads as the CPUs they will be -- one chip each, removable while the core
  // keeps one; the numbers follow the tree, as the kernel's do, so refreshLayout writes them --
  // then the capacity every one of them gets.
  const line = document.createElement('div'); line.className = 'cpuline';
  const cpus = document.createElement('span');
  cpus.className = 'corecpus'; cpus.dataset.si = si; cpus.dataset.ci = ci; cpus.dataset.oi = oi;
  line.append(cpus, field('capacity', { min: 1, max: 1024, step: 128 }, () => c.cap ?? 1024, (v) => { c.cap = v; }));
  el.append(line);
  return el;
}

// What the draft implies, and whether it can boot at all.
function refreshLayout() {
  draft.ids = null;   // the counts changed, so the cached CPU map is stale
  const count = nCpus(draft);
  for (const el of $('cpu-layout').querySelectorAll('.corecpus')) {
    const si = +el.dataset.si, ci = +el.dataset.ci, oi = +el.dataset.oi, c = draft.sockets[si][ci][oi];
    const list = coreCpus(draft, si, ci, oi);
    el.replaceChildren(...list.map((cpu) => {
      const chip = document.createElement('span'); chip.className = 'thread'; chip.textContent = `cpu ${cpu}`;
      if (list.length > 1) chip.append(binBtn(`Remove this thread, cpu ${cpu}`, () => { c.threads--; renderLayout(); }));
      return chip;
    }));
  }
  for (const b of $('cpu-layout').querySelectorAll('.core > header > button.act:not(.rm)')) b.disabled = count >= MAX_CPUS;   // + thread, while the machine has room
  const badCap = allCores(draft).some(c => !(c.cap >= 1 && c.cap <= 1024));
  const error = badCap ? 'A core\u2019s capacity is 1 to 1024, where 1024 is a full CPU.'
              : count < 1 ? 'A machine needs at least one core.'
              : count > MAX_CPUS ? `That is ${count} CPUs; the shared region reports at most ${MAX_CPUS} (KSTEP_SHM_CPUS).` : '';
  $('cpu-hint').textContent = error;
  $('cpu-hint').className = error ? 'hint bad' : 'hint';
  $('boot').disabled = !!error;
  $('ncpus-label').textContent = `${count} CPU${count === 1 ? '' : 's'}`;
  checkDirty();
  return !error;
}

// Highlight Restart while the draft differs from the machine the VM booted with.
function checkDirty() {
  const dirty = sig(draft) !== sig(machine);
  $('boot').classList.toggle('primary', dirty);
  $('discard-cpus').disabled = !dirty;
  $('cpu-draft').textContent = dirty ? '\u00b7 unapplied changes' : '';
  $('boot').title = dirty ? 'the draft differs from the running VM: reboot with this machine (reloads the page)' : 'reboot the VM with this machine (reloads the page)';
}
function setCpuDraft(m) {
  draft = asMachine(m);
  renderLayout();
}
// Frequency is the one per-CPU scale that moves while the machine runs, as cpufreq does to it, so
// it is a live control here; capacity is what the hardware is and belongs to the machine form
// (CAP in the cpu-topo line). One driver line per CPU changed: `cpu-freq <cpu> <scale>`.
const FREQ = 1;   // the frequency column of a CPU's row: the one hardware number that moves while it runs
// The frequency of one CPU as a number box, 1..1024 with 1024 the full CPU, sent as one cpu-freq
// line; the kernel's value flows back through sync, so a driver line shows up.
function freqBox(cpu) {
  const el = document.createElement('input');
  el.type = 'number'; el.min = 1; el.max = 1024; el.step = 1; el.value = 1024; el.className = 'capnum';
  el.title = `Frequency of cpu ${cpu}, 1..1024: the scale the fair class's averages accrue at`; el.setAttribute('aria-label', el.title);
  onSet(el, `cpu-freq ${cpu}`);
  return el;
}
// ---- sched domains: the hierarchy the kernel built, which is not always the one asked for ----
// Every CPU in a domain's span has its own copy of it, and they agree on everything the structure
// is made of -- span, groups, flags, the balancing knobs -- differing only in the order sd->groups
// starts at (its own group) and in nr_balance_failed. So the table is one row per distinct
// (level, span) rather than per CPU, with the groups listed lowest CPU first to be stable.
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const cpulist = (mask) => {   // 0b1110 -> "1-3"
  const out = [];
  for (let c = 0; c < MAX_CPUS + 1; c++) {
    if (!(mask >> c & 1)) continue;
    let end = c;
    while (mask >> (end + 1) & 1) end++;
    out.push(end > c ? `${c}-${end}` : `${c}`);
    c = end;
  }
  return out.join(',') || '—';
};
const lowestCpu = (mask) => { for (let c = 0; c < MAX_CPUS + 1; c++) if (mask >> c & 1) return c; return 99; };
// A utilization bar: the fill is util over capacity, the number beside it; red past the capacity,
// which on an asymmetric level is what misfit looks for.
// The bar also carries the balancer's class of what it measures: the word inside the track and
// the fill in that class's colour, since the class is a reading of this very ratio.
const bold = (v) => { const el = document.createElement('b'); el.textContent = v; return el; };
const CLASS_TITLE = 'how the balancer one level up classes this group (group_classify), from its sums against its capacity with the level\u2019s imbalance_pct as the margin: overloaded when it holds more runnable tasks than CPUs and its utilization or runnable demand exceeds its capacity; has spare when a CPU is idle or the demand clears the margin below capacity; fully busy between. A busier class always beats a less busy one as the busiest group; load decides only within a class. Misfit, imbalanced and asym packing are not shown: they need per-task load, affinity failures and CPU priorities the region does not carry';
// One bar per box: running, the time the fair tasks were on the CPU (PELT util_avg), over the
// capacity, in the colour of the balancer's class of the group -- green has spare, orange fully
// busy, red overloaded. The other two PELT sums are on hover: contention, time on the queue
// running or waiting (runnable_avg), and load, contention weighted by nice (load_avg), the figure
// the balancer compares between siblings.
function bar() {
  const el = document.createElement('span'); el.className = 'bar';
  const track = document.createElement('span'); track.className = 'track';
  const fill = document.createElement('span'); fill.className = 'fill';
  const num = document.createElement('span'); num.className = 'num';
  track.append(fill, num);
  el.append(track);
  el.update = ({ util, runnable, load }, capacity, cls) => {
    fill.style.width = `${capacity ? Math.min(100, 100 * util / capacity) : 0}%`;
    num.textContent = `${util} / ${capacity}`;
    el.dataset.cls = cls ?? '';
    el.title = `running ${util} of capacity ${capacity}, 1024 being one CPU at full speed: time the fair tasks were on the CPU (PELT util_avg). Contention ${runnable}: time they were on the queue, running or waiting (runnable_avg); above running is tasks waiting. Load ${load}: contention weighted by nice (load_avg), what the balancer compares between siblings.${cls ? ` The colour is the balancer\u2019s class of this group, ${cls}: ` + CLASS_TITLE : ''}`;
  };
  return el;
}

// One CPU at a leaf of the tree, as a card: the frequency knob, since it scales how fast the
// averages accrue, the utilization bar across the card, then the rest of what the balancer reads there. Built once
// with the tree and updated in place, so the knob is not rebuilt under an open menu.
function cpuRow(cpu, capacity, pct, parent) {
  const row = document.createElement('div'); row.className = 'cpu-row';
  const name = document.createElement('span'); name.className = 'cpu'; name.textContent = `cpu ${cpu}`;
  const knob = freqBox(cpu);
  const freq = document.createElement('label'); freq.className = 'freq'; freq.append('freq ', knob);
  const util = bar();
  // the task count, as a group's header has it: the balancer's own count, and the runqueue's raw
  // depth after a plus when the two disagree, since what is queued but not in the balancer's
  // number is a real-time task, or one delayed dequeue has yet to let go
  const ntasks = document.createElement('span'); ntasks.className = 'stat';
  ntasks.title = 'cfs_rq h_nr_runnable: runnable tasks as the load balancer counts them, the number it evens out. When the runqueue holds more -- a real-time task, or one left queued by delayed dequeue -- the extra follow after a plus';
  const count = document.createElement('b'), unit = document.createTextNode(' tasks'); ntasks.append(count, unit);
  const hot = document.createElement('span'); hot.className = 'hot';
  const when = document.createElement('span'); when.className = 'stat when';
  when.title = 'ticks until this CPU, as a group of one at the level above, is next balanced against its siblings there. Due means the interval is up and the balance runs at the next tick; it can stay due while another CPU balances the levels below, which stops this CPU\u2019s walk up the levels';
  // three lines: who, its knob and its task count, as a group's header reads; the bars across the
  // card, carrying the balancer's class; then the failure badge and, at the right, the countdown
  const top = document.createElement('div'); top.className = 'line'; top.append(name, freq, ntasks);
  const bottom = document.createElement('div'); bottom.className = 'line'; bottom.append(hot, when);
  row.append(top, util, bottom);
  row.update = () => {
    const r = cpuRecords.get(cpu), f = r?.fair;
    sync(knob, r?.freq);   // the kernel's value, so a driver line shows up
    if (!r || !f) return;
    util.update({ util: f.util_avg, runnable: f.runnable_avg, load: f.load_avg }, r.capacity, capacity === undefined ? undefined : cpuRow.classify(cpu, capacity, pct));
    count.textContent = r.nr_running === f.h_nr_runnable ? `${f.h_nr_runnable}` : `${f.h_nr_runnable}+${r.nr_running - f.h_nr_runnable}`;
    unit.textContent = f.h_nr_runnable === 1 && r.nr_running === 1 ? ' task' : ' tasks';
    row.classList.toggle('pulled', lastMoves.pulled.has(cpu));   // this CPU ran the balancer on the last command
    const mine = parent && domains.find((x) => x.name === parent.name && x.cpu === cpu);
    when.replaceChildren(...(mine ? ['balance ', ...(mine.next_balance_in === 0 ? [bold('due')] : ['in ', bold(mine.next_balance_in)])] : []));
    // failures escalate to active balancing past cache_nice_tries + 2: the one piece of balance
    // history worth showing, and only once it is there
    const failing = domains.filter((d) => d.cpu === cpu && d.nr_balance_failed > d.cache_nice_tries + 2);
    hot.textContent = failing.map((d) => `${d.nr_balance_failed} failed at ${d.name}`).join(', ');
    hot.title = failing.map((d) => `${d.nr_balance_failed} balance attempts at ${d.name} failed in a row, past the ${d.cache_nice_tries + 2} the kernel escalates at: the next one may push the running task off`).join('\n');
  };
  return row;
}
// The sched domains as one tree. Every CPU in a span has its own copy of the domain, agreeing on
// span, groups, flags and knobs, so one copy per distinct (level, span) is the structure; the
// widest span is the root and a domain's groups are the spans of the domains one level down, or
// single CPUs at the leaves. Each box shows its utilization over capacity -- the sum the balancer
// makes over its CPUs, against the kernel's group capacity -- so at every level the busiest
// sibling is the longest bar.
let balancerKey = '', balancerNodes = [];   // the tree built, and every node's update
function renderBalancer() {
  const seen = new Map();   // "LEVEL span" -> the first CPU's copy, with the level's depth
  const depth = new Map();
  for (const d of domains) {
    const n = (depth.get(d.cpu) ?? -1) + 1, key = `${d.name} ${d.span}`;
    depth.set(d.cpu, n);
    if (!seen.has(key)) seen.set(key, { ...d, depth: n });
  }
  const all = [...seen.values()];
  // the same structure as last time: the numbers move, the boxes stay, and an open menu with them
  const key = `${ncpus}|${all.map((d) => `${d.name} ${d.span} ${d.flags}`).join(';')}`;
  if (key === balancerKey) { for (const n of balancerNodes) n.update(); return; }
  balancerKey = key; balancerNodes = [];
  const cpusOf = (span) => Array.from({ length: ncpus }, (_, i) => i + 1).filter((c) => span >> c & 1);
  const sumOf = (span, get) => cpusOf(span).reduce((u, c) => u + (get(cpuRecords.get(c)) ?? 0), 0);
  const utilOf = (span) => sumOf(span, (r) => r?.fair?.util_avg);
  const tasksOf = (span) => sumOf(span, (r) => r?.fair?.h_nr_runnable);
  // The kernel's classification of a group, as its parent level's balancer makes it
  // (group_classify: group_is_overloaded and group_has_capacity in fair.c), from the sums over the
  // group's CPUs against its capacity, with the level's imbalance_pct as the margin. Of the
  // kernel's seven classes the three here are the ones these sums decide; misfit, imbalanced and
  // asym packing read per-task load, affinity failures and CPU priorities the region does not carry.
  const classify = (span, capacity, pct) => {
    const n = tasksOf(span), weight = cpusOf(span).length;
    const util = utilOf(span), runnable = sumOf(span, (r) => r?.fair?.runnable_avg);
    const overloaded = n > weight && (capacity * 100 < util * pct || capacity * pct < runnable * 100);
    if (overloaded) return 'overloaded';
    const spare = n < weight || (!(capacity * pct < runnable * 100) && capacity * 100 > util * pct);
    return spare ? 'has spare' : 'fully busy';
  };
  const idleOf = (span) => cpusOf(span).filter((c) => cpuRecords.get(c)?.idle).length;
  // a domain's box: header, then its groups side by side, each the box of the domain one level
  // down with that span, or a CPU's row
  const boxOf = (d, capacity, pct, parent) => {
    const box = document.createElement('div'); box.className = 'dom';
    const head = document.createElement('header');
    // The box is named for what its span is -- a core, a cluster, a socket; the kernel's level name,
    // what a boot log or the source calls it, is on hover. A level exists only where its span adds
    // something, so a core's level is gone on single-thread cores.
    const LEVELS = { SMT: ['core', 'the threads of a core'], CLS: ['cluster', 'the cores of a cluster'], MC: ['socket', 'the cores of a socket, sharing its last-level cache'],
                     PKG: ['socket', 'a socket, kept when there are several'], DIE: ['socket', 'a socket, kept when there are several'], NODE: ['node', 'a NUMA node'] };
    const [word, what] = LEVELS[d.name] ?? [d.name.toLowerCase(), 'a topology level'];
    const lvl = document.createElement('span'); lvl.className = 'lvl'; lvl.textContent = word;
    lvl.title = `${d.name}: ${what}\ninterval ${d.balance_interval} ticks, imbalance_pct ${d.imbalance_pct}, busy_factor ${d.busy_factor}, cache_nice_tries ${d.cache_nice_tries}`
      + (d.flags ? `\nflags: ${d.flags}` : '');
    const span = document.createElement('span'); span.className = 'span'; span.textContent = cpulist(d.span);
    head.append(lvl, span);
    const cap = capacity ?? d.groups.reduce((c, g) => c + g.capacity, 0);
    const util = bar();
    const n = document.createElement('span'); n.className = 'stat';
    const when = document.createElement('span'); when.className = 'stat when';
    when.title = 'ticks until this group is next balanced against its siblings: the level\u2019s interval since its last balance, busy_factor times longer while the balancing CPU is busy. The CPU that runs it is the group\u2019s first idle one -- on an idle core, above the SMT level -- or its first CPU when none is idle. Due means the interval is up; the balance runs at that CPU\u2019s next tick, and can stay due for a while when another CPU is the balancer at a level below, since the tick\u2019s walk up the levels stops there. The log below records the balances that actually ran';
    head.append(n);
    const foot = document.createElement('footer'); foot.append(when);   // when this level next weighs its groups
    balancerNodes.push({ update: () => {
      util.update({ util: utilOf(d.span), runnable: sumOf(d.span, (r) => r?.fair?.runnable_avg), load: sumOf(d.span, (r) => r?.fair?.load_avg) }, cap, classify(d.span, cap, pct ?? d.imbalance_pct));
      const idle = idleOf(d.span), nt = tasksOf(d.span);
      n.replaceChildren(bold(nt), nt === 1 ? ' task' : ' tasks', ...(idle ? [', ', bold(idle), ' idle'] : []));
      // the parent level's record for a CPU of this group names the CPU that balances it, and that
      // CPU's record has the countdown
      const any = parent && domains.find((y) => y.name === parent.name && (d.span >> y.cpu & 1));
      const rec = any && domains.find((x) => x.name === parent.name && x.cpu === any.balancer);
      when.replaceChildren(...(rec ? ['balance ', ...(rec.next_balance_in === 0 ? [bold('due')] : ['in ', bold(rec.next_balance_in)])] : []));
    } });
    const kids = document.createElement('div'); kids.className = 'kids';
    for (const g of [...d.groups].sort((a, b) => lowestCpu(a.span) - lowestCpu(b.span))) {
      const child = all.filter((c) => c.span === g.span && c.depth < d.depth).sort((a, b) => b.depth - a.depth)[0];
      if (child) kids.append(boxOf(child, g.capacity, d.imbalance_pct, d));
      else { const row = cpuRow(lowestCpu(g.span), g.capacity, d.imbalance_pct, d); balancerNodes.push(row); kids.append(row); }
    }
    if ([...kids.children].every((k) => k.classList.contains('cpu-row'))) kids.classList.add('cpus');   // a level of CPUs: cards side by side
    box.append(head, util, kids, foot);   // the bar on a line of its own, above what it sums, as a CPU's card has it
    return box;
  };
  const top = all.filter((d) => d.depth === Math.max(...all.map((d) => d.depth))).sort((a, b) => lowestCpu(a.span) - lowestCpu(b.span));
  // no domains at all -- one test CPU -- and the CPUs still have their rows
  cpuRow.classify = (cpu, capacity, pct) => classify(1 << cpu, capacity, pct);
  const rows = () => Array.from({ length: ncpus }, (_, i) => { const row = cpuRow(i + 1); balancerNodes.push(row); return row; });
  $('balancer').replaceChildren(...(top.length ? top.map((d) => boxOf(d)) : rows()));
  if (!top.length) $('balancer').classList.add('cpus'); else $('balancer').classList.remove('cpus');
  for (const n of balancerNodes) n.update();
  // The levels asked for that the kernel collapsed away: the page knows what it sent.
  const built = new Set(all.map(d => d.name));
  const gone = topoLevels(topoLine?.slice(9) ?? '').filter(l => !built.has(l));
  $('domains-collapsed').textContent = !domains.length ? '' : gone.length ? `Collapsed as redundant: ${gone.join(', ')}.` : '';
}

// The machine reaches the kernel as one cli command, sent once the driver is ready: the topology,
// capacities included, which rebuilds the sched domains.
function cpuSetup(m) {
  return [`cpu-topo ${topoSpec(m)}`];
}

// ---- the script: one uniform way to state an initial condition ----
// Everything the page sets up is driver lines, in order, exactly as you could type them: the
// machine, the tasks, and whatever is done to them. Two page-side conveniences, because the
// driver has no notion of either: `tick N` steps N times, and `*` in a task
// position means every task created so far.
const MACHINE_VERBS = ['cpu-topo'];
const parseScript = (text) => text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
// Every CPU the spec names; the machine's size is the highest of them, since cpu0 is the driver's.
function cpusInTopo(spec) {
  let max = 0;
  for (const n of spec.replace(/:\d+/g, '').matchAll(/\d+/g)) max = Math.max(max, +n[0]);
  return max;
}
// The machine a script asks for, read back out of its cpu-topo line so the form can
// show it. Rather than checking the shape field by field, the parse is confirmed by regenerating
// the spec from it: if that matches the script's, the form states exactly this machine. If it does
// not, the structure is still reported -- the CPU count and grouping are what they are -- with
// `exact` false, and the caller shows the machine but refuses to edit it.
function machineFromScript(script) {
  const topo = script.find(l => l.startsWith('cpu-topo '))?.slice(9).trim();
  if (!topo) return null;
  const level = (name) => topo.split(';').find(l => l.startsWith(name + '='))?.slice(name.length + 1);
  const parse = (spec) => (spec ?? '').split('|').map(g => g.split(',').flatMap(r => {
    const [a, b] = r.split('-').map(Number);
    return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
  })).filter(g => g.length && g[0] !== 0);
  const n = cpusInTopo(topo);
  if (!n) return null;
  // a level not named leaves every CPU alone; the form's socket is the whole machine when unnamed
  const alone = () => Array.from({ length: n }, (_, i) => [i + 1]);
  const smt = level('SMT') ? parse(level('SMT')) : alone(), cls = level('CLS') ? parse(level('CLS')) : alone();
  const mc = level('PKG') ? parse(level('PKG')) : [];
  const caps = new Map();
  for (const g of (level('CAP') ?? '').split('|').filter(Boolean)) {
    const [list, v] = g.split(':');
    for (const cpu of parse(list).flat()) caps.set(cpu, +v);
  }
  const byFirst = (a, b) => a[0] - b[0];
  const sockets = (mc.length ? mc : [Array.from({ length: n }, (_, i) => i + 1)]).sort(byFirst).map(sock =>
    // the clusters this socket holds, and in each the cores, one per SMT group
    cls.filter(g => g.every(c => sock.includes(c))).sort(byFirst).map(group =>
      smt.filter(c => c.every(x => group.includes(x))).sort(byFirst)
         .map(c => core(c.length, caps.get(c[0]) ?? 1024))
    ).filter(cs => cs.length)
  ).filter(cl => cl.length);
  if (!sockets.length) return null;
  const m = mach(...sockets);
  if (nCpus(m) !== n) return null;
  // the parse is right exactly when it reproduces what the script said; a link from before CPUS
  // was part of the spec still states its machine exactly
  m.exact = topoSpec(m) === (topo.startsWith('CPUS=') ? topo : `CPUS=${n};${topo}`);
  return m;
}

// The script with its machine lines replaced by the ones this machine implies, so editing the
// layout form edits the script rather than living beside it.
const scriptWith = (script, m) => [...cpuSetup(m), ...script.filter(l => !MACHINE_VERBS.includes(l.split(' ')[0]))];

// ---- task table: rows are created once and updated in place (no rebuild, no flicker) ----
const rowOf = new Map();
const CG = 1, STATE = 2, AFF = 3, CPU = 4, TIME = 5, SCHED = 6, ACT = 7, NCOLS = 8;   // where the task may run and is, what it got, then its policy with the parameter that policy reads, in one cell as sched_setattr takes them
const AFF_TITLE = 'CPUs the task may run on';
// A row's controls are inputs and views at once: the user types into them, but the same
// settings get changed behind their back -- a scenario's setup script sends driver lines
// directly, and a cgroup's cpuset narrows a task's CPUs -- so the kernel's value has to be
// able to flow back in. Skip a control the user is in the middle of: focused, or with an edit
// still in flight. A rejected edit is dropped: the next snapshot puts the kernel's value back.
// The focus guard is for a value being typed, which a refresh would overwrite mid-keystroke. A
// checkbox has no half-finished state -- the click is the whole of the intent and it went to the
// kernel as it happened -- so a mask still takes the kernel's answer while it holds focus, and
// what the kernel made of the set shows up on the click rather than on the way out of the cell.
// `pending` still covers the flight, so nothing flashes the old set in between.
const sync = (el, v) => {
  const focused = document.activeElement;
  if (v === undefined || el.dataset.pending) return;
  if (el.contains(focused) && focused?.type !== 'checkbox') return;
  el.value = v;
};
// A CPU set as one checkbox per CPU 1..ncpus; `value` is the bitmask the shared region reports, `list` the
// cpulist the driver takes. Every toggle is sent, including an empty set: the kernel is the one that
// says no, and its refusal shows in the transcript like any other.
function cpuMask(title, line) {
  const el = document.createElement('span'); el.title = title;
  const boxes = Array.from({ length: ncpus }, (_, i) => {
    const b = document.createElement('input'); b.type = 'checkbox'; b.checked = true; b.title = `CPU ${i + 1}`;
    b.onchange = () => {
      el.dataset.pending = '1';
      enqueue(async () => {
        const r = await cmd(line(el.list));
        delete el.dataset.pending;
        if (r.error) b.blur();   // sync() leaves a focused control alone, and the refresh has to put the real set back
      });
    };
    el.append(b); return b;
  });
  Object.defineProperty(el, 'value', {
    get: () => boxes.reduce((m, b, i) => m | (b.checked << (i + 1)), 0),
    set: (mask) => boxes.forEach((b, i) => b.checked = !!(mask & (1 << (i + 1)))),
  });
  Object.defineProperty(el, 'list', { get: () => boxes.flatMap((b, i) => b.checked ? [i + 1] : []).join(',') });
  return el;
}
// Send a control's value as `<verb> <value> [tail]`; the value is read when the event fires.
const onSet = (el, verb, tail = '') => el.onchange = () => {
  const v = el.value;
  el.dataset.pending = '1';
  enqueue(async () => {
    const r = await cmd(`${verb} ${v}${tail}`);   // a rejection shows in the transcript; the refresh restores the real value
    delete el.dataset.pending;
    if (r.error) el.blur();   // sync() leaves a focused control alone
  });
};
// Which parameter the row shows, from the policy the kernel reports. A real-time task is ordered
// by priority and its nice is inert; SCHED_IDLE ignores nice as well, since the class pins the
// entity at a fixed minimal weight. Neither is hidden: an inert nice is greyed with the reason,
// because "this knob does nothing here" is the thing the table is there to say.
function setParam(tr, policy) {
  if (policy === undefined) return;
  const [, niceL, prioL] = tr.cells[SCHED].children, nice = niceL.lastElementChild;
  const rt = policy === 'fifo' || policy === 'rr';
  niceL.hidden = rt;
  prioL.hidden = !rt;
  // under SCHED_IDLE the nice is kept but not read, so it stays settable, as the kernel has it, and
  // is drawn inert rather than disabled: what it says is "this knob does nothing here"
  nice.classList.toggle('inert', policy === 'idle');
  nice.title = policy === 'idle'
    ? 'SCHED_IDLE ignores nice: the class runs the task at a fixed minimal weight (3) whatever it is set to. The value is kept and comes back into force under normal or batch'
    : 'nice, the fair classes\u2019 share knob: lower is a larger share';
}

// One task's row, created on first sight and updated in place. Per task rather than per
// table, so a record can be shown the moment it arrives.
function renderTask(t) {
  const tb = $('tasks').querySelector('tbody');
  let tr = rowOf.get(t.id);
  if (!t.alive) { if (tr) { tr.remove(); rowOf.delete(t.id); } return; }
  if (!tr) {
    tr = tb.insertRow(); rowOf.set(t.id, tr);
    for (let i = 0; i < NCOLS; i++) tr.insertCell();   // one per <th>; vruntime and deadline are queue-local, so they live under Scheduler
    tr.cells[ACT].style.whiteSpace = 'nowrap';
    // the task's number in its figure colour, the same chip as under Scheduler, so a task is one
    // mark wherever it appears. The row sits under its cgroup's row.
    tr.cells[0].append(chip(t));
    // The cgroup is a property of the task like its policy, so it is a control in the row: a select
    // over the tree's paths, the kernel's value flowing back in like the others. Its options are the
    // tree's and are rebuilt by renderGroups as the tree changes.
    const cg = document.createElement('select'); cg.className = 'cgroup'; cg.title = 'the task\u2019s cgroup; pick another to move it there';
    onSet(cg, 'cgroup-attach', ` ${t.id}`);
    tr.cells[CG].append(cg);
    // The scheduling parameter, which is not one control but whichever one the task's policy
    // reads: nice for the fair classes, a real-time priority for fifo and rr. One cell holds both
    // and shows the one that is in force, so a task's row never offers a knob its class ignores.
    const nice = document.createElement('input'); nice.type = 'number'; nice.min = -20; nice.max = 19; nice.value = 0; nice.style.width = '2.9rem';
    // each parameter is set together with the class that reads it, as sched_setattr takes them:
    // the row's current policy goes with the new value
    const setParamWith = (el, verb) => el.onchange = () => { const pol = tr.cells[SCHED].firstElementChild.value; el.dataset.pending = '1';
      enqueue(async () => { const r = await cmd(`${verb} ${t.id} ${pol} ${el.value}`); delete el.dataset.pending; if (r.error) el.blur(); }); };
    setParamWith(nice, 'policy-fair');
    const prio = document.createElement('input'); prio.type = 'number'; prio.min = 1; prio.max = 99; prio.value = 80; prio.style.width = '2.9rem';
    prio.title = 'real-time priority, 1..99: it orders fifo and rr tasks against each other only, higher first, '
      + 'and any of them outranks every fair task. The kernel sets it together with the policy, so picking fifo or rr sends this value. '
      + 'The task\u2019s nice is kept meanwhile and comes back into force when it returns to a fair policy.';
    setParamWith(prio, 'policy-rt');
    // each named by the class that reads it, so the cell reads "nice 0" or "priority 80"
    const named = (text, el) => { const l = document.createElement('label'); l.append(text, el); return l; };
    const params = [named('nice', nice), named('priority', prio)];
    // scheduling class; the policies are grouped by the class that implements them, since that is
    // what decides the task's fate -- any real-time task outranks every fair one. The option values
    // stay the driver's own words.
    const pol = document.createElement('select'); pol.title = 'scheduling policy, grouped by scheduling class';
    pol.replaceChildren(...[['fair', ['normal', 'batch', 'idle']], ['real-time', ['fifo', 'rr']]].map(([label, vs]) => {
      const g = document.createElement('optgroup'); g.label = label;
      g.replaceChildren(...vs.map(v => new Option(v, v)));
      return g;
    }));
    // the class, with the parameter it reads: a real-time priority is required by the kernel, so the
    // spinner's value goes along (80 until set); a fair policy alone keeps the task's nice
    pol.onchange = () => { const v = pol.value, rt = v === 'fifo' || v === 'rr'; pol.dataset.pending = '1';
      enqueue(async () => { const r = await cmd(rt ? `policy-rt ${t.id} ${v} ${prio.value}` : `policy-fair ${t.id} ${v}`); delete pol.dataset.pending; if (r.error) pol.blur(); }); };
    tr.cells[SCHED].append(pol, ' ', ...params);   // the policy first, then the parameter it reads
    const aff = cpuMask(AFF_TITLE, (want) => `affinity ${t.id} ${want}`);
    tr.cells[AFF].append(aff);
    // pause / wake (label follows the task's state) and kill
    const pause = document.createElement('button'); pause.textContent = 'pause';
    pause.onclick = () => enqueue(() => cmd(`${pause.textContent} ${t.id}`));
    const yld = document.createElement('button'); yld.textContent = 'yield';
    yld.title = 'sched_yield(): the task gives the CPU up but stays runnable. Under rr it goes to the tail of its priority\u2019s list; under fifo the next task of the same priority runs, if any; the fair class skips it once and picks again';
    yld.onclick = () => enqueue(() => cmd(`yield ${t.id}`));
    const kill = document.createElement('button'); kill.textContent = 'kill'; kill.title = 'ask the task to exit';
    kill.onclick = () => enqueue(() => cmd(`kill ${t.id}`));
    tr.cells[ACT].append(pause, ' ', yld, ' ', kill);
  }
  const s = t.stat ?? {};
  sync(tr.cells[CG].firstElementChild, s.cgroup);
  sync(tr.cells[SCHED].children[1].lastElementChild, s.nice);
  if (s.rt_priority) sync(tr.cells[SCHED].children[2].lastElementChild, s.rt_priority);   // 0 under a fair policy: keep the last real value
  sync(tr.cells[SCHED].firstElementChild, s.policy);
  setParam(tr, s.policy);
  sync(tr.cells[AFF].firstElementChild, s.cpus);
  if (s.state !== undefined) tr.cells[ACT].firstElementChild.textContent = s.state === 'running' || s.state === 'runnable' ? 'pause' : 'wake';
  // weight is a fair-class number, read off the task's fair record; the real-time classes never have one
  [[STATE, s.state ?? ''], [CPU, s.cpu], [TIME, ms(s.sum_exec_runtime)]]
    .forEach(([i, v]) => { if (v === undefined) return; const text = String(v); if (tr.cells[i].textContent !== text) tr.cells[i].textContent = text; });
}

// ---- cgroups: the tree the kernel reports after every command (path -> {weight, cpus}, from
// kmod/shm.h), root "/" first. The workload is one table: a cgroup is a row, and its tasks and its
// child cgroups are the rows beneath it, one step further in -- nesting as an outline, with every
// column aligned down the page. The weight and cpuset controls are views of the kernel's values,
// like the task rows', so a change made behind the UI's back shows up. A cgroup's row shows only
// what the kernel holds for the cgroup itself; what the scheduler makes of it is per CPU -- one
// group entity on each CPU's queue -- and is drawn there, under Scheduler. ----
let groups = new Map();
let ngroups = 0;
async function newGroup(parent) {
  await cmd(`cgroup-create ${parent === '/' ? '' : parent}/g${++ngroups}`);
}
// The kernel refuses a cgroup that still has tasks or children, and says so in the transcript.
const delGroup = (path) => cmd(`cgroup-destroy ${path}`);
const groupPaths = () => ['/', ...[...groups.keys()].sort()];
const groupRowOf = new Map();   // path -> its row, made once and kept, like the task rows, so a value being typed is not rebuilt away


// A disabled button does not take mouse events, and with them goes its tooltip -- which is the
// one moment the explanation is wanted. The wrapper is not disabled, so it still answers a hover.
function wrapped(text, title, onclick) {
  const b = document.createElement('button'); b.textContent = text; b.title = title; b.onclick = onclick;
  const w = document.createElement('span'); w.append(b);
  return [b, w];
}

function groupRow(path) {
  const tr = $('tasks').querySelector('tbody').insertRow();
  tr.className = 'group';
  // the task columns up to affinity (a cgroup's is its cpuset), then one cell across the task's
  // cpu, cpu time and scheduling for cpu.weight, then the actions
  for (let i = 0; i <= AFF; i++) tr.insertCell();
  const weightCell = tr.insertCell(); weightCell.colSpan = ACT - AFF - 1;
  const actCell = tr.insertCell();
  const name = document.createElement('span'); name.className = 'path'; name.textContent = path;
  tr.cells[0].append(name);
  if (path !== '/') {   // the root has neither file: weight only ranks siblings, and its cpuset is fixed
    // cpu.weight as the kernel has it, 1..10000 with 100 the default, labelled so it is not read
    // in the tasks' unit next to it: the kernel maps 100 to a nice-0 task's 1024.
    const w = document.createElement('input');
    w.type = 'number'; w.min = 1; w.max = 10000;
    w.title = 'cpu.weight, against its siblings: 100 (the default) weighs as much as a nice-0 task, 1024';
    onSet(w, `cgroup-weight ${path}`);
    const label = document.createElement('span'); label.className = 'f-label'; label.textContent = 'cpu.weight ';
    tr.weight = w; weightCell.append(label, w);
    tr.cpus = cpuMask('cpuset.cpus: the CPUs its tasks may use', (want) => `cgroup-cpus ${path} ${want}`);
    tr.cells[AFF].append(tr.cpus);
  }
  // a task is born where it belongs: the button sits on the cgroup's row, the root's included
  [tr.taskBtn, tr.taskWrap] = wrapped('+ task', `create a task in ${path}`, () => enqueue(() => create(path)));
  [tr.addBtn, tr.addWrap] = wrapped('+ cgroup', `create a cgroup under ${path}`, () => enqueue(() => newGroup(path)));
  actCell.append(tr.taskWrap, ' ', tr.addWrap);
  if (path !== '/') {
    [tr.delBtn, tr.delWrap] = wrapped('\u2715', `destroy ${path} (it must have no tasks and no children)`, () => enqueue(() => delGroup(path)));
    tr.delBtn.className = 'rm';
    actCell.append(' ', tr.delWrap);
  }
  return tr;
}

function renderGroups() {
  const tb = $('tasks').querySelector('tbody');
  const paths = groupPaths();
  const live = new Set(paths);
  for (const [path, tr] of groupRowOf) if (!live.has(path)) { tr.remove(); groupRowOf.delete(path); }
  // The outline: a cgroup's row, its tasks, then each child cgroup the same way, one step in.
  const order = [];
  const walk = (path, depth) => {
    let tr = groupRowOf.get(path);
    if (!tr) { tr = groupRow(path); groupRowOf.set(path, tr); }
    tr.style.setProperty('--depth', depth);
    const members = tasks.filter((t) => t.alive && t.stat?.cgroup === path);
    const kids = paths.filter((p) => p !== '/' && parentOf(p) === path);
    const g = groups.get(path) ?? {};
    if (path !== '/') {
      sync(tr.weight, g.weight); sync(tr.cpus, g.cpus);
      // cgroup v2's no-internal-process rule: a non-root cgroup holds tasks or controlled children,
      // never both, and the driver rejects the create rather than half-making one. The root is
      // exempt, so its button never goes dead. Said on the button because the reason is the remedy.
      tr.addBtn.disabled = members.length > 0;
      tr.addWrap.title = tr.addBtn.title = members.length
        ? `move the ${plural(members.length, 'task')} out of ${path} first: a cgroup cannot hold both tasks and controlled children`
        : `create a cgroup under ${path}`;
      tr.taskBtn.disabled = kids.length > 0;
      tr.taskWrap.title = tr.taskBtn.title = kids.length
        ? `${path} has child cgroups, so it cannot hold tasks`
        : `create a task in ${path}`;
      // rmdir cannot take a directory with anything in it, so the driver refuses the same thing.
      tr.delBtn.disabled = members.length > 0 || kids.length > 0;
      tr.delWrap.title = tr.delBtn.title = tr.delBtn.disabled
        ? `empty ${path} first: a cgroup with tasks or children cannot be destroyed`
        : `destroy ${path}`;
    }
    order.push(tr);
    for (const t of members) {
      const r = rowOf.get(t.id);
      if (r) { r.style.setProperty('--depth', depth + 1); order.push(r); }
    }
    for (const k of kids) walk(k, depth + 1);
  };
  walk('/', 0);
  // Every task row's cgroup select offers the same tree. cgroup v2 keeps tasks and controlled
  // children apart, so a cgroup with children is offered greyed out with the reason, rather than
  // letting the kernel refuse afterwards. Rebuilt only when the tree changes, so an open select
  // is not pulled from under the pointer.
  const key = paths.join('\n');
  for (const t of tasks) {
    const sel = rowOf.get(t.id)?.cells[CG].firstElementChild;
    if (!sel) continue;
    if (sel.dataset.tree !== key) {
      sel.dataset.tree = key;
      sel.replaceChildren(...paths.map((p) => {
        const o = new Option(p, p);
        if (p !== '/' && paths.some((k) => parentOf(k) === p)) { o.disabled = true; o.title = `${p} has child cgroups, so it cannot hold tasks`; }
        return o;
      }));
    }
    sync(sel, t.stat?.cgroup);
  }
  // Rows into that order with the fewest moves: a moved row drops its focus, so a row already
  // in place is left alone.
  order.forEach((tr, i) => { if (tb.rows[i] !== tr) tb.insertBefore(tr, tb.rows[i] ?? null); });
}

// ---- queues: what each CPU picks between, one block per scheduling class that has something
// queued there, the real-time class above the fair one because any of its rows outranks the whole
// fair tree. The real-time block is the priority lists: rows by priority, then by place in the
// list, the head of the highest list being the pick. The fair block is a cfs_rq per (CPU,
// cgroup), indented like the cgroups because that is how the pick descends: the root queue
// chooses between its own tasks and the child cgroups' entities, and the chosen cgroup's queue
// chooses again inside it -- the root queue's rows first and a cgroup entity's row followed by
// the rows of its own queue, one level in. Tasks and group entities share the columns because
// they share the block in kmod/shm.h, and every flag shown -- eligible, curr, the next pick --
// and the share are the kernel's, read from the class's records; this code only lays them out.
// Rebuilt whole every command; nothing here is typed into. ----
let entities = [];   // the cgroups' group entities; a task's fair record is on the task itself (stat.fair)
// What the kernel's fair class has, from the region's header: before EEVDF (6.6) there is no lag,
// deadline, eligibility or pick, so those columns and figures are left out rather than shown blank.
let eevdf = true;
const queueCols = () => QUEUE_COLS.filter((c) => eevdf || c[3] !== 'eevdf');
const QUEUE_COLS = [   // lag is printed always signed, so the column holds its width
  ['weight', (e) => e.weight, 'the entity\u2019s weight against its siblings on this queue, which is the only weight the scheduler compares: a task\u2019s from its nice, a cgroup\u2019s from cpu.weight divided between the CPUs by calc_group_shares'],
  ['eligible', (e) => e.eligible ? '\u2713' : '', 'entity_eligible: lag \u2265 0, so EEVDF may pick it; an ineligible row is also greyed', 'eevdf'],
  ['lag', (e) => (e.lag < 0 ? '\u2212' : '+') + ms(Math.abs(e.lag)), 'the queue\u2019s average vruntime minus this entity\u2019s, in virtual ms: zero is fair, positive is owed time; EEVDF only picks entities with lag \u2265 0. Live while queued; the kernel\u2019s saved se->vlag, which place_entity restores, while not', 'eevdf'],
  ['vruntime', (e) => ms(e.vruntime), 'virtual ms on this queue\u2019s own clock: comparable only with the other rows of this queue'],
  ['deadline', (e) => ms(e.deadline), 'vruntime plus the slice scaled by weight: among the eligible, the earliest runs', 'eevdf'],
  ['slice left', (e) => e.curr ? ms(Math.max(0, e.deadline - e.vruntime)) : '', 'for the entity running at each level -- the task, and the cgroup entities above it, each curr on its own queue -- its deadline minus its vruntime in virtual ms: until it reaches zero it keeps the CPU (RUN_TO_PARITY), and then the eligible entity with the earliest deadline is picked', 'eevdf'],
];
const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
function queueRows(cpu, path, depth, byCpu, tb) {
  // this cgroup's queued tasks on this CPU, by number, then its children's entities queued here, by path
  const rows = [
    ...tasks.filter((t) => t.alive && t.stat?.fair?.on_rq && t.stat.cgroup === path && t.stat.cpu === cpu).map((t) => ({ task: t, e: t.stat.fair })),
    ...byCpu.filter((e) => e.on_rq && parentOf(e.cgroup) === path).sort((a, b) => a.cgroup.localeCompare(b.cgroup)).map((e) => ({ e })),
  ];
  for (const { task: t, e } of rows) {
    const tr = tb.insertRow();
    if (eevdf && !e.eligible) tr.classList.add('ineligible');
    if (e.curr) tr.classList.add('running');        // curr at this level: the running task, or the cgroup it runs under
    else if (e.pick) tr.classList.add('next');      // what pick_eevdf would take instead, where that differs
    const first = tr.insertCell(); first.style.paddingLeft = `${depth * 1.2}rem`;
    if (t) first.append(chip(t));
    else { const c = document.createElement('span'); c.className = 'path'; c.textContent = e.cgroup; first.append(c); }
    for (const [, get] of queueCols()) tr.insertCell().textContent = get(e);
    if (!t) queueRows(cpu, e.cgroup, depth + 1, byCpu, tb);   // the cgroup's own queue, indented beneath its entity
  }
}
const chip = (t) => { const c = document.createElement('span'); c.className = 'task-chip'; c.style.background = colorOf(t.id); c.textContent = t.id; return c; };
// A header's run of "label value" pairs, each with the kernel's meaning on hover.
function stats(head, pairs) {
  for (const [label, value, title] of pairs) {
    const s = document.createElement('span'); s.className = 'note'; s.title = title;
    s.append(`${label} `); const b = document.createElement('b'); b.textContent = value; s.append(b);
    head.append(' ', s);
  }
}
// One class's block inside a CPU's box: a header line naming the class -- and, smaller, which
// kernel policies it is -- with the class's numbers at the right, then its table.
function classTable(label, detail, title, cols, firstTitle) {
  const box = document.createElement('div'); box.className = 'class';
  const head = document.createElement('header'); head.className = 'row';
  const name = document.createElement('span'); name.className = 'name'; name.textContent = label; name.title = title;
  const small = document.createElement('small'); small.textContent = detail; name.append(small);
  head.append(name);
  const table = document.createElement('table');
  const th = table.createTHead().insertRow();
  for (const [name, , title] of [['task', , firstTitle], ...cols]) { const c = document.createElement('th'); c.textContent = name; c.title = title; th.append(c); }
  box.append(head, table);
  return { box, head, tb: table.createTBody() };
}
// The fair class on one CPU, shown while anything is on it. The queue's PELT averages are the
// balancer's reading and sit in its table; an empty queue has nothing else to show.
function fairTable(cpu, byCpu) {
  const { box, head, tb } = classTable('fair', eevdf ? 'EEVDF' : 'CFS',
    eevdf ? 'the fair class, kernel/sched/fair.c: EEVDF since 6.6 picks the eligible entity with the earliest deadline' : 'the fair class, kernel/sched/fair.c: CFS picks the entity with the smallest vruntime',
    queueCols(),
    'a task, in its colour, or a cgroup\u2019s entity; indented rows are the queue inside that cgroup. \u25B6 is curr at its level: the task that ran this tick and the cgroup entities it ran under; \u25B7 is what pick_eevdf would take next, where that differs');
  tb.parentElement.tHead.rows[0].cells[0].textContent = 'entity';
  queueRows(cpu, '/', 0, byCpu, tb);
  return box;
}
// The real-time class: one row per task on the CPU's rt_rq, by priority then by place in that
// priority's list. FIFO runs the head until it yields; RR moves it to the tail when its timeslice
// is spent. The header carries the bandwidth: what the class has used of its share of the period,
// and "throttled" when that share is spent and the whole class is off the CPU until the next one.
const RT_COLS = [
  ['priority', ({ t }) => t.stat.rt_priority, 'the task\u2019s real-time priority, 1..99; the highest non-empty list is the one the class runs from, so a higher row outranks every row below it'],
  ['policy', ({ t }) => t.stat.policy, 'fifo runs until it yields or blocks; rr gives way to the next task of the same priority when its timeslice is spent'],
  ['slice left', ({ t, e }) => t.stat.policy === 'rr' ? `${e.time_slice} ms` : '', 'rr only: what remains of the 100 ms timeslice (RR_TIMESLICE, in ticks); at zero the task goes to the tail of its list. fifo has none'],
];
function rtTable(rq, rows) {
  const used = `${(rq.rt_time / 1e6).toFixed(0)} of ${(rq.rt_runtime / 1e6).toFixed(0)} ms`;
  const { box, head, tb } = classTable('real-time', '', 'the real-time class, kernel/sched/rt.c: the head of the highest non-empty priority list runs, and any task here outranks every fair one', RT_COLS,
    'a task, in its colour, in the order the class runs them: by priority, then by place in the priority\u2019s list. \u25B6 ran this tick; \u25B7 is the head of the highest list, which pick_next_task_rt would take, where that differs');
  stats(head, [[rq.throttled ? 'throttled, used' : 'used', used, 'sched_rt_runtime_us of sched_rt_period_us: the real-time class gets this much of each 1 s period. rt_time is what it has used so far this period; when it reaches the runtime the class is throttled -- dequeued whole -- until the period ends, and the fair class gets the rest']]);
  if (rq.throttled) box.classList.add('throttled');
  rows.sort((a, b) => b.t.stat.rt_priority - a.t.stat.rt_priority || a.e.position - b.e.position);
  for (const row of rows) {
    const tr = tb.insertRow();
    if (row.e.curr) tr.classList.add('running');
    else if (row.e.pick) tr.classList.add('next');
    tr.insertCell().append(chip(row.t));
    for (const [, get] of RT_COLS) tr.insertCell().textContent = get(row);
  }
  return box;
}
// One box per CPU: the runqueue itself on the header line -- what runs, how much is queued, when
// the balancer next looks -- then the classes with something on it, real-time first since it
// outranks fair. The runqueue's numbers are the CPU record's; each class's are its own record's
// (kmod/shm.h keeps them apart the same way).
function cpuBox(cpu) {
  const r = cpuRecords.get(cpu);
  const box = document.createElement('div'); box.className = 'rq';
  const head = document.createElement('header');
  const name = document.createElement('span'); name.className = 'cpu'; name.textContent = `cpu ${cpu}`; head.append(name);
  box.append(head);
  if (!r) return box;
  if (r.idle) box.classList.add('idle');   // the tables below mark what runs; an idle CPU has none, and its box is drawn dashed
  const f = r.fair;
  stats(head, [['switches', r.nr_switches, 'rq->nr_switches: context switches on this CPU so far']]);
  const rt = tasks.filter((t) => t.alive && t.stat?.rt?.on_rq && t.stat.cpu === cpu).map((t) => ({ t, e: t.stat.rt }));
  if (rt.length && r.rt) box.append(rtTable(r.rt, rt));
  const byCpu = entities.filter((e) => e.cpu === cpu);
  const queued = byCpu.some((e) => e.on_rq) || tasks.some((t) => t.alive && t.stat?.fair?.on_rq && t.stat.cpu === cpu);
  if (f && queued) box.append(fairTable(cpu, byCpu));
  return box;
}
// ---- what moved: the balancer's own record of itself. A load_balance event is a CPU that ran the
// balancer at a level (should_we_balance said yes there), a migrate event a task changing CPU,
// whether the balancer pulled it or a wakeup placed it. Kept per command, newest first, and the
// last command's moves are drawn on the CPU cards as arrivals and departures. ----
const BALANCE_LOG_MAX = 5;
const balanceLog = [];      // {tick, line, balances: [{cpu, name, span}], moves: [{task, from, to}]}
let lastMoves = { pulled: new Set() };   // the CPUs that ran the balancer on the last command
function noteBalancing(line, tick, events) {
  const balances = events.filter((e) => e.type === 'load_balance').map((e) => ({ cpu: e.dst_cpu, name: e.name, span: e.span }));
  const moves = events.filter((e) => e.type === 'migrate').map((e) => ({ task: e.task, from: e.src_cpu, to: e.dst_cpu }));
  lastMoves = { pulled: new Set(balances.map((b) => b.cpu)) };
  if (!balances.length && !moves.length) return;
  balanceLog.unshift({ tick, line: line ?? 'boot', balances, moves });
  balanceLog.length = Math.min(balanceLog.length, BALANCE_LOG_MAX);
  const ol = $('balance-log');
  ol.replaceChildren(...balanceLog.map((entry) => {
    const li = document.createElement('li'); li.value = entry.tick;
    const parts = [];
    // a balance names its level and the CPU that pulled; the moves in the same command are its
    // result when the command was a tick, and a wakeup's placement otherwise
    for (const b of entry.balances) parts.push(`${LEVEL_WORD[b.name] ?? b.name} balance on cpu ${b.cpu}`);
    li.append(parts.join(', '));
    if (entry.balances.length && entry.moves.length) li.append(': ');
    else if (entry.moves.length) li.append(entry.line.startsWith('tick') ? '' : `${entry.line.split(' ')[0]}: `);
    entry.moves.forEach((m, i) => {
      if (i) li.append(', ');
      const t = tasks.find((t) => t.id === m.task);
      li.append(t ? chip(t) : `task ${m.task}`, ` cpu ${m.from} \u2192 cpu ${m.to}`);
    });
    if (entry.balances.length && !entry.moves.length) li.append(': nothing to move');
    return li;
  }));
}
const LEVEL_WORD = { SMT: 'core', CLS: 'cluster', MC: 'socket', PKG: 'socket', DIE: 'socket', NODE: 'node' };
function renderQueues() {
  $('queues').replaceChildren(...Array.from({ length: ncpus }, (_, i) => cpuBox(i + 1)));
}

// ---- transport: kstep.mjs's cmd(), one command in flight at a time, with a transcript ----
let vm = null;
const LOG_MAX = 2000;   // lines kept in the transcript
const append = (text, cls) => {
  const span = document.createElement('span'); if (cls) span.className = cls; span.textContent = text + '\n'; log.append(span);
  if (log.childElementCount > LOG_MAX) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
};
// After every command the driver has rewritten the shared region (kmod/shm.h): vm.shm() reads the
// state, and vm.events() drains the trace records the command's hooks wrote on the stream.
// A task of ours no longer listed has exited.
async function cmd(line) {
  if (line !== null) append('> ' + line);
  const reply = await vm.cmd(line);
  append(JSON.stringify(reply), reply.error ? 'err' : '');
  const st = vm.shm();
  if (eevdf !== st.eevdf) {
    eevdf = st.eevdf;
    for (const [id, f] of Object.entries(FIGURES)) if (f.eevdf) picks.get(id).parentElement.hidden = !eevdf;
    if (!eevdf) setCharts(charts.map((c) => c.id).filter((id) => !FIGURES[id].eevdf));
  }
  const events = vm.events();
  for (const e of events) append(JSON.stringify(e), 'event');   // the trace, in the log pane
  showState(st, events, line);
  return reply;
}
// The machine's state into the tables: what every command ends with, and what a test can feed
// without a VM. The region keeps each class's records in tables of their own (kmod/shm.h); the
// page joins them here, once: a CPU record carries the fair and real-time queues on it as .fair
// and .rt, a task record the class's view of the task the same way -- one of the two, by its policy.
export function showState(st, events = [], line = null) {
  noteBalancing(line, st.timestamp, events);
  const by = (rows, key) => new Map(rows.map(r => [r[key], r]));
  const cfs = by(st.cfs, 'cpu'), rtq = by(st.rt, 'cpu'), fairOf = by(st.entities.filter(e => e.task), 'task'), rtOf = by(st.rt_entities, 'task');
  cpuRecords = new Map(st.cpus.map(c => [c.cpu, { ...c, fair: cfs.get(c.cpu), rt: rtq.get(c.cpu) }]));
  // the cgroup tree is the kernel's, not the UI's: paths, weights and cpusets as they are now
  groups = new Map(st.groups.filter(g => g.path !== '/').map(g => [g.path, g]));
  entities = st.entities.filter(e => !e.task);
  taskRecords = new Map(st.tasks.map(s => [s.task, { ...s, fair: fairOf.get(s.task), rt: rtOf.get(s.task) }]));
  const live = new Set(taskRecords.keys());
  // a task the region reports that the page has not met -- one it did not create itself -- is
  // adopted: the region is the truth about which tasks exist
  for (const s of taskRecords.values()) {
    let t = tasks.find(t => t.id === s.task);
    if (!t) { t = { id: s.task, alive: true }; tasks.push(t); }
    t.stat = s; t.alive = true; renderTask(t);
  }
  for (const t of tasks) if (t.alive && !live.has(t.id)) { t.alive = false; renderTask(t); }
  domains = st.domains;
  renderGroups(); renderQueues(); renderBalancer();   // not draw(): the charts are a function of the ticks so far
}
// A step is one `tick`, and the snapshot it leaves behind is one column of every chart.
async function step() {
  if ((await cmd('tick')).error) return;
  // the whole snapshot, so any figure can be plotted over the run without replaying it
  snapshots.push({ tasks: new Map(taskRecords), cpus: new Map(cpuRecords) });
  draw();
}
// A task is created in a cgroup (the driver moves it before its first wakeup, so the scheduler
// first sees it there); the root needs no path.
async function create(path = '/') {
  const r = await cmd(path === '/' ? 'create' : `create ${path}`);
  if (!r.error) tasks.push({ id: r.task, alive: true });
}
// UI actions run one after another on a queue; buttons stay enabled, nothing is dropped.
let queue = Promise.resolve();
const enqueue = (fn) => { queue = queue.then(fn).catch(e => setStatus('error: ' + e.message, true)); return queue; };

// ---- clock: play/pause runs it, the ticks/s box paces it, and step stops it and ticks once ----
// Running is its own state rather than a 0 in the rate box, so pausing keeps the rate you picked.
let timer = 0, running = true;
function schedule() {
  clearTimeout(timer); timer = 0;
  $('play').textContent = running ? 'pause' : 'play';
  $('play').title = running ? 'stop the clock' : 'run the clock';
  const rate = +$('speed').value || 0;
  if (vm && running && rate > 0) timer = setTimeout(() => enqueue(step).then(schedule), 1000 / rate);
}
function pause() { running = false; schedule(); }
$('play').onclick = () => { running = !running; schedule(); };
$('speed').onchange = schedule;                                 // re-paces without leaving the state
$('step').onclick = () => { pause(); enqueue(step); };          // enabled while running: break in, then tick
schedule();                                                     // the button's face comes from the state, not the markup

// ---- boot ----
// The configuration lives in the URL, so it can be shared, and the VM boots as soon as the page
// loads: ?script= is the whole initial condition, driver lines separated by newlines. QEMU never exits under Emscripten, so Restart reloads
// the page with the new query, which ends the current VM and boots the next one.
// Scenarios: a machine, a number of tasks, a setup script run after boot (verbs as in the
// driver; tasks are 1, 2, .. in creation order as in the driver, * means all; `tick N`), and what to look for.
// A scenario is a script and the words to read it by. `m()` just spells a machine's two lines so
// they stay readable here; everything else is a driver line verbatim.
const m_ = (...sockets) => cpuSetup(mach(...sockets));
const SCENARIOS = {
  free: { title: 'Default', charts: ['placement'],
    script: [...m_([[core(2), core(2)]]), 'create 5'],
    text: 'Five equal tasks on two cores with two threads each. Change nice values and affinities, pause and wake tasks, and watch the scheduler react.' },
  fair: { title: 'Fair sharing', charts: ['placement', 'cputime', 'vruntime'],
    script: [...m_([[core(1)]]), 'create 3'],
    text: 'Three equal tasks on one CPU. EEVDF runs them in turn, one slice each, and the pattern repeats: cpu time and vruntime climb at the same rate for all three. Give them different nice values in the Tasks table to make it weighted \u2014 at nice -5, 0 and 5 the weights under Scheduler read 3121, 1024 and 335, so task 1 gets about three slices for each one of task 2\u2019s and task 3 about a third. cpu time then fans out three ways; vruntime does not, because it is runtime divided by weight.' },
  realtime: { title: 'Real-time tasks', charts: ['placement', 'cputime'],
    script: [...m_([[core(1)]]), 'create 3', 'policy-rt * rr 80'],
    text: 'Three equal tasks on one CPU, all SCHED_RR. Real-time tasks of the same priority take the CPU strictly in turn, one 100 ms timeslice each, so Placement is three long blocks instead of EEVDF\u2019s fine grain and cpu time climbs in long straight runs. Every second all three lines pause together: RT bandwidth control (sched_rt_runtime_us) gives the real-time class only 0.95 s of each second. Nice does nothing here \u2014 it is a fair-class idea; put one task back to normal and it gets only that leftover 0.05 s.' },
  balance: { title: 'Load balancing', charts: ['placement', 'queues'],
    script: [...m_([[core(1), core(1)]]), 'create 4', 'affinity * 1', 'tick 10', 'affinity * 1-2'],
    text: 'Four tasks start pinned to cpu1 while cpu2 sits idle. After ten ticks they are free to run on either CPU, but nothing moves straight away: cpu2 only looks for work when its balance interval comes round. In Placement all four lanes stay in cpu1’s row until the balancer wakes up and pulls two of them across. Runnable tasks shows the same moment, 4 : 0 becoming 2 : 2.' },
  groups: { title: 'Cgroup', charts: ['placement'],
    script: [...m_([[core(1)]]), 'create 4', 'cgroup-create /a', 'cgroup-create /b',
             'cgroup-attach /a 1', 'cgroup-attach /b 2', 'cgroup-attach /b 3', 'cgroup-attach /b 4'],
    text: 'One CPU, four equal tasks: task 1 alone in cgroup /a, the other three together in /b. Each cgroup owns a scheduling entity of its own, and the CPU\u2019s queue picks between those two rather than between the four tasks: /a and /b carry the same weight, so each gets half, and task 1 keeps all of /a while the other three split /b three ways. Placement shows task 1 holding the CPU half the time, and the cpu time column of the Tasks table shows the 3 : 1 : 1 : 1 that follows. Under Scheduler, CPU 1\u2019s fair queue holds just /a and /b at equal weight, and /b\u2019s own queue holds tasks 2, 3 and 4 beneath it; set /b\u2019s weight to 300 in its box under Cgroups and all four tasks become equal.' },
  little: { title: 'Big and little cores', charts: ['placement', 'util', 'queues'],
    script: [...m_([[core(1, 1024)], [core(1, 512)]]), 'create 6'],
    text: 'Six equal tasks on two CPUs, where cpu2 has half the capacity of cpu1. Wakeup placement at creation starts them 5 : 1. The balancer moves one task to the little core after a couple of hundred ticks and then stops at 4 : 2, matching the 2 : 1 capacity ratio; on two equal CPUs it would keep going to 3 : 3. Load is balanced per unit of capacity, not per task.' },
};
const params = new URLSearchParams(location.search);
// The kernel is the one page parameter that is not part of the initial condition: it is carried
// along whenever the page reloads itself into another scenario, script or view.
let kernel = params.get('kernel');
const withKernel = (p) => { if (kernel) p.set('kernel', kernel); return `${location.pathname}?${p}`; };
const scenario = SCENARIOS[params.get('scenario')] ?? (params.has('script') ? null : SCENARIOS.free);
// one tab per scenario; the running one is highlighted (none when the machine below was
// changed and restarted by hand)
for (const [k, sc] of Object.entries(SCENARIOS)) {
  const b = document.createElement('button'); b.textContent = sc.title;
  b.classList.toggle('active', SCENARIOS[k] === scenario);
  if (SCENARIOS[k] === scenario) b.setAttribute('aria-current', 'page');
  b.onclick = () => location.replace(withKernel(new URLSearchParams({ scenario: k })));
  $('scenarios').append(b);
}
$('scenario-text').textContent = scenario ? scenario.text : 'A machine of your own.';
// The initial condition is a script: driver lines, in order. It comes from the scenario, or from
// ?script=, and everything else the page used to take as its own parameter is now just a line in
// it. The machine's size is the one thing that cannot be a driver line -- it is QEMU's -smp,
// fixed before the kernel boots -- so it is read back out of the script's cpu-topo line.
const DEFAULT_SCRIPT = [...cpuSetup(one(core(2), core(2))), 'create 5'];
let script = scenario ? scenario.script
           : params.has('script') ? parseScript(params.get('script'))
           : DEFAULT_SCRIPT;
if (!script.length) script = DEFAULT_SCRIPT;
// The layout form shows the script's machine; a hand-written topology it cannot express leaves it
// read-only rather than showing something the script does not say.
const fromScript = machineFromScript(script);
const layoutCustom = !fromScript || !fromScript.exact;
const topoLine = script.find(l => l.startsWith('cpu-topo '));
const scriptCpus = topoLine ? Math.min(MAX_CPUS, cpusInTopo(topoLine.slice(9))) : 0;
// A structure the form cannot even parse still has a CPU count, so describe that rather than a
// machine the script never asked for: the summary line reads it.
machine = fromScript ?? one(...Array.from({ length: scriptCpus || 4 }, () => core()));
ncpus = scriptCpus || nCpus(machine);
setCpuDraft(machine);
if (layoutCustom) {
  $('cpu-layout').querySelectorAll('input, select, button').forEach(el => el.disabled = true);
  $('cpu-layout').querySelectorAll('input, select, button').forEach(el => el.disabled = true);
  $('cpu-hint').textContent = 'This script names a machine the form cannot state \u2014 capacity varies inside a cluster, or the clusters are uneven. It is shown above as the kernel built it; edit the script to change it.';
}
// a new cluster joins the last socket; a new socket starts one of its own
$('discard-cpus').onclick = () => setCpuDraft(machine);
// the chart stack: ?charts= wins (a shared view), then the scenario's own, then cpu time. Ids the
// catalog no longer has are dropped, so a link saved before a figure was retired still opens.
const urlCharts = (params.get('charts') ?? '').split(',').filter((id) => FIGURES[id]);
setCharts(urlCharts.length ? urlCharts : scenario?.charts ?? ['placement']);
// Restart is a reload: the URL is the whole initial condition (scenario or script, and the chart
// set), and QEMU never exits under Emscripten, so a fresh VM is a fresh page.
$('restart').onclick = () => location.reload();
$('boot').onclick = () => {
  if (!refreshLayout()) return;
  // capacity is live, so the reboot carries what the kernel has now -- not a stale form value
  const next = scriptWith(script, draft);
  location.replace(withKernel(new URLSearchParams({ script: next.join('\n') })));
};

async function boot() {
  try {
    setStatus('Downloading kernel…', false, true);
    // ?v busts the browser cache after a restage; a 404 is "not staged" (the snapshot exists for
    // the default CPU count only, and resuming it skips the ~4 s boot: other machines boot cold)
    const get = (name) => fetch(`images/${kernel}/${name}?v=${V}`).then(r => r.ok ? r.arrayBuffer() : r.status === 404 ? null : Promise.reject(new Error(`${name}: HTTP ${r.status}`)));
    // The VM is the snapshot's machine whenever the layout fits in it: the spec's CPUS keeps the
    // CPUs beyond the layout idle and out of the scheduler's domains (kmod/cpu.c), and the trace
    // is the one a machine of exactly that size gives. Larger layouts boot cold at their own size.
    const smp = ncpus <= SNAPSHOT_CPUS ? SNAPSHOT_CPUS + 1 : ncpus + 1;
    const [files, { default: Module }] = await Promise.all([image(smp, get), import(`./qemu/qemu-system-aarch64.js?v=${V}`)]);
    setStatus(files.snapshot ? 'Resuming kernel…' : 'Booting kernel…', false, true);
    const onConsole = (line) => {
      const atBottom = con.scrollHeight - con.scrollTop - con.clientHeight < 40;
      con.append(line + '\n'); if (con.childNodes.length > LOG_MAX) con.firstChild.remove();
      if (atBottom) con.scrollTop = con.scrollHeight;
      if (startup && line.trim()) { $('boot-preview').textContent = line; $('boot-preview').hidden = false; }
      if (line.includes('Kernel panic')) { setStatus('Kernel panic', true); pause(); }
    };
    // a resumed machine printed its boot log when the snapshot was taken: show that boot's
    for (const line of files.console ?? []) onConsole(line);
    if (files.snapshot) onConsole('[resumed from a snapshot of this boot, taken at the ready line]');
    vm = await runKstep(Module, { files, smp, mem: 64, locateFile: (f) => `qemu/${f}?v=${V}`, onConsole });
    await cmd(null);   // the driver's ready line
    setStatus('Running setup…', false, true);
    // The script, as driver lines, except the page's two conveniences: `tick N` advances the
    // charts so the run is drawn, and `*` stands for every task created so far. `create [N] [/path]`
    // goes through create() because the page numbers the tasks it made.
    for (const line of script) {
      const [verb, who, ...rest] = line.split(' ');
      if (verb === 'tick') { for (let i = 0; i < (+who || 1); i++) await step(); continue; }
      if (verb === 'create') { const path = [who, ...rest].find((a) => a?.startsWith('/')); for (let i = 0; i < (+who || 1); i++) await create(path); continue; }
      if (who !== '*') { const r = await cmd(line); if (r.error && MACHINE_VERBS.includes(verb)) throw new Error(`${line}: ${r.error}`); continue; }
      for (const t of tasks) await cmd(`${verb} ${t.id} ${rest.join(' ')}`.trim());
    }
    renderGroups();   // the cgroup tree (root row) once the VM is up
    draw();
    setStatus('Kernel ready');
    $('clock').hidden = false;
    schedule();          // start the clock at the speed in the box
  } catch (e) { setStatus('error: ' + e.message, true); }
}
// The page's entry point. index.html fetches data.json (the version stamp busts this module's
// cache, so it has to come first) and calls this with what it found.
// coi-serviceworker reloads the page once on the first visit to get SharedArrayBuffer; boot
// only on the isolated page. Hard reloads bypass service workers, hence the fallback message.
export function init(data) {
  V = data.version; bugs = data.bugs ?? [];
  // the kernels with a staged image; an unknown or absent ?kernel= is the default one
  const kernels = data.kernels ?? ['v6.18'];
  if (!kernels.includes(kernel)) kernel = data.kernel ?? kernels[0];
  $('kernel').replaceChildren(...kernels.map((k) => new Option(`Linux ${k.slice(1)}`, k, false, k === kernel)));
  $('kernel').onchange = () => { kernel = $('kernel').value; location.replace(withKernel(new URLSearchParams(location.search))); };
  renderBugs();
  if (V && crossOriginIsolated) boot();
  else if (V) { setStatus('Preparing browser for kernel startup…', false, true);
    setTimeout(() => setStatus('This page needs SharedArrayBuffer, which the service worker provides. Do a normal reload (hard reloads bypass it); private browsing may block it entirely.', true), 3000); }
  draw();
}
