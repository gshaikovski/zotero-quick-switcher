/**
 * Zotero Quick Switcher — bootstrap
 *
 * This file runs in a Cu.Sandbox with the system principal, loaded by
 * Zotero.Plugins._loadScope() via Services.scriptloader.loadSubScriptWithOptions.
 *
 * Things that are NOT available in this scope (verified against Zotero 9.0.6,
 * chrome/content/zotero/xpcom/plugins.js:137-183):
 *   window, document, Components, Cc, Ci, Cu
 * Things that ARE available as bare globals:
 *   Zotero, Services, ChromeUtils, IOUtils, PathUtils, Localization,
 *   XMLSerializer, setTimeout/clearTimeout, setInterval/clearInterval,
 *   fetch, TextEncoder/TextDecoder, and the REASON constants.
 *
 * All DOM work therefore happens against window objects Zotero hands us, never
 * against an ambient `document`.
 */

var rootURI = null;

// NOTE: bootstrap.js is NOT re-evaluated on a disable -> enable cycle
// (plugins.js:133-135 — _loadScope early-returns when the scope already
// exists), so module-level state survives. Everything is therefore
// (re)initialised in startup() and fully torn down in shutdown().
//
// windowState is keyed by window and holds teardown data we own OURSELVES,
// rather than reaching through win.ZQS_* at teardown time. That matters
// because a window can be torn down far enough that its globals are gone
// while our Notifier observers — which are registered against the Zotero
// singleton, not the window — are still very much alive. Keeping the ids here
// means we can always unregister them.
var windowState = new Map();
var pendingWindows = new Set();

// Bumped by shutdown(). An attach that was awaiting when shutdown ran checks
// this and aborts instead of installing itself into a dead plugin.
var generation = 0;

const MODULES = [
	'src/engine.js',
	'src/opener.js',
	'src/overlay.js',
];

// Globals each module file defines on the window it is loaded into. These are
// `var` declarations at subscript global scope, which create writable but
// non-configurable properties — so teardown nulls them rather than `delete`-ing
// them (delete would silently fail).
const MODULE_GLOBALS = ['ZQS_Engine', 'ZQS_Opener', 'ZQS_Overlay'];

function log(msg) {
	Zotero.debug('[quick-switcher] ' + msg);
}

/** A main window is only usable once ZoteroPane and Zotero_Tabs exist. */
function isWindowReady(win) {
	return !!(win && win.document && win.ZoteroPane && win.Zotero_Tabs);
}

/**
 * Detach any window we are still tracking that has since closed. A missed
 * onMainWindowUnload would otherwise pin that ChromeWindow, its document and
 * its whole index for the rest of the session; this bounds the damage to the
 * gap before the next attach.
 */
function sweepDeadWindows() {
	for (const win of [...windowState.keys()]) {
		let dead = false;
		try {
			dead = win.closed === true;
		}
		catch (e) {
			dead = true; // window is gone far enough that property access throws
		}
		if (dead) {
			try {
				detachFromWindow(win);
			}
			catch (e) {}
		}
	}
}

async function attachToWindow(win) {
	if (!rootURI) return; // shut down, or not started yet
	sweepDeadWindows();
	if (!win || windowState.has(win) || pendingWindows.has(win)) return;

	if (!isWindowReady(win)) {
		// Track the listener so shutdown can remove it. Left untracked, it
		// fires after teardown, when rootURI is null, and tries to load
		// "nullsrc/engine.js".
		const onLoad = () => {
			// The placeholder entry MUST be removed before recursing: the guard
			// above rejects any window already in windowState, so leaving it
			// would make this branch dead code and the plugin permanently inert
			// on a window that was not ready the first time we saw it.
			windowState.delete(win);
			attachToWindow(win).catch((e) => {
				Zotero.logError(new Error('[quick-switcher] deferred attach failed: ' + e));
			});
		};
		windowState.set(win, { onLoad, notifierIDs: [], attached: false });
		win.addEventListener('load', onLoad, { once: true });
		return;
	}

	const gen = generation;
	pendingWindows.add(win);
	try {
		for (const path of MODULES) {
			Services.scriptloader.loadSubScript(rootURI + path, win);
		}
		const handles = await win.ZQS_Overlay.init(win, rootURI);

		// shutdown() ran while we were awaiting — undo rather than install.
		if (gen !== generation) {
			try {
				win.ZQS_Overlay.destroy();
			}
			catch (e) {}
			// Belt and braces: destroy() normally unregisters these, but this
			// branch must not depend on the window still being reachable.
			for (const id of (handles && handles.notifierIDs) || []) {
				try {
					Zotero.Notifier.unregisterObserver(id);
				}
				catch (e) {}
			}
			for (const name of MODULE_GLOBALS) {
				try {
					win[name] = undefined;
				}
				catch (ignored) {}
			}
			windowState.delete(win);
			log('attach aborted — plugin shut down mid-attach');
			return;
		}

		const prev = windowState.get(win) || {};
		windowState.set(win, {
			onLoad: null,
			notifierIDs: (handles && handles.notifierIDs) || [],
			attached: true,
		});
		if (prev.onLoad) {
			try {
				win.removeEventListener('load', prev.onLoad);
			}
			catch (e) {}
		}
		log('attached to main window');
	}
	catch (e) {
		// Hook exceptions are swallowed by Zotero (plugins.js:248-267) and never
		// surface to the user, so log loudly enough to be findable in the Debug
		// Output / Error Console.
		Zotero.logError(new Error('[quick-switcher] failed to attach to window: ' + e));
		try {
			detachFromWindow(win);
		}
		catch (ignored) {}
	}
	finally {
		pendingWindows.delete(win);
	}
}

