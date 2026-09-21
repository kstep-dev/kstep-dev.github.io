#!/usr/bin/env node
// site/playground.mjs under Node, with just enough DOM to run it.
//
//   ./pagetest.mjs            # the checks below; non-zero exit on the first failure
//
// It is not a rendering test: it loads the module the way a browser would, drives the controls,
// and asserts the things that have actually broken -- a reference that no longer resolves, a
// figure that stops updating, a saved link that no longer opens. `crossOriginIsolated` is false
// throughout, so the module wires everything up and stops short of booting a VM.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'site', 'playground.mjs');

// ---- the DOM, about as much as the module touches ----
const autoList = () => new Proxy([], { get: (t, k) =>
  typeof k === 'string' && /^\d+$/.test(k) ? (t[k] ??= el()) : Reflect.get(t, k) });
function el(tag) {
  const e = {
    tag, textContent: '', className: '', value: '', title: '', type: '', checked: true,
    hidden: false, open: false, disabled: false, validity: { valid: true },
    style: {}, dataset: {}, options: [], children: [], classes: new Set(),
    scrollLeft: 0, scrollTop: 0, scrollWidth: 2000, scrollHeight: 100,
    clientWidth: 900, clientHeight: 100, firstElementChild: null, childElementCount: 0,
    getContext: () => new Proxy({}, { get: (_, k) => k === 'measureText' ? () => ({ width: 10 }) : () => {}, set: () => true }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 100 }),
    addEventListener(t, f) { (listeners.get(this) ?? listeners.set(this, {}).get(this))[t] = f; },
    append(...n) { this.children.push(...n); for (const x of n) if (x && typeof x === 'object') { x.parent = this; x.parentElement = this; } },
    remove() { const p = this.parent; if (p) p.children.splice(p.children.indexOf(this), 1); },
    querySelector: () => el(), querySelectorAll: () => [],
    add(o) { this.options.push(o); },
    replaceChildren(...n) { this.options.length = 0; this.children.length = 0; this.options.push(...n); },
    setAttribute() {}, removeAttribute() {},
  };
  e.classList = { add: (c) => e.classes.add(c), remove: (c) => e.classes.delete(c),
    toggle: (c, on) => on ? e.classes.add(c) : e.classes.delete(c), contains: (c) => e.classes.has(c) };
  e.rows = autoList(); e.cells = autoList(); e.tBodies = [e]; e.tHead = e;
  e.insertRow = () => { const r = el(); e.rows.push(r); return r; };
  e.insertCell = () => { const c = el(); e.cells.push(c); return c; };
  return e;
}
let listeners, els, url, built;

function installDom(search) {
  listeners = new Map(); els = new Map(); url = search; built = [];
  globalThis.document = {
    getElementById: (id) => els.get(id) ?? els.set(id, el(id)).get(id),
    createElement: (t) => el(t), createTextNode: (t) => ({ text: t }),
    documentElement: { dataset: {} }, body: el('body'),
    querySelector: () => el(), querySelectorAll: () => [], addEventListener() {},
  };
  globalThis.winListeners = {};
  globalThis.addEventListener = (t, f) => { winListeners[t] = f; };
  globalThis.getComputedStyle = () => ({ color: '#000' });
  globalThis.devicePixelRatio = 2;
  globalThis.crossOriginIsolated = false;          // wire everything up, boot nothing
  globalThis.location = { get search() { return url; }, pathname: '/', href: 'http://x/', origin: 'http://x', replace() {} };
  globalThis.history = { replaceState(_a, _b, u) { url = u.slice(u.indexOf('?')); } };
  globalThis.Option = class { constructor(label, value) { this.label = label; this.value = value; this.text = label; } };
  globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
  globalThis.setTimeout = () => 0; globalThis.clearTimeout = () => {};
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  // uPlot, recording enough to tell a build from an update, and firing the hooks setData fires
  globalThis.uPlot = class {
    constructor(o, d) { this.o = o; this.data = d; this.cursor = { idx: null }; this.updates = 0; built.push(this); this.fire('draw'); }
    fire(h) { for (const f of this.o.hooks?.[h] ?? []) f(this); }
    setSize() {}
    setData(d) { this.data = d; this.updates++; this.fire('setCursor'); this.fire('drawClear'); this.fire('draw'); }
    destroy() { this.dead = true; }
    valToPos(v, ax) { return ax === 'y' ? 50 - v * 10 : 48 + v * 8; }
    get bbox() { return { left: 48, top: 0, width: 800, height: 90 }; }
    get scales() { return { y: { min: 0.5, max: 3.5 } }; }
    get ctx() { return { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, globalAlpha: 1, fillStyle: '', fillRect() {} }; }
  };
  globalThis.uPlot.rangeNum = (lo, hi) => [lo, hi];
  globalThis.uPlot.paths = { stepped: () => () => ({}), linear: () => () => ({}), bars: () => () => ({}), spline: () => () => ({}) };
}

