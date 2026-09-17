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
const { runKstep } = await import(`./kstep.mjs?v=${V}`);

// ---- session state ----
const tasks = [];            // [{id, stat, alive}] in creation order; the driver names tasks 1, 2, .. by creation
let domains = [];            // the sched domains the kernel built, refreshed with every snapshot
const snapshots = [];        // per tick: {tasks: Map(id->stat), cpus: Map(cpu->stat)}; the run, and the x axis
let ncpus = 1;
let cpuRecords = new Map();
let lastShm = null;      // the last decoded shared region, filed into snapshots by step()
const ms = (ns) => ns === undefined ? '' : (ns / 1e6).toFixed(1);
// Colours are fixed per creation order, so a task keeps its colour in the charts after it exits.
const colorOf = (task) => { const i = tasks.findIndex(t => t.id === task); return i < 0 ? 'gray' : `hsl(${(i * 67) % 360}, 60%, 50%)`; };   // comma syntax: Safari's canvas parser

// ---- machine: sockets of clusters of core types (CPU 0 stays kSTEP's own) ----
// Mirrors KSTEP_SHM_CPUS, which mirrors the module's own KSTEP_NR_CPUS: the form refuses what the
// shared region could not report. The booted region says so itself in its header, so a mismatch
// here only ever costs a rejected form, never a misread.
const MAX_CPUS = 32;
// A machine is sockets of clusters of cores, and a core is its threads and what it is worth. At
// eight CPUs there is no reason to compress equal cores into a count: listing them is simpler, and
// it lets the picture below be the form, with a core as a thing you click rather than a number you
// type. Nesting is the grouping, so there is nothing to number and no way to name a cluster that
// is not there: levels nest by construction and the kernel's domain builder cannot be handed a
// shape it would choke on. Capacity sits on the core because that is the thing that has one --
// which is what lets big and little cores share a cluster, as an arm64 DSU does. It is what the
// hardware is, so it is sent once at boot; changing it under a running kernel would reinterpret
// PELT signals gathered at the old capacity.
// kSTEP's spec is LEVEL=group|group;... with every online CPU in exactly one group per level:
// threads of a core form an SMT group, cores of a cluster a CLS group, and a socket is both the
// MC (shared last-level cache) and the PKG group. CPUs are numbered 1.. across the tree in order.
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
const groupSpec = (m, id) => { const g = new Map(); for (let c = 1; c <= nCpus(m); c++) { const k = id(m, c); if (!g.has(k)) g.set(k, []); g.get(k).push(c); } return ['0', ...[...g.values()].map(l => l.join(','))].join('|'); };
const TOPO_LEVELS = ['SMT', 'CLS', 'MC', 'PKG'];   // the levels topoSpec names, in order
const topoSpec = (m) => `SMT=${groupSpec(m, coreOf)};CLS=${groupSpec(m, clusterOf)};MC=${groupSpec(m, socketOf)};PKG=${groupSpec(m, socketOf)}`;
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
// One catalog entry per signal worth watching *change*, and the toggles above the charts
// are built from it: adding or dropping a signal is a line here, and the drawing code never has
// to know. Deliberately a subset of what the tables show -- a constant is a table cell, not a
// line, so slice and capacity are left out (neither moves within a session; capacity is set at
// boot and changing it reboots), and so are nice and weight -- two units for one number, which
// only ever steps when you set it yourself, and which the Tasks table already shows.
// Because snapshots holds whole records, switching metric re-plots the run already recorded
// instead of needing it replayed. `domain` picks the series (a line per task, or per CPU), `get`
// pulls the number out of that record. How it is read is the figure's choice, not the metric's:
//   value  the number as it stands          (utilization, nr_running, which CPU)
//   since  its growth since the window’s left edge, for counters that only ever climb
//          (CPU time, vruntime, context switches) — slope is then the rate
const NS = (v) => v / 1e6;
const METRICS = {
  runtime:   { label: 'CPU time',          domain: 'task', get: (r) => NS(r.sum_exec_runtime), unit: 'ms' },
  vruntime:  { label: 'Virtual runtime',   domain: 'task', get: (r) => NS(r.vruntime),         unit: 'ms' },
  deadline:  { label: 'Deadline',          domain: 'task', get: (r) => NS(r.deadline),         unit: 'ms' },
  taskcpu:   { label: 'CPU it is on',      domain: 'task', get: (r) => r.cpu,                  unit: '' },
  util:      { label: 'Fair utilization',  domain: 'cpu',  get: (r) => r.cfs_util_avg,         unit: '' },
  load:      { label: 'Fair load avg',     domain: 'cpu',  get: (r) => r.cfs_load_avg,         unit: '' },
  nrrunning: { label: 'Runnable tasks',    domain: 'cpu',  get: (r) => r.nr_running,           unit: '' },
};
const CHART_H = 116;
const STEPPED = uPlot.paths.stepped({ align: 1 });   // hold the value, then jump: for identities and counts
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
const seriesOf = (m) => m.domain === 'task'
  ? tasks.map(t => [t.id, String(t.id), colorOf(t.id)])
  : Array.from({ length: ncpus }, (_, i) => [i + 1, `cpu${i + 1}`, `hsl(${(i * 97) % 360}, 45%, 45%)`]);
