// Exercise overlay.js state machine against a minimal DOM stub, targeting the
// exact races the review found (findings 2, 6, 7, 8, 11, 12).
const fs = require('fs');
const vm = require('vm');

// ---- minimal DOM ---------------------------------------------------------
class El {
	constructor(tag) {
		this.tagName = tag.toUpperCase();
		this.children = []; this.parentNode = null;
		this.dataset = {}; this.attrs = {}; this.style = {};
		this._text = ''; this._cls = new Set(); this._listeners = {};
		this.classList = {
			add: c => this._cls.add(c), remove: c => this._cls.delete(c),
			toggle: (c, on) => on ? this._cls.add(c) : this._cls.delete(c),
			contains: c => this._cls.has(c),
		};
	}
	get className() { return [...this._cls].join(' '); }
	set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
	get textContent() { return this._text; }
	set textContent(v) { this._text = String(v); }
	setAttribute(k, v) { this.attrs[k] = String(v); }
	removeAttribute(k) { delete this.attrs[k]; }
	getAttribute(k) { return this.attrs[k] ?? null; }
	appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
	replaceChildren(...n) {
		for (const c of this.children) c.parentNode = null;
		this.children = [];
		for (const x of n) {
			if (x && x.__frag) { for (const c of x.children) this.appendChild(c); }
			else if (x) this.appendChild(x);
		}
	}
	remove() {
		if (this.parentNode) {
			this.parentNode.children = this.parentNode.children.filter(c => c !== this);
			this.parentNode = null;
		}
	}
	contains(n) { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false; }
	closest(sel) {
		const cls = sel.replace('.', '');
		for (let p = this; p; p = p.parentNode) if (p._cls && p._cls.has(cls)) return p;
		return null;
	}
	addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
	removeEventListener(t, fn) { this._listeners[t] = (this._listeners[t] || []).filter(f => f !== fn); }
	dispatch(t, ev) { for (const fn of this._listeners[t] || []) fn(ev); }
	focus() { doc.activeElement = this; }
	blur() { if (doc.activeElement === this) doc.activeElement = null; }
	select() {}
	scrollIntoView() {}
}

const doc = {
	activeElement: null,
	documentElement: new El('html'),
	createElement: t => new El(t),
	createDocumentFragment: () => { const f = new El('#fragment'); f.__frag = true; return f; },
	getElementById: () => null,
};

// ---- timers we control ---------------------------------------------------
let timers = [], nextId = 1;
const win = {
	document: doc,
	Zotero_Tabs: { getTabIDByItemID: () => null },
	Services: { focus: { activeWindow: null } },
	setTimeout: (fn, ms) => { const id = nextId++; timers.push({ id, fn }); return id; },
	clearTimeout: (id) => { timers = timers.filter(t => t.id !== id); },
	addEventListener() {}, removeEventListener() {},
};
const flushTimers = () => { const t = timers; timers = []; for (const x of t) x.fn(); };

// ---- stub Zotero + modules ----------------------------------------------
const opened = [];
const Zotero = {
	isMac: true, debug() {}, logError(e) { unhandled.push(String(e)); },
	Prefs: { get: () => undefined },
	File: { getResourceAsync: async () => '/* css */' },
};
const unhandled = [];

let searchImpl = async () => ({ results: [], total: 0 });
win.ZQS_Engine = {
	init: () => 'obs1', destroy() {}, ensureIndex: async () => [],
	search: (...a) => searchImpl(...a),
};
win.ZQS_Opener = {
	init: () => null, destroy() {},
	peekAttachmentID: () => null,
	openEntry: async (e) => { opened.push(e.t); },
};

const ctx = { Zotero, Math, JSON, console, Number, String, Array, Set, Map, Promise };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../src/overlay.js', 'utf8'), ctx, { filename: 'overlay.js' });
const O = ctx.ZQS_Overlay;

let idSeq = 100;
// Distinct ids per result set: reusing ids across searches would mask the very
// staleness the click guard exists to catch.
const mkResults = (names) => names.map((t, i) => {
	const id = ++idSeq;
	return {
		entry: { id, key: 'K' + id, lib: 1, t: t.toLowerCase(), i: '', c: '', y: '', p: '', m: 0 },
		score: 1 - i * 0.1,
	};
});
// The overlay asks Zotero for display strings for the rows it shows.
Zotero.Items = {
	get: () => null,
	getAsync: async (ids) => (Array.isArray(ids) ? ids : [ids]).map(id => ({
		id, libraryID: 1,
		getDisplayTitle: () => titleFor.get(id) || ('item ' + id),
		getField: () => '',
	})),
};
Zotero.Libraries = { userLibraryID: 1, get: () => ({ name: 'My Library' }) };
const titleFor = new Map();

let pass = 0, total = 0;
const check = (name, cond, detail = '') => {
	total++; if (cond) { pass++; console.log(`PASS  ${name}`); }
	else console.log(`FAIL  ${name}  ${detail}`);
};