// a fresh module instance per case: the query makes the loader treat it as a new module
let caseNo = 0;
async function load(search = '?', data = { version: 'test', bugs: [] }) {
  installDom(search);
  const mod = await import(`file://${MODULE}?case=${caseNo++}`);
  mod.init(data);
  return mod;
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  if (!ok) failures++;
};
const live = () => built.filter((u) => !u.dead);
const chips = () => els.get('figure-picks').children.flatMap((r) => r.children.slice(1));
const shown = () => els.get('charts').children.map((r) => r.children[0].children[0].textContent);

await load('?');
check('module loads and wires up', true);
check('a plain load shows figures', live().length > 0, shown().join(', '));
check('Placement is the first figure', shown()[0] === 'Placement');
check('the URL records the set', decodeURIComponent(url).includes('charts=placement'), decodeURIComponent(url));

// a redraw at unchanged geometry must reach every chart: the path a tick takes
const before = live().map((u) => u.updates);
winListeners.resize();
check('a redraw updates every chart', live().every((u, i) => u.updates > before[i]));

// every figure at once, then none, then one: no leaked uPlot instances at any point
for (const c of chips()) { c.children[0].checked = true; c.children[0].onchange(); }
const all = live().length;
check('every figure can be shown', all === chips().length, `${all} figures`);
check('no leaked instances', live().length === els.get('charts').children.length);
for (const c of chips()) { c.children[0].checked = false; c.children[0].onchange(); }
check('all figures can be dropped', live().length === 0 && !decodeURIComponent(url).includes('charts='));
chips()[0].children[0].checked = true; chips()[0].children[0].onchange();
check('and added back from none', live().length === 1);

// zoom rebuilds, pan does not throw
const wheel = listeners.get(els.get('charts')).wheel;
const ev = (d, ctrl) => ({ preventDefault() {}, deltaY: d, deltaX: 0, ctrlKey: ctrl, metaKey: false, clientX: 400 });
const span = () => { const [a, b] = live()[0].o.scales.x.range(); return b - a; };
const wide = span();
for (let i = 0; i < 6; i++) wheel(ev(-1, true));
check('ctrl-wheel zooms in', span() < wide, `${wide} -> ${span()} ticks`);
for (let i = 0; i < 40; i++) wheel(ev(1, true));
check('zoom clamps', span() > wide);
wheel(ev(1, false));
check('plain wheel pans without throwing', true);

// a link saved before a figure was retired must still open
await load('?charts=placement,cputime');
check('a saved view opens', shown().join(',') === 'Placement,cpu time', shown().join(','));
await load('?charts=nosuchfigure');
check('an unknown figure is dropped, leaving the default set', shown().join(',') === 'Placement', shown().join(','));
await load('?scenario=fair');
check('a scenario brings its figures', shown().length > 1, shown().join(', '));

// the clock: play/pause is a state of its own, and step always stops the clock
await load('');
const play = els.get('play'), speed = els.get('speed');
check('the clock starts running', play.textContent === '\u23f8');
const rate = speed.value;
play.onclick();
check('pause flips the button and keeps the rate', play.textContent === '\u25b6' && speed.value === rate);
play.onclick();
check('play flips it back', play.textContent === '\u23f8');
els.get('step').onclick();
check('step stops the clock while it runs', play.textContent === '\u25b6');

console.log(failures ? `\n${failures} failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