// The metric for one series at one tick, read according to `mode`; undefined where there is no record
function sample(m, mode, key, tick, first) {
  const field = m.domain === 'task' ? 'tasks' : 'cpus';
  const v = (t) => { const r = snapshots[t]?.[field].get(key); return r === undefined ? undefined : m.get(r); };
  const now = v(tick);
  if (now === undefined) return undefined;
  if (mode === 'value') return now;
  return now - (v(first) ?? now);   // since: growth across the window
}

// ---- figures: the charts worth drawing, each a metric read one way ----
// A curated list, not the cross-product of every metric and every way of reading one: only a
// handful of those combinations answer a question anyone asks, so those get a title and an
// explanation and the rest are not offered. Adding a figure is an entry here, and nothing else.
const FIGURES = {
  placement: { title: 'Placement', metric: 'taskcpu', mode: 'value', integer: true, invert: true, step: true, lanes: true,
    note: 'each CPU\u2019s row shared out among the tasks on it at that tick, in their own colours: solid is the one that ran, faint the ones queued behind it' },
  cputime:   { title: 'CPU time', metric: 'runtime', mode: 'since',
    note: 'slope is that task’s share of the machine: parallel lines are an even split, a fan is a weighted one, a flat line is a task getting nothing' },
  vruntime:  { title: 'Virtual runtime', metric: 'vruntime', mode: 'since',
    note: 'runtime divided by weight, so under a fair split every task’s line climbs at the same rate whatever its nice' },
  deadline:  { title: 'Deadline', metric: 'deadline', mode: 'value',
    note: 'EEVDF runs the eligible task with the earliest deadline, so the lowest line is the one that should be running' },
  queues:    { title: 'Runnable tasks', metric: 'nrrunning', mode: 'value', integer: true,
    note: 'the balancer’s own view: it moves work to even these out, per unit of capacity rather than per task' },
  util:      { title: 'Fair utilization', metric: 'util', mode: 'value',
    note: 'PELT, where 1024 is a full CPU; it is frequency-invariant, so it says what the work would need at full speed' },
  load:      { title: 'Fair load', metric: 'load', mode: 'value',
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
           const base = fig.mode === 'value' ? lo : Math.min(0, lo);
           return hi === base ? [base, base + 1] : uPlot.rangeNum(base, hi, 0.1, true);
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
    ({ label, stroke: color, width: 1.5, spanGaps: false, ...(fig.step ? { paths: STEPPED } : {}),
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
  const m = METRICS[ch.fig.metric], series = seriesOf(m);
  const xs = [], ys = series.map(() => []);
  // A lanes figure also records whether the task was actually on the CPU at that tick or only
  // queued there, which is the difference between the solid blocks and the faint ones.
  const ran = ch.fig.lanes ? series.map(() => []) : null;
  for (let c = first; c < last; c++) {
    xs.push(c);
    series.forEach(([key], i) => {
      const v = sample(m, ch.fig.mode, key, c, first);
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
      if (METRICS[f.metric].domain !== domain) continue;
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
  h.append(boxName('core'));
  if (!lastCore) h.append(binBtn('Remove this core', () => { draft.sockets[si][ci].splice(oi, 1); renderLayout(); }));
  el.append(h);
  // Two numbers rather than a chip per thread. "cpu capacity" is the kernel's own term
  // (arch_scale_cpu_capacity) and says which it is: per CPU, not the core's total, so each of a
  // core's threads gets this value -- which is what cpu-cap takes. Edits go through
  // refreshLayout, not renderLayout, so a box is not rebuilt under the cursor mid-type.
  const field = (label, opts, get, set) => {
    const row = document.createElement('div'); row.className = 'caprow';
    const lbl = document.createElement('span'); lbl.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'capnum';
    Object.assign(inp, opts);
    inp.value = get();
    inp.setAttribute('aria-label', `${label} of the core on cpu${coreCpus(draft, si, ci, oi)[0] ?? '?'}`);
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
    el.append(row);
  };
  field('threads', { min: 1, max: MAX_CPUS, step: 1 }, () => c.threads, (v) => { c.threads = v; });
  field('cpu capacity', { min: 1, max: 1024, step: 128 }, () => c.cap ?? 1024, (v) => { c.cap = v; });
  // which CPUs these threads will be: what ties this box to the CPUs table and to a cpulist
  const cpus = document.createElement('div');
  cpus.className = 'corecpus'; cpus.dataset.si = si; cpus.dataset.ci = ci; cpus.dataset.oi = oi;
  el.append(cpus);
  return el;
}

// What the draft implies, and whether it can boot at all.
function refreshLayout() {
  draft.ids = null;   // the counts changed, so the cached CPU map is stale
  const count = nCpus(draft);
  for (const el of $('cpu-layout').querySelectorAll('.corecpus')) {
    const list = coreCpus(draft, +el.dataset.si, +el.dataset.ci, +el.dataset.oi);
    el.textContent = list.length ? `cpu ${list.length > 1 ? `${list[0]}-${list.at(-1)}` : list[0]}` : '';
  }
  const badCap = allCores(draft).some(c => !(c.cap >= 1 && c.cap <= 1024));
  const badThreads = allCores(draft).some(c => !(c.threads >= 1));
  const error = badThreads ? 'A core needs at least one thread.'
              : badCap ? 'A core\u2019s capacity is 1 to 1024, where 1024 is a full CPU.'
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
// Capacity and frequency are the two per-CPU scales, and both are live commands that rebuild what
// they need to, so they are controls here rather than in the machine form: capacity is what the
// hardware is (and rebuilds the sched domains, so the table below reacts), frequency is what
// cpufreq does to it while the machine runs. Each driver line carries the whole set, because the
// kmod's spec is full state and not a delta -- an unnamed CPU goes back to 1024.
const SCALES = [1024, 768, 512, 256, 128];
const CAP = 1, FREQ = 2;   // capacity is shown; frequency is the one that can be changed here
const cellSelect = (cpu, col) => $('cpu-stats').tBodies[0].rows[cpu - 1]?.cells[col].firstChild;
const scaleSpec = (col) => Array.from({ length: ncpus }, (_, i) => `${i + 1}=${cellSelect(i + 1, col)?.value ?? 1024}`).join();
function scaleSelect(cpu, col) {
  const verb = 'cpu-freq';
  const el = document.createElement('select');
  el.title = `Frequency of cpu${cpu}`; el.setAttribute('aria-label', el.title);
  el.append(...SCALES.map(v => new Option(v, v)));
  el.value = 1024;
  el.onchange = () => {
    el.dataset.pending = '1';
    enqueue(async () => {
      const r = await cmd(`${verb} ${scaleSpec(col)}`);
      delete el.dataset.pending;
      if (r.error) el.blur();   // sync() leaves a focused control alone, and the refresh puts the kernel's value back
    });
  };
  return el;
}
// The kernel's value, which a scenario's driver line can set to any scale in 1..1024: show one the
// list does not have rather than leaving the control blank.
function scaleSync(el, v) {
  if (v !== undefined && !SCALES.includes(v) && !Array.from(el.options).some(o => +o.value === v))
    el.add(new Option(v, v), Array.from(el.options).findIndex(o => +o.value < v));
  sync(el, v);
}
function renderCpus() {
  const cores = allCores(machine).length;
  const clusters = machine.sockets.reduce((n, cl) => n + cl.length, 0);
  const sockets = machine.sockets.length;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  $('running-cpus').textContent = `· ${plural(ncpus, 'CPU')} · ${plural(cores, 'core')}`
    + (clusters > 1 ? ` · ${plural(clusters, 'cluster')}` : '')
    + (sockets > 1 ? ` · ${plural(sockets, 'socket')}` : '');
  for (let cpu = 1; cpu <= ncpus; cpu++) {
    const r = cpuRecords.get(cpu);
    const tb = $('cpu-stats').tBodies[0];
    let tr = tb.rows[cpu - 1];
    if (!tr) {
      tr = tb.insertRow();
      for (let i = 0; i < 10; i++) tr.insertCell();
      tr.cells[0].textContent = `cpu${cpu}`;
      tr.cells[FREQ].append(scaleSelect(cpu, FREQ));
    }
    tr.cells[CAP].textContent = r?.capacity ?? '—';
    scaleSync(tr.cells[FREQ].firstChild, r?.freq);   // the kernel's value, so a driver line shows up
    const values = [
      !r ? '—' : r.idle ? 'idle' : r.current ? r.current : 'system task', r?.nr_running ?? '—', r?.cfs_util_avg ?? '—',
      r?.cfs_load_avg ?? '—', r?.cfs_runnable_avg ?? '—', r?.min_vruntime === undefined ? '—' : ms(r.min_vruntime), r?.nr_switches ?? '—'];
    values.forEach((v, i) => tr.cells[i + FREQ + 1].textContent = v);
  }
}
// ---- sched domains: the hierarchy the kernel built, which is not always the one asked for ----
// Every CPU in a domain's span has its own copy of it, and they agree on everything the structure
// is made of -- span, groups, flags, the balancing knobs -- differing only in the order sd->groups
// starts at (its own group) and in nr_balance_failed. So the table is one row per distinct
// (level, span) rather than per CPU, with the groups listed lowest CPU first to be stable.
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
function renderDomains() {
  const tb = $('domain-table').tBodies[0];
  // Records arrive grouped by CPU, innermost first, so a CPU's running count is the level's depth;
  // rows are then ordered innermost level first, and by span within a level.
  const seen = new Map();   // "LEVEL span" -> the first CPU's copy, which is the whole structure
  const depth = new Map();
  for (const d of domains) {
    const n = (depth.get(d.cpu) ?? -1) + 1, key = `${d.name} ${d.span}`;
    depth.set(d.cpu, n);
    // the structure is shared, but each CPU balances on its own schedule: keep them all
    if (!seen.has(key)) seen.set(key, { ...d, depth: n, per: [] });
    seen.get(key).per.push(d);
  }
  const rows = [...seen.values()].sort((a, b) => a.depth - b.depth || lowestCpu(a.span) - lowestCpu(b.span));
  tb.replaceChildren();
  for (const d of rows) {
    const tr = tb.insertRow();
    tr.insertCell().innerHTML = `<span class="lvl">${d.name}</span>`;
    tr.insertCell().innerHTML = `<span class="span">${cpulist(d.span)}</span>`;
    const gs = tr.insertCell();
    for (const g of [...d.groups].sort((a, b) => lowestCpu(a.span) - lowestCpu(b.span))) {
      const el = document.createElement('span'); el.className = 'sg';
      // min/max only when the group is not uniform: that asymmetry is what misfit looks at
      const range = g.min_capacity === g.max_capacity ? '' : ` (${g.min_capacity}–${g.max_capacity})`;
      el.innerHTML = `<b>${cpulist(g.span)}</b> <i>${g.capacity}${range}</i>`;
      el.title = `Group of ${g.weight} CPU${g.weight === 1 ? '' : 's'}: total capacity ${g.capacity}, per-CPU ${g.min_capacity}–${g.max_capacity}`;
      gs.append(el);
    }
    const fl = tr.insertCell();
    for (const f of d.flags ? d.flags.split(', ') : []) {
      const el = document.createElement('span');
      el.className = f.startsWith('ASYM') ? 'flag asym' : 'flag';   // asymmetry is the one worth spotting
      el.textContent = f; fl.append(el);
    }
    const iv = tr.insertCell(); iv.className = 'num'; iv.textContent = d.balance_interval;
    iv.title = `imbalance_pct ${d.imbalance_pct}, busy_factor ${d.busy_factor}, cache_nice_tries ${d.cache_nice_tries}`;
    // per-CPU counters: the most recent balance, and the worst failure streak, across the span
    const each = (f) => d.per.map(p => `cpu${p.cpu}: ${f(p)}`).join('\n');
    const ago = tr.insertCell(); ago.className = 'num';
    ago.textContent = `${Math.min(...d.per.map(p => p.last_balance_ago))} ago`;
    ago.title = each(p => `${p.last_balance_ago} ticks ago`);
    const failed = Math.max(...d.per.map(p => p.nr_balance_failed));
    const fc = tr.insertCell(); fc.className = 'num';
    fc.textContent = failed || '—';
    // the threshold the kernel escalates at, so a row on the edge of active balancing stands out
    if (failed > d.cache_nice_tries + 2) fc.classList.add('hot');
    fc.title = each(p => p.nr_balance_failed) + `\nactive balancing past ${d.cache_nice_tries + 2}`;
  }
  // The levels asked for that the kernel collapsed away: the page knows what it sent.
  const built = new Set(rows.map(d => d.name));
  const gone = TOPO_LEVELS.filter(l => !built.has(l));
  $('domains-collapsed').textContent = !domains.length ? ''
    : gone.length ? `Collapsed as redundant: ${gone.join(', ')}.` : '';
}

// The machine reaches the kernel as cli commands, sent once the driver is ready: capacity
// first (what the hardware is), then the topology that rebuilds the sched domains.
function cpuSetup(m) {
  const caps = [];
  capsOf(m).forEach((cap, i) => { if (cap !== 1024) caps.push(`${i + 1}=${cap}`); });
  return [caps.length ? `cpu-cap ${caps.join(',')}` : null, `cpu-topo ${topoSpec(m)}`].filter(Boolean);
}

// ---- the script: one uniform way to state an initial condition ----
// Everything the page sets up is driver lines, in order, exactly as you could type them: the
// machine, the tasks, and whatever is done to them. Two page-side conveniences, because the
// driver has no notion of either: `tick N` steps N times, and `*` in a task
// position means every task created so far.
const MACHINE_VERBS = ['cpu-cap', 'cpu-topo'];
const parseScript = (text) => text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
// Every CPU the spec names; the machine's size is the highest of them, since cpu0 is the driver's.
function cpusInTopo(spec) {
  let max = 0;
  for (const n of spec.matchAll(/\d+/g)) max = Math.max(max, +n[0]);
  return max;
}
// The machine a script asks for, read back out of its cpu-topo and cpu-cap lines so the form can
// show it. Rather than checking the shape field by field, the parse is confirmed by regenerating
// the spec from it: if that matches the script's, the form states exactly this machine. If it does
// not, the structure is still reported -- the CPU count and grouping are what they are -- with
// `exact` false, and the caller shows the machine but refuses to edit it.
function machineFromScript(script) {
  const topo = script.find(l => l.startsWith('cpu-topo '))?.slice(9);
  if (!topo) return null;
  const level = (name) => topo.split(';').find(l => l.startsWith(name + '='))?.slice(name.length + 1);
  const parse = (spec) => (spec ?? '').split('|').map(g => g.split(',').flatMap(r => {
    const [a, b] = r.split('-').map(Number);
    return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
  })).filter(g => g.length && g[0] !== 0);
  const smt = parse(level('SMT')), cls = parse(level('CLS')), mc = parse(level('MC'));
  const capSpec = script.find(l => l.startsWith('cpu-cap '))?.slice(8) ?? '';
  const caps = new Map();
  for (const pair of capSpec.split(',').filter(Boolean)) {
    const [cpu, v] = pair.split('=').map(Number);
    caps.set(cpu, v);
  }
  const n = cpusInTopo(topo);
  if (!n || !cls.length) return null;
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
  // the parse is right exactly when it reproduces what the script said
  const capLine = capsOf(m).map((c, i) => c !== 1024 ? `${i + 1}=${c}` : null).filter(Boolean).join(',');
  m.exact = topoSpec(m) === topo && capLine === capSpec;
  return m;
}

// The script with its machine lines replaced by the ones this machine implies, so editing the
// layout form edits the script rather than living beside it.
const scriptWith = (script, m) => [...cpuSetup(m), ...script.filter(l => !MACHINE_VERBS.includes(l.split(' ')[0]))];

// ---- task table: rows are created once and updated in place (no rebuild, no flicker) ----
const rowOf = new Map();
const AFF = 4, NICE = 5, POL = 6, GRP = 11, ACT = 12;   // columns holding controls
const AFF_TITLE = 'CPUs the task may run on';
// A row's controls are inputs and views at once: the user types into them, but the same
// settings get changed behind their back -- a scenario's setup script sends driver lines
// directly, and a cgroup's cpuset narrows a task's CPUs -- so the kernel's value has to be
// able to flow back in. Skip a control the user is in the middle of: focused, or with an edit
// still in flight. A rejected edit is dropped: the next snapshot puts the kernel's value back.
const sync = (el, v) => {
  if (v === undefined || el.contains(document.activeElement) || el.dataset.pending) return;
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
// One task's row, created on first sight and updated in place. Per task rather than per
// table, so a record can be shown the moment it arrives.
function renderTask(t) {
  const tb = $('tasks').querySelector('tbody');
  let tr = rowOf.get(t.id);
  if (!t.alive) { if (tr) { tr.remove(); rowOf.delete(t.id); } return; }
  if (!tr) {
    tr = tb.insertRow(); rowOf.set(t.id, tr);
    for (let i = 0; i < 13; i++) tr.insertCell();   // one per <th>, the slice column having gone
    tr.cells[ACT].style.whiteSpace = 'nowrap';
    tr.cells[0].style.background = colorOf(t.id); tr.cells[0].style.width = '.8rem';
    const nice = document.createElement('input'); nice.type = 'number'; nice.min = -20; nice.max = 19; nice.value = 0; nice.style.width = '2.9rem';
    onSet(nice, `nice ${t.id}`);
    tr.cells[NICE].append(nice);
    // scheduling class; real-time ones run at one fixed priority in the driver
    const pol = document.createElement('select'); pol.title = 'scheduling class';
    pol.replaceChildren(...['normal', 'batch', 'idle', 'fifo', 'rr'].map(v => new Option(v, v)));
    onSet(pol, `policy ${t.id}`);
    tr.cells[POL].append(pol);
    const aff = cpuMask(AFF_TITLE, (want) => `affinity ${t.id} ${want}`);
    tr.cells[AFF].append(aff);
    // cgroup: a select over the root and the cgroups created so far
    const grp = document.createElement('select'); grp.title = 'cgroup of the task';
    onSet(grp, 'cgroup-attach', ` ${t.id}`);
    tr.cells[GRP].append(grp);
    // pause / wake (label follows the task's state) and kill
    const pause = document.createElement('button'); pause.textContent = 'pause';
    pause.onclick = () => enqueue(() => cmd(`${pause.textContent} ${t.id}`));
    const kill = document.createElement('button'); kill.textContent = 'kill'; kill.title = 'ask the task to exit';
    kill.onclick = () => enqueue(() => cmd(`kill ${t.id}`));
    tr.cells[ACT].append(pause, ' ', kill);
  }
  const s = t.stat ?? {};
  sync(tr.cells[NICE].firstElementChild, s.nice);
  sync(tr.cells[POL].firstElementChild, s.policy);
  sync(tr.cells[AFF].firstElementChild, s.cpus);
  // the cgroup select offers the root and every cgroup the kernel reports; rebuilding its options
  // clears the selection, so set it from the kernel afterwards
  const grp = tr.cells[GRP].firstElementChild, want = groupPaths();
  if ([...grp.options].map(o => o.value).join() !== want.join())
    grp.replaceChildren(...want.map(g => new Option(g, g)));
  sync(grp, s.cgroup);
  if (s.state !== undefined) tr.cells[ACT].firstElementChild.textContent = s.state === 'running' || s.state === 'runnable' ? 'pause' : 'wake';
  [t.id, s.state ?? '', s.cpu, undefined, undefined, undefined, s.weight, ms(s.sum_exec_runtime), ms(s.vruntime), ms(s.deadline)]
    .forEach((v, i) => { if (v === undefined) return; const text = String(v); if (tr.cells[i + 1].textContent !== text) tr.cells[i + 1].textContent = text; });
}

// ---- cgroups: the tree the kernel reports after every command (path -> {weight, cpus}, from
// kmod/shm.h), root "/" first. Rows are indented by depth and carry "add child" and, below the
// root, "delete"; the weight and cpuset controls are views of the kernel's values, like the task
// table's, so a change made behind the UI's back shows up. ----
let groups = new Map();
let ngroups = 0;
async function newGroup(parent) {
  await cmd(`cgroup-create ${parent === '/' ? '' : parent}/g${++ngroups}`);
}
// The kernel refuses a cgroup that still has tasks or children, and says so in the transcript.
const delGroup = (path) => cmd(`cgroup-destroy ${path}`);
const groupPaths = () => ['/', ...[...groups.keys()].sort()];
function renderGroups() {
  const tb = $('groups').querySelector('tbody');
  for (const path of groupPaths()) {
    const g = groups.get(path) ?? {};
    let tr = [...tb.rows].find(r => r.dataset.path === path);
    if (!tr) {
      tr = tb.insertRow([...tb.rows].filter(r => r.dataset.path < path).length); tr.dataset.path = path;
      for (let i = 0; i < 5; i++) tr.insertCell();
      const depth = path === '/' ? 0 : path.split('/').length - 1;
      tr.cells[0].textContent = path; tr.cells[0].style.paddingLeft = `${0.5 + depth}rem`;
      if (path !== '/') {
        const w = document.createElement('input'); w.type = 'number'; w.min = 1; w.max = 10000; w.style.width = '4rem';
        onSet(w, `cgroup-weight ${path}`);
        tr.cells[1].append(w);
        tr.cells[2].append(cpuMask('cpuset.cpus', (want) => `cgroup-cpus ${path} ${want}`));
      }
      const child = document.createElement('button'); child.textContent = 'add child'; child.title = `create a cgroup under ${path}`;
      child.onclick = () => enqueue(() => newGroup(path));
      tr.cells[4].append(child);
      if (path !== '/') {
        const del = document.createElement('button'); del.textContent = 'delete'; del.title = `destroy ${path} (it must have no tasks and no children)`;
        del.onclick = () => enqueue(() => delGroup(path));
        tr.cells[4].append(' ', del);
      }
    }
    if (path !== '/') { sync(tr.cells[1].firstElementChild, g.weight); sync(tr.cells[2].firstElementChild, g.cpus); }
    const members = tasks.filter(t => t.alive && t.stat?.cgroup === path).map(t => t.id).join(', ');
    if (tr.cells[3].textContent !== members) tr.cells[3].textContent = members;
  }
  const live = new Set(groupPaths());
  for (const tr of [...tb.rows]) if (!live.has(tr.dataset.path)) tr.remove();
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
  const st = lastShm = vm.shm();
  for (const e of vm.events()) append(JSON.stringify(e), 'event');   // the trace, in the log pane
  cpuRecords = new Map(st.cpus.map(c => [c.cpu, c]));
  // the cgroup tree is the kernel's, not the UI's: paths, weights and cpusets as they are now
  groups = new Map(st.groups.filter(g => g.path !== '/').map(g => [g.path, { weight: g.weight, cpus: g.cpus }]));
  const live = new Set(st.tasks.map(s => s.task));
  for (const s of st.tasks) { const t = tasks.find(t => t.id === s.task); if (t) { t.stat = s; t.alive = true; renderTask(t); } }
  for (const t of tasks) if (t.alive && !live.has(t.id)) { t.alive = false; renderTask(t); }
  domains = st.domains;
  renderGroups(); renderCpus(); renderDomains();   // not draw(): the charts are a function of the ticks so far
  return reply;
}
// A step is one `tick`, and the snapshot it leaves behind is one column of every chart.
async function step() {
  if ((await cmd('tick')).error) return;
  // the whole snapshot, so any figure can be plotted over the run without replaying it
  snapshots.push({ tasks: new Map((lastShm?.tasks ?? []).map(t => [t.task, t])), cpus: new Map(cpuRecords) });
  draw();
}
async function create() {
  const r = await cmd('create');
  if (!r.error) tasks.push({ id: r.task, alive: true });
}
// UI actions run one after another on a queue; buttons stay enabled, nothing is dropped.
let queue = Promise.resolve();
const enqueue = (fn) => { queue = queue.then(fn).catch(e => setStatus('error: ' + e.message, true)); return queue; };

// ---- clock: the ticks/s box drives it; 0 stops it, the step button stops it and ticks once ----
let timer = 0;
function schedule() {
  clearTimeout(timer); timer = 0;
  const rate = +$('speed').value || 0;
  if (vm && rate > 0) timer = setTimeout(() => enqueue(step).then(schedule), 1000 / rate);
}
$('speed').onchange = schedule;
$('step').onclick = () => { $('speed').value = 0; schedule(); enqueue(step); };
$('create').onclick = () => enqueue(create);

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
  free: { title: 'Default', charts: ['placement', 'cputime'],
    script: [...m_([[core(2), core(2)]]), 'create 5'],
    text: 'Five equal tasks on two cores with two threads each. Change nice values and affinities, pause and wake tasks, and watch the scheduler react.' },
  rr: { title: 'Round robin', charts: ['placement', 'cputime'],
    script: [...m_([[core(1)]]), 'create 3'],
    text: 'Three equal tasks on one CPU. EEVDF runs them in turn, one slice each, and the pattern repeats; runtime and vruntime grow at the same rate for all three.' },
  nice: { title: 'Weighted round robin', charts: ['placement', 'cputime', 'vruntime'],
    script: [...m_([[core(1)]]), 'create 3', 'nice 1 -5', 'nice 3 5'],
    text: 'One CPU, three tasks at nice -5, 0 and 5 (weights 3121, 1024, 335). CPU time is shared by weight: task 1 (nice -5) gets about three slices for each one of task 2\u2019s, task 3 (nice 5) about a third. Compare the runtime column; vruntime still advances evenly, because it is runtime divided by weight.' },
  two: { title: 'Two CPUs', charts: ['placement', 'queues'],
    script: [...m_([[core(1), core(1)]]), 'create 6'],
    text: 'Six equal tasks on two equal CPUs. Wakeup placement at creation leaves five on cpu1 and one on cpu2. The periodic balancer then moves one task at a time, roughly every 140 ticks, until the split is 3 : 3. Balancing is slow and stepwise, not instant; compare Big and little cores, where it stops earlier on purpose.' },
  balance: { title: 'Load balancing', charts: ['placement', 'queues'],
    script: [...m_([[core(1), core(1)]]), 'create 4', 'affinity * 1', 'tick 10', 'affinity * 1-2'],
    text: 'Four tasks start pinned to cpu1 while cpu2 idles; after ten ticks they may run on either CPU. cpu2\u2019s balancer (dashed marks) looks for work at each balance interval and after a while pulls two tasks over in one go (bars at the start of their slices). Nothing moves immediately: balancing is periodic, not instant.' },
  groups: { title: 'Cgroup fairness', charts: ['placement', 'cputime'],
    script: [...m_([[core(1)]]), 'create 4', 'cgroup-create /a', 'cgroup-create /b',
             'cgroup-attach /a 1', 'cgroup-attach /b 2', 'cgroup-attach /b 3', 'cgroup-attach /b 4'],
    text: 'One CPU, four equal tasks: task 1 alone in cgroup /a, the other three together in /b. Fairness is applied between cgroups first, then within: task 1 gets half the CPU, the three others a sixth each. Set /b\u2019s weight to 300 in the Cgroups table and all four become equal.' },
  little: { title: 'Big and little cores', charts: ['placement', 'util', 'queues'],
    script: [...m_([[core(1, 1024)], [core(1, 512)]]), 'create 6'],
    text: 'The same six tasks, but cpu2 has half the capacity of cpu1. Placement again starts at 5 : 1. The balancer moves one task to the little core after a couple of hundred ticks and then stops at 4 : 2, matching the 2 : 1 capacity ratio; on equal CPUs (Two CPUs) it would continue to 3 : 3. Load is balanced per unit of capacity, not per task.' },
};
const params = new URLSearchParams(location.search);
const scenario = SCENARIOS[params.get('scenario')] ?? (params.has('script') ? null : SCENARIOS.free);
// one tab per scenario; the running one is highlighted (none when the machine below was
// changed and restarted by hand)
for (const [k, sc] of Object.entries(SCENARIOS)) {
  const b = document.createElement('button'); b.textContent = sc.title;
  b.classList.toggle('active', SCENARIOS[k] === scenario);
  if (SCENARIOS[k] === scenario) b.setAttribute('aria-current', 'page');
  b.onclick = () => location.replace(`${location.pathname}?scenario=${k}`);
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
if (location.hash === '#cpu-editor') $('cpu-editor').open = true;
// the chart stack: ?charts= wins (a shared view), then the scenario's own, then CPU time. Ids the
// catalog no longer has are dropped, so a link saved before a figure was retired still opens.
const urlCharts = (params.get('charts') ?? '').split(',').filter((id) => FIGURES[id]);
setCharts(urlCharts.length ? urlCharts : scenario?.charts ?? ['placement']);
renderCpus();
$('boot').onclick = () => {
  if (!refreshLayout()) return;
  // capacity is live, so the reboot carries what the kernel has now -- not a stale form value
  const next = scriptWith(script, draft);
  location.replace(`${location.pathname}?script=${encodeURIComponent(next.join('\n'))}`);
};

async function boot() {
  try {
    setStatus('Downloading kernel…', false, true);
    const get = (u) => fetch(u).then(r => { if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.arrayBuffer(); });
    const [kernel, rootfs, { default: Module }] = await Promise.all([
      get(`images/cli/kernel?v=${V}`), get(`images/cli/rootfs.cpio?v=${V}`),   // ?v busts the browser cache after a restage
      import(`./qemu/qemu-system-aarch64.js?v=${V}`),
    ]);
    setStatus('Booting kernel…', false, true);
    vm = await runKstep(Module, {
      files: { kernel, rootfs },
      smp: ncpus + 1, mem: 64,
      locateFile: (f) => `qemu/${f}?v=${V}`,
      onConsole: (line) => {
        const atBottom = con.scrollHeight - con.scrollTop - con.clientHeight < 40;
        con.append(line + '\n'); if (atBottom) con.scrollTop = con.scrollHeight;
        if (startup && line.trim()) { $('boot-preview').textContent = line; $('boot-preview').hidden = false; }
        if (line.includes('Kernel panic')) { setStatus('Kernel panic', true); $('speed').value = 0; schedule(); }
      },
    });
    await cmd(null);   // the driver's ready line
    setStatus('Running setup…', false, true);
    // The script, as driver lines, except the page's two conveniences: `tick N` advances the
    // charts so the run is drawn, and `*` stands for every task created so far. `create N` goes
    // through create() because the page numbers the tasks it made.
    for (const line of script) {
      const [verb, who, ...rest] = line.split(' ');
      if (verb === 'tick') { for (let i = 0; i < (+who || 1); i++) await step(); continue; }
      if (verb === 'create') { for (let i = 0; i < (+who || 1); i++) await create(); continue; }
      if (who !== '*') { const r = await cmd(line); if (r.error && MACHINE_VERBS.includes(verb)) throw new Error(`${line}: ${r.error}`); continue; }
      for (const t of tasks) await cmd(`${verb} ${t.id} ${rest.join(' ')}`.trim());
    }
    renderGroups();   // the cgroup tree (root row) once the VM is up
    draw();
    setStatus('Kernel ready');
    $('clock').hidden = false; $('create').hidden = false;
    schedule();          // start the clock at the speed in the box
  } catch (e) { setStatus('error: ' + e.message, true); }
}
// The page's entry point. index.html fetches data.json (the version stamp busts this module's
// cache, so it has to come first) and calls this with what it found.
// coi-serviceworker reloads the page once on the first visit to get SharedArrayBuffer; boot
// only on the isolated page. Hard reloads bypass service workers, hence the fallback message.
export function init(data) {
  V = data.version; bugs = data.bugs ?? [];
  renderBugs();
  if (V && crossOriginIsolated) boot();
  else if (V) { setStatus('Preparing browser for kernel startup…', false, true);
    setTimeout(() => setStatus('This page needs SharedArrayBuffer, which the service worker provides. Do a normal reload (hard reloads bypass it); private browsing may block it entirely.', true), 3000); }
  draw();
}
