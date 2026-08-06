// Lifecycle tests: the paths that only break on plugin update, disable, or a
// window closing at an awkward moment — i.e. exactly what an offline harness
// can check and a quick manual test never will.
const fs = require('fs');
const vm = require('vm');

let pass = 0, total = 0;
const check = (name, cond, detail = '') => {
	total++; if (cond) { pass++; console.log(`PASS  ${name}`); }
	else console.log(`FAIL  ${name}   ${detail}`);
};

// ---- stubs ---------------------------------------------------------------
const loaded = [];         // paths passed to loadSubScript
const registered = new Set();
const unregistered = [];
let notifierSeq = 0;

function makeZotero() {
	return {
		isMac: true,
		debug() {}, logError() {},
		initializationPromise: Promise.resolve(),
		Notifier: {
			registerObserver() {
				const id = 'obs' + (++notifierSeq);
				registered.add(id);
				return id;
			},
			unregisterObserver(id) { unregistered.push(id); registered.delete(id); },
		},
		Prefs: { get: () => undefined },
		File: { getResourceAsync: async () => '/* css */' },
		getMainWindows: () => [],
		Items: { get: () => null }, Libraries: { getAll: () => [] },
	};
}

// A window stub that records its listeners.
function makeWindow({ ready = true } = {}) {
	const listeners = [];
	const win = {
		_ready: ready,
		listeners,
		document: {
			documentElement: { appendChild() {}, },
			createElement: () => ({
				setAttribute() {}, removeAttribute() {}, appendChild() {}, remove() {},
				addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} },
				dataset: {}, style: {}, children: [], replaceChildren() {},
			}),
			getElementById: () => null,
			activeElement: null,
		},
		addEventListener(t, fn) { listeners.push({ t, fn }); },
		removeEventListener(t, fn) {
			const i = listeners.findIndex(l => l.t === t && l.fn === fn);
			if (i !== -1) listeners.splice(i, 1);
		},
		setTimeout: () => 0, clearTimeout() {},
	};
	if (ready) { win.ZoteroPane = {}; win.Zotero_Tabs = {}; }
	return win;
}

function loadBootstrap(Zotero) {
	const Services = {
		scriptloader: {
			loadSubScript(path, target) {
				loaded.push(path);
				// Emulate the real modules just enough for lifecycle purposes.
				if (path.endsWith('engine.js')) {
					target.ZQS_Engine = {
						init: () => Zotero.Notifier.registerObserver({}, ['item'], 'idx'),
						destroy() {}, ensureIndex: async () => [],
					};
				}
				else if (path.endsWith('opener.js')) {
					target.ZQS_Opener = { init: () => null, destroy() {} };
				}
				else if (path.endsWith('overlay.js')) {
					target.ZQS_Overlay = {
						_alive: false,
						async init(win) {
							this._alive = true;
							const ids = [win.ZQS_Engine.init(win), win.ZQS_Opener.init(win)].filter(Boolean);
							await Promise.resolve();       // the stylesheet await
							return { notifierIDs: ids };
						},
						destroy() { this._alive = false; },
					};
				}
			},
		},
	};
	const ctx = { Zotero, Services, Map, Set, Promise, Error, console, Date };
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(__dirname + '/../bootstrap.js', 'utf8'), ctx, { filename: 'bootstrap.js' });
	return ctx;
}

(async () => {
	// ---- T1: deferred load listener must not survive shutdown -------------
	{
		loaded.length = 0;
		const Z = makeZotero();
		const B = loadBootstrap(Z);
		const win = makeWindow({ ready: false });   // not ready -> defers
		await B.startup({ rootURI: 'file:///plugin/' }, 1);
		await B.attachToWindow(win);
		check('T1a deferred attach registers a load listener', win.listeners.length === 1,
			'listeners=' + win.listeners.length);

		B.shutdown({}, 2);
		check('T1b shutdown removes the deferred load listener', win.listeners.length === 0,
			'listeners=' + win.listeners.length);

		// Even if it somehow fires, it must not load "nullsrc/engine.js".
		loaded.length = 0;
		await B.attachToWindow(win);
		const bad = loaded.filter(p => p.startsWith('null'));
		check('T1c post-shutdown attach never loads a null rootURI path',
			bad.length === 0 && loaded.length === 0, 'loaded=' + JSON.stringify(loaded));
	}

	// ---- T2: notifier observers unregister even if the window is dead -----
	{
		const Z = makeZotero();
		const B = loadBootstrap(Z);
		const win = makeWindow();
		await B.startup({ rootURI: 'file:///plugin/' }, 1);
		await B.attachToWindow(win);
		check('T2a observer registered during attach', registered.size >= 1,
			'registered=' + registered.size);

		// Simulate a window torn down so far its globals are gone.
		win.ZQS_Overlay = undefined;
		win.ZQS_Engine = undefined;
		const before = unregistered.length;
		B.onMainWindowUnload({ window: win }, 9);
		check('T2b observer still unregistered from bootstrap records',
			unregistered.length > before,
			`before=${before} after=${unregistered.length}`);
	}

	// ---- T3: shutdown during an in-flight attach --------------------------
	{
		const Z = makeZotero();
		const B = loadBootstrap(Z);
		const win = makeWindow();
		await B.startup({ rootURI: 'file:///plugin/' }, 1);
		const p = B.attachToWindow(win);   // suspends on the overlay init await
		B.shutdown({}, 2);                 // shutdown lands mid-attach
		await p;
		check('T3a aborted attach leaves no overlay installed',
			!win.ZQS_Overlay || win.ZQS_Overlay._alive === false,
			'alive=' + (win.ZQS_Overlay && win.ZQS_Overlay._alive));
		check('T3b aborted attach leaves no window listeners',
			win.listeners.length === 0, 'listeners=' + win.listeners.length);
	}

	// ---- T4: startup() after a previous run tears the old one down --------
	{
		const Z = makeZotero();
		const B = loadBootstrap(Z);
		const win = makeWindow();
		await B.startup({ rootURI: 'file:///plugin/' }, 1);
		await B.attachToWindow(win);
		const listenersAfterFirst = win.listeners.length;
		const before = unregistered.length;
		// disable -> enable: bootstrap.js is NOT re-evaluated, so startup runs
		// again with module state still populated.
		await B.startup({ rootURI: 'file:///plugin/' }, 3);
		check('T4 re-startup unregisters the previous run\'s observers',
			unregistered.length > before,
			`before=${before} after=${unregistered.length}, listeners ${listenersAfterFirst}`);
	}

	console.log(`\n${pass}/${total} passed`);
	process.exit(pass === total ? 0 : 1);
})();
