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
 *   fetch, TextEncoder/TextDecoder, and the REASON constants
 *   (APP_STARTUP, ADDON_INSTALL, MAIN_WINDOW_LOAD, ...).
 *
 * All DOM work therefore happens against window objects Zotero hands us, never
 * against an ambient `document`.
 */

var rootURI = null;

// Windows we have attached to, so teardown is exact.
// NOTE: bootstrap.js is NOT re-evaluated on a disable -> enable cycle
// (plugins.js:133-135 — _loadScope early-returns when the scope already
// exists), so module-level state survives. Everything is therefore
// (re)initialised in startup() and fully torn down in shutdown().
var attachedWindows = new Set();

const MODULES = [
	'src/engine.js',
	'src/opener.js',
	'src/overlay.js',
];

// Globals each module file defines on the window it is loaded into.
// Cleared on teardown. These are `var` declarations inside the module files,
// which create writable-but-non-configurable window properties, so we null
// them out rather than `delete`-ing them (delete would silently fail).
const MODULE_GLOBALS = ['ZQS_Engine', 'ZQS_Opener', 'ZQS_Overlay'];

function log(msg) {
	Zotero.debug('[quick-switcher] ' + msg);
}

/**
 * A main window is only usable once ZoteroPane exists and the document has
 * finished parsing. At APP_STARTUP the window is already fully loaded by the
 * time plugin startup() runs (Plugins.init() is awaited at the very end of
 * Zotero.initComplete()), but onMainWindowLoad can in principle arrive earlier.
 */
function isWindowReady(win) {
	return !!(win && win.document && win.ZoteroPane && win.Zotero_Tabs);
}

function attachToWindow(win) {
	if (!win || attachedWindows.has(win)) return;

	if (!isWindowReady(win)) {
		// Wait for the window to finish loading, then try again.
		win.addEventListener('load', function onLoad() {
			win.removeEventListener('load', onLoad);
			attachToWindow(win);
		}, { once: true });
		return;
	}

	try {
		for (const path of MODULES) {
			Services.scriptloader.loadSubScript(rootURI + path, win);
		}
		win.ZQS_Overlay.init(win, rootURI);
		attachedWindows.add(win);
		log('attached to main window');
	}
	catch (e) {
		// Hook exceptions are swallowed by Zotero (plugins.js:248-267) and never
		// surface to the user, so log loudly enough to be findable in the
		// Debug Output / Error Console.
		Zotero.logError(new Error('[quick-switcher] failed to attach to window: ' + e));
		try {
			detachFromWindow(win);
		}
		catch (ignored) {}
	}
}

function detachFromWindow(win) {
	if (!win) return;
	try {
		if (win.ZQS_Overlay && typeof win.ZQS_Overlay.destroy === 'function') {
			win.ZQS_Overlay.destroy();
		}
	}
	catch (e) {
		Zotero.logError(new Error('[quick-switcher] overlay teardown failed: ' + e));
	}

	for (const name of MODULE_GLOBALS) {
		try {
			win[name] = undefined;
		}
		catch (ignored) {}
	}

	attachedWindows.delete(win);
	log('detached from main window');
}

/* ------------------------------------------------------------------ *
 * Bootstrap hooks.
 * Every hook is invoked as func.call(scope, params, reason) with
 * params = { id, version, rootURI } (+ { window } for the main-window hooks).
 * There is no `resourceURI` — that was Firefox's legacy bootstrap API.
 * ------------------------------------------------------------------ */

// eslint-disable-next-line no-unused-vars
function install(params, reason) {}

// eslint-disable-next-line no-unused-vars
async function startup({ rootURI: root }, reason) {
	rootURI = root; // always ends with '/'
	attachedWindows = new Set();

	// Zotero.Plugins.init() runs after Zotero.initializationDeferred.resolve(),
	// so Zotero is initialised here — but await it anyway to be explicit, since
	// Zotero.SearchConditions must be loaded before our first addCondition()
	// call (searchConditions.js:722-724 throws otherwise).
	await Zotero.initializationPromise;

	// onMainWindowLoad does NOT fire for a main window that is already open:
	// the Services.wm listener is registered at the END of Plugins.init(),
	// after every plugin's startup() has run (plugins.js:93-124). So the
	// already-open window is ours to handle.
	for (const win of Zotero.getMainWindows()) {
		attachToWindow(win);
	}
}

// eslint-disable-next-line no-unused-vars
function onMainWindowLoad({ window: win }, reason) {
	attachToWindow(win);
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
	for (const win of [...attachedWindows]) {
		detachFromWindow(win);
	}
	attachedWindows = new Set();
	rootURI = null;
}

// eslint-disable-next-line no-unused-vars
function uninstall(params, reason) {}