(async () => {
	await O.init(win, 'file:///plugin/');

	// ---- T1: basic search renders and preselects first --------------------
	searchImpl = async () => { const r = mkResults(['alpha one', 'alpha two']); r.forEach(x => titleFor.set(x.entry.id, x.entry.t)); return { results: r, total: 2 }; };
	O.open();
	O._input.value = 'alpha';
	O._onInput(); flushTimers(); await new Promise(r => setImmediate(r));
	check('T1 renders results, first preselected',
		O._list.children.length === 2 && O._selectedIndex === 0 && O._list.children[0]._cls.has('selected'),
		`rows=${O._list.children.length} sel=${O._selectedIndex}`);

	// ---- T2: close() cancels a pending debounce (finding 6/12) ------------
	O.close();
	O.open();
	O._input.value = 'neural';
	O._onInput();               // arm debounce
	O.close();                  // dismiss before it fires
	flushTimers(); await new Promise(r => setImmediate(r));
	O.open();                   // reopen fresh
	await new Promise(r => setImmediate(r));
	check('T2 abandoned query does not render into a reopened switcher',
		O._list.children.length === 0 && O._input.value === '',
		`rows=${O._list.children.length} input="${O._input.value}"`);

	// ---- T3: destroy() during an in-flight search (finding 2, CRITICAL) ---
	let release;
	searchImpl = () => new Promise(r => { const x = mkResults(['late']); x.forEach(y => titleFor.set(y.entry.id, y.entry.t)); release = () => r({ results: x, total: 1 }); });
	O.open(); O._input.value = 'late'; O._onInput(); flushTimers();
	O.destroy();                // nulls _doc/_list while search is suspended
	release();
	await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
	check('T3 in-flight search after destroy() does not throw',
		unhandled.length === 0, `unhandled=${JSON.stringify(unhandled)}`);

	// ---- rebuild for remaining tests --------------------------------------
	await O.init(win, 'file:///plugin/');

	// ---- T4: stale click resolves by item id, not index (finding 7) -------
	searchImpl = async () => { const r = mkResults(['alpha one', 'alpha two']); r.forEach(x => titleFor.set(x.entry.id, x.entry.t)); return { results: r, total: 2 }; };
	O.open(); O._input.value = 'alpha'; O._onInput(); flushTimers(); await new Promise(r => setImmediate(r));
	const staleRow = O._rows[1];                  // "alpha two"
	O._list.dispatch('mousedown', { target: staleRow });   // press on alpha two
	searchImpl = async () => { const r = mkResults(['beta one', 'beta two']); r.forEach(x => titleFor.set(x.entry.id, x.entry.t)); return { results: r, total: 2 }; };
	O._input.value = 'beta'; O._onInput(); flushTimers(); await new Promise(r => setImmediate(r));
	opened.length = 0;
	O._list.dispatch('click', { target: staleRow, shiftKey: false, metaKey: false });
	await new Promise(r => setImmediate(r));
	check('T4 re-render between mousedown and click opens nothing (not the wrong paper)',
		opened.length === 0, `opened=${JSON.stringify(opened)}`);

	// A normal press-and-click on a stable row must still work.
	opened.length = 0;
	const liveRow = O._rows[0];
	O._list.dispatch('mousedown', { target: liveRow });
	O._list.dispatch('click', { target: liveRow, shiftKey: false, metaKey: false });
	await new Promise(r => setImmediate(r));
	check('T4b ordinary click still opens the row', opened.length === 1,
		`opened=${JSON.stringify(opened)}`);

	// ---- T5: mousemove at an unchanged position must not steal selection --
	// T4b opened a row, which closes the overlay; reopen for the pointer tests.
	O.open();
	O._input.value = 'beta'; O._onInput(); flushTimers();
	await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
	O._selectedIndex = 1; O._paintSelection();
	const row0 = O._rows[0];
	O._lastPointer = { x: 500, y: 400 };
	O._list.dispatch('mousemove', { target: row0, screenX: 500, screenY: 400 });
	check('T5 synthesized mousemove at same coords does not move selection',
		O._selectedIndex === 1, `sel=${O._selectedIndex}`);
	O._list.dispatch('mousemove', { target: row0, screenX: 501, screenY: 400 });
	check('T5b real pointer move does select', O._selectedIndex === 0, `sel=${O._selectedIndex}`);

	// ---- T6: a display-fetch failure must not desync _results from the list --
	const badResults = mkResults(['ok']);
	searchImpl = async () => ({ results: badResults, total: 1 });
	const realGetAsync = Zotero.Items.getAsync;
	Zotero.Items.getAsync = async () => { throw new Error('UnloadedData'); };
	O._input.value = 'boom'; O._onInput(); flushTimers();
	for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
	// The row still renders (with a placeholder title) and _results agrees with
	// what is on screen, so Enter cannot open something the user cannot see.
	check('T6 display failure keeps _results and the list in step',
		O._results.length === 1 && O._list.children.length === 1 && O._visible,
		`results=${O._results.length} rows=${O._list.children.length} visible=${O._visible}`);
	check('T6b failed display falls back to a placeholder title',
		O._rows && O._rows[0]._zqs.title.textContent === '(untitled)',
		O._rows ? JSON.stringify(O._rows[0]._zqs.title.textContent) : 'no rows');
	Zotero.Items.getAsync = realGetAsync;

	// ---- T7: arrow wrap + Enter opens the selected row --------------------
	searchImpl = async () => { const r = mkResults(['one', 'two', 'three']); r.forEach(x => titleFor.set(x.entry.id, x.entry.t)); return { results: r, total: 3 }; };
	O._input.value = 'x'; O._onInput(); flushTimers();
	// _runSearch awaits both the scan and the display fetch, so drain a few turns.
	for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
	O._move(-1);                                  // wrap backwards from 0 -> 2
	opened.length = 0;
	O._activate({});
	await new Promise(r => setImmediate(r));
	check('T7 ArrowUp wraps to last and Enter opens it',
		opened[0] === 'three', `opened=${JSON.stringify(opened)}`);

	console.log(`\n${pass}/${total} passed` + (unhandled.length ? `\nunhandled: ${JSON.stringify(unhandled)}` : ''));
	process.exit(pass === total ? 0 : 1);
})();