function detachFromWindow(win) {
	if (!win) return;
	const state = windowState.get(win);

	// Remove a pending 'load' listener before anything else — if the window
	// never became ready, this is the only thing we ever registered.
	if (state && state.onLoad) {
		try {
			win.removeEventListener('load', state.onLoad);
		}
		catch (e) {}
	}

	try {
		if (win.ZQS_Overlay && typeof win.ZQS_Overlay.destroy === 'function') {
			win.ZQS_Overlay.destroy();
		}
	}
	catch (e) {
		Zotero.logError(new Error('[quick-switcher] overlay teardown failed: ' + e));
	}

	// Unregister from our own records too. If the window died before we could
	// reach its globals above, this is what stops the observers — which live on
	// the Zotero singleton — from leaking for the rest of the session.
	if (state && state.notifierIDs) {
		for (const id of state.notifierIDs) {
			try {
				Zotero.Notifier.unregisterObserver(id);
			}
			catch (e) {}
		}
	}

	for (const name of MODULE_GLOBALS) {
		try {
			win[name] = undefined;
		}
		catch (ignored) {}
	}

	windowState.delete(win);
	log('detached from main window');
}

/* ------------------------------------------------------------------ *
 * Bootstrap hooks.
 * Every hook is invoked as func.call(scope, params, reason) with
 * params = { id, version, rootURI } (+ { window } for the main-window hooks).
 * There is no `resourceURI` — that was Firefox's legacy bootstrap API.
 * Returned thenables ARE awaited (plugins.js:248-267).
 * ------------------------------------------------------------------ */

// eslint-disable-next-line no-unused-vars
function install(params, reason) {}

// eslint-disable-next-line no-unused-vars
async function startup({ rootURI: root }, reason) {
	// Detach anything a previous startup left behind. bootstrap.js is not
	// re-evaluated on disable -> enable, so windowState can still hold live
	// entries here; discarding the Map without tearing them down would leak
	// every listener and observer from the previous run.
	for (const win of [...windowState.keys()]) {
		try {
			detachFromWindow(win);
		}
		catch (e) {}
	}
	windowState = new Map();
	pendingWindows = new Set();

	rootURI = root; // always ends with '/'

	// Plugins.init() runs after Zotero.initializationDeferred.resolve(), so
	// Zotero is already initialised — but await it explicitly, since the item
	// and library data our index reads must be loaded.
	await Zotero.initializationPromise;

	// onMainWindowLoad does NOT fire for a main window that is already open: the
	// Services.wm listener is registered at the END of Plugins.init(), after
	// every plugin's startup() has run (plugins.js:93-124). The already-open
	// window is ours to handle.
	for (const win of Zotero.getMainWindows()) {
		await attachToWindow(win);
	}
}

// eslint-disable-next-line no-unused-vars
function onMainWindowLoad({ window: win }, reason) {
	return attachToWindow(win);
}

// eslint-disable-next-line no-unused-vars
function onMainWindowUnload({ window: win }, reason) {
	// NOTE: shipping bug in Zotero 9.0.6 — this hook is called with
	// REASONS.MAIN_WINDOW_LOAD (9), not MAIN_WINDOW_UNLOAD (10)
	// (plugins.js:120). Never branch on `reason` here.
	detachFromWindow(win);
}

// eslint-disable-next-line no-unused-vars
function shutdown(params, reason) {
	// Invalidate in-flight attaches before tearing anything down.
	generation++;
	rootURI = null;

	for (const win of [...windowState.keys()]) {
		detachFromWindow(win);
	}
	windowState = new Map();
	pendingWindows = new Set();
}

// eslint-disable-next-line no-unused-vars
function uninstall(params, reason) {}
