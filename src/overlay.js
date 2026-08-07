/**
 * Zotero Quick Switcher — the overlay UI.
 *
 * WHY A position:fixed XHTML DIV AND NOT A XUL <panel>
 *
 *   - A <panel> "completely takes over Escape keydown event, by attaching a
 *     capturing keydown listener to document which just closes the popup" —
 *     Zotero's own comment at xpcom/reader.js:1202-1204, where they had to work
 *     around it. We want Escape ourselves.
 *   - On macOS a panel is a separate native window, so hiding it triggers an
 *     OS-level key-window transfer that races the setTimeout(…, 0) refocus hook
 *     Zotero_Tabs.select() fires (tabs.js:941-944). Enter must hide the overlay
 *     before switching tabs, and with a div that is a synchronous display:none.
 *   - Precedent that a fixed div reliably paints over a reader <browser>:
 *     #zotero-tab-cover (zoteroPane.xhtml:1101 + skin/…/overlay.css:137-150) is
 *     exactly this construct.
 *
 * HOTKEY CAPTURE
 *
 * A capture-phase keydown listener on the chrome WINDOW. The reader is an
 * in-process, non-remote <browser> (reader.js:1812-1818), so content key events
 * travel through the chrome window, and capture runs before the reader's own
 * capturing handler (resource/reader/reader.js:72684-72690) can stopPropagation()
 * the combos it claims. The window is used rather than the document because
 * ZoteroPane already holds a capture listener on the document
 * (zoteroPane.js:79-81) — one level higher means we run first regardless of
 * registration order.
 */

var ZQS_Overlay = {
	ROOT_ID: 'zqs-overlay',
	STYLE_ID: 'zqs-style',
	MAX_RESULTS: 50,
	DEBOUNCE_MS: 110,

	_win: null,
	_doc: null,
	_rootURI: null,

	_root: null,
	_backdrop: null,
	_input: null,
	_list: null,
	_status: null,
	_style: null,

	_results: [],
	_selectedIndex: 0,
	_searchSeq: 0,
	_debounceTimer: null,
	_hotkey: null,
	_visible: false,
	_lastPointer: null,
	_prevFocus: null,
	_initGen: 0,
	_rows: null,
	_selectedRow: -1,
	_display: null,
	_pressedItemId: null,

	_onKeyDownCapture: null,
	_onWindowDeactivate: null,

	/* ---------------------------------------------------------------- *
	 * Lifecycle
	 * ---------------------------------------------------------------- */

	/**
	 * @returns {Promise<{notifierIDs: String[]}>} handles bootstrap tracks, so
	 *   teardown works even if the window is gone by then.
	 */
	async init(win, rootURI) {
		// Idempotent: a second init() would otherwise register a second pair of
		// window listeners that destroy() could never remove.
		if (this._win) this.destroy();

		this._win = win;
		this._doc = win.document;
		this._rootURI = rootURI;

		const notifierIDs = [
			win.ZQS_Engine.init(win),
			win.ZQS_Opener.init(win),
		].filter(Boolean);

		this._hotkey = this._readHotkeyPref();

		// Listeners go on BEFORE the stylesheet await. Registering after would
		// leave a window that got destroy()d mid-await with a live <style> and
		// no way to reach it.
		this._onKeyDownCapture = this._handleKeyDownCapture.bind(this);
		win.addEventListener('keydown', this._onKeyDownCapture, true);
		this._onWindowDeactivate = () => this.close();
		win.addEventListener('deactivate', this._onWindowDeactivate);

		const gen = ++this._initGen;
		await this._injectStylesheet();
		// destroy() ran while we were reading the stylesheet off disk.
		if (gen !== this._initGen || !this._win) {
			try {
				if (this._style) this._style.remove();
			}
			catch (e) {}
			this._style = null;
			return { notifierIDs };
		}

		this._buildDOM();

		// The index is built LAZILY, on the first Cmd+O — deliberately not here.
		// Warming it at startup would add its cost to every Zotero launch even
		// for sessions where the switcher is never used.

		return { notifierIDs };
	},

	destroy() {
		const win = this._win;

		// Invalidate anything in flight BEFORE nulling fields, so a suspended
		// _runSearch — or an init() awaiting the stylesheet — cannot resume and
		// dereference a null _doc.
		this._searchSeq++;
		this._initGen++;
		this._visible = false;

		if (this._debounceTimer && win) {
			try {
				win.clearTimeout(this._debounceTimer);
			}
			catch (e) {}
		}
		this._debounceTimer = null;

		if (win && this._onKeyDownCapture) {
			win.removeEventListener('keydown', this._onKeyDownCapture, true);
		}
		if (win && this._onWindowDeactivate) {
			win.removeEventListener('deactivate', this._onWindowDeactivate);
		}

		for (const el of [this._root, this._style]) {
			try {
				if (el) el.remove();
			}
			catch (e) {}
		}

		try {
			if (win && win.ZQS_Engine) win.ZQS_Engine.destroy();
			if (win && win.ZQS_Opener) win.ZQS_Opener.destroy();
		}
		catch (e) {
			Zotero.logError(new Error('[quick-switcher] module teardown failed: ' + e));
		}

		this._root = this._backdrop = this._input = this._list = this._status = this._style = null;
		this._prevFocus = null;
		this._rows = null;
		this._display = null;
		this._selectedRow = -1;
		this._results = [];
		this._win = this._doc = null;
		this._onKeyDownCapture = this._onWindowDeactivate = null;
	},

	/* ---------------------------------------------------------------- *
	 * Hotkey
	 * ---------------------------------------------------------------- */

	/**
	 * Names the user can write in the pref that don't equal the KeyboardEvent
	 * key value they produce. Without these, a documented spec like "alt+space"
	 * silently never fires, because event.key for the spacebar is " ".
	 */
	KEY_ALIASES: {
		space: ' ', spacebar: ' ',
		enter: 'enter', return: 'enter',
		esc: 'escape',
		up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright',
		comma: ',', period: '.', dot: '.', slash: '/', backslash: '\\',
		semicolon: ';', quote: "'", backtick: '`', minus: '-', equals: '=',
	},

	_readHotkeyPref() {
		let spec = 'accel+O';
		try {
			const val = Zotero.Prefs.get('extensions.quickswitcher.hotkey', true);
			if (val && typeof val === 'string' && val.trim()) spec = val.trim();
		}
		catch (e) {}

		const parts = spec.split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
		let key = parts.pop() || 'o';
		if (Object.prototype.hasOwnProperty.call(this.KEY_ALIASES, key)) {
			key = this.KEY_ALIASES[key];
		}
		const mods = new Set(parts);

		return {
			key,
			// Physical-position fallback, but only for plain letters/digits.
			codeFallback: /^[a-z]$/.test(key) ? 'key' + key
				: (/^[0-9]$/.test(key) ? 'digit' + key : null),
			accel: mods.has('accel'),
			ctrl: mods.has('ctrl') || mods.has('control'),
			meta: mods.has('meta') || mods.has('cmd') || mods.has('command'),
			alt: mods.has('alt') || mods.has('option'),
			shift: mods.has('shift'),
		};
	},

	_matchesHotkey(event) {
		const hk = this._hotkey;
		if (!hk) return false;

		const key = (event.key || '').toLowerCase();
		let match = key === hk.key;

		// Fall back to the physical key position only when the layout produced
		// something that isn't a plain character — otherwise an alternate layout
		// (Dvorak etc.) would bind BOTH the key labelled O and whatever sits at
		// QWERTY's O position, which is not what anyone asked for.
		if (!match && hk.codeFallback && !/^[a-z0-9]$/.test(key)) {
			match = (event.code || '').toLowerCase() === hk.codeFallback;
		}
		if (!match) return false;

		const wantCtrl = hk.ctrl || (hk.accel && !Zotero.isMac);
		const wantMeta = hk.meta || (hk.accel && Zotero.isMac);

		return event.ctrlKey === wantCtrl
			&& event.metaKey === wantMeta
			&& event.altKey === hk.alt
			&& event.shiftKey === hk.shift;
	},

	_handleKeyDownCapture(event) {
		// While an IME is composing, every keystroke belongs to the input method.
		// Consuming Enter/Escape/arrows here makes CJK text impossible to type.
		if (event.isComposing || event.keyCode === 229) return;

		if (this._matchesHotkey(event)) {
			event.preventDefault();
			event.stopPropagation();
			// stopPropagation alone still lets system-group XUL <key> handlers
			// run; this is Zotero's own idiom (zoteroPane.js:932-933).
			event.stopImmediatePropagation();
			this.toggle();
			return;
		}

		if (!this._visible) return;

		const consume = () => {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
		};

		switch (event.key) {
			case 'Escape':
				consume();
				this.close();
				break;
			case 'ArrowDown':
				consume();
				this._move(1);
				break;
			case 'ArrowUp':
				consume();
				this._move(-1);
				break;
			case 'Home':
				// Shift/Alt+Home is text selection inside the input; leave it.
				if (event.shiftKey || event.altKey) break;
				consume();
				this._select(0);
				break;
			case 'End':
				if (event.shiftKey || event.altKey) break;
				consume();
				this._select(this._results.length - 1);
				break;
			case 'Enter':
				consume();
				this._activate({
					reveal: event.shiftKey,
					background: Zotero.isMac ? event.metaKey : event.ctrlKey,
				});
				break;
			case 'Tab':
				// The overlay is modal. Letting Tab move focus behind it would
				// leave a visible switcher still swallowing Enter while
				// keystrokes land in Zotero's UI underneath.
				consume();
				this._focusInput();
				break;
			default:
				break;
		}
	},

	/* ---------------------------------------------------------------- *
	 * DOM
	 * ---------------------------------------------------------------- */

	/**
	 * Inject the stylesheet as <style> TEXT, not <link href>.
	 * A <link> pointing at rootURI works for an unpacked dev install
	 * (file:///) but is unproven for a packed .xpi (jar:file:///…!/). Reading
	 * the text and injecting it is scheme-agnostic, and appending to
	 * documentElement puts it last in document order so it wins cascade ties.
	 * This mirrors Zotero's own runtime-CSS pattern
	 * (components/virtualized-table.js:1543-1550).
	 */
	async _injectStylesheet() {
		const doc = this._doc;
		const existing = doc.getElementById(this.STYLE_ID);
		if (existing) existing.remove();

		let css = '';
		try {
			css = await Zotero.File.getResourceAsync(this._rootURI + 'skin/quickSwitcher.css');
		}
		catch (e) {
			Zotero.logError(new Error('[quick-switcher] could not read stylesheet: ' + e));
			// Without CSS the overlay is a full-bleed unstyled div covering the
			// whole window with no way to see or dismiss it — far worse than
			// not having the feature. This minimal sheet keeps it usable and
			// dismissable; the plugin is degraded but not destructive.
			css = '#zqs-overlay{position:fixed;inset:0;z-index:2147483000;'
				+ 'display:flex;flex-direction:column;align-items:center;padding-top:12vh}'
				+ '#zqs-overlay[hidden]{display:none}'
				+ '#zqs-overlay .zqs-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.32)}'
				+ '#zqs-overlay .zqs-modal{position:relative;width:640px;max-width:92vw;'
				+ 'max-height:76vh;overflow:hidden;background:Canvas;color:CanvasText;'
				+ 'border:1px solid ThreeDShadow;border-radius:10px}'
				+ '#zqs-overlay .zqs-input{width:100%;box-sizing:border-box;padding:14px 16px;'
				+ 'border:0;background:transparent;color:inherit;font-size:1.25em}'
				+ '#zqs-overlay .zqs-list{max-height:520px;overflow-y:auto}'
				+ '#zqs-overlay .zqs-row{display:flex;align-items:center;gap:10px;padding:8px 16px}'
				+ '#zqs-overlay .zqs-row.selected{background:Highlight;color:HighlightText}'
				+ '#zqs-overlay .zqs-status{padding:8px 16px;font-size:.82em}';
		}

		const style = doc.createElement('style');
		style.id = this.STYLE_ID;
		style.textContent = css;
		doc.documentElement.appendChild(style);
		this._style = style;
	},

	_buildDOM() {
		const doc = this._doc;

		const existing = doc.getElementById(this.ROOT_ID);
		if (existing) existing.remove();

		// zoteroPane.xhtml is an XHTML document, so createElement yields HTML
		// elements. createXULElement is only needed for XUL widgets; we use none.
		const root = doc.createElement('div');
		root.id = this.ROOT_ID;
		root.setAttribute('hidden', 'true');

		const backdrop = doc.createElement('div');
		backdrop.className = 'zqs-backdrop';

		const modal = doc.createElement('div');
		modal.className = 'zqs-modal';
		modal.setAttribute('role', 'combobox');
		modal.setAttribute('aria-expanded', 'true');

		const input = doc.createElement('input');
		input.className = 'zqs-input';
		input.setAttribute('type', 'text');
		input.setAttribute('autocomplete', 'off');
		input.setAttribute('spellcheck', 'false');
		input.setAttribute('placeholder', 'Search your library…');
		input.setAttribute('aria-label', 'Search your library');

		const list = doc.createElement('div');
		list.className = 'zqs-list';
		list.setAttribute('role', 'listbox');

		const status = doc.createElement('div');
		status.className = 'zqs-status';

		modal.appendChild(input);
		modal.appendChild(list);
		modal.appendChild(status);
		root.appendChild(backdrop);
		root.appendChild(modal);
		doc.documentElement.appendChild(root);

		input.addEventListener('input', () => this._onInput());
		backdrop.addEventListener('mousedown', (e) => {
			e.preventDefault();
			this.close();
		});

		// Resolve rows by ITEM ID, never by array index: _render() replaces the
		// list wholesale, but closest() still walks a detached node's ancestors,
		// so a click landing on a row from a previous render would otherwise
		// index into a different result array and open the wrong paper.
		// Rows are reused across renders, so a row element outlives the result
		// it displayed. Remember which item was under the pointer at mousedown
		// and refuse the click if a re-render swapped a different item into that
		// row in between — otherwise a result list refreshing between mousedown
		// and click would open a paper the user never aimed at.
		list.addEventListener('mousedown', (event) => {
			const row = event.target.closest ? event.target.closest('.zqs-row') : null;
			this._pressedItemId = row ? row.dataset.itemId : null;
		});

		list.addEventListener('click', (event) => {
			const row = event.target.closest ? event.target.closest('.zqs-row') : null;
			const pressed = this._pressedItemId;
			this._pressedItemId = null;
			if (!row || !pressed || row.dataset.itemId !== pressed) return;

			const idx = this._indexFromEvent(event);
			if (idx === -1) return;
			this._selectedIndex = idx;
			this._activate({
				reveal: event.shiftKey,
				background: Zotero.isMac ? event.metaKey : event.ctrlKey,
			});
		});

		list.addEventListener('mousemove', (event) => {
			// Gecko synthesizes mousemove at the last cursor position on every
			// reflow and scroll (that is how :hover stays correct), and we
			// scrollIntoView on every arrow key. Without this guard the row
			// under a stationary pointer would steal the selection and the
			// user could never arrow past it.
			const p = this._lastPointer;
			this._lastPointer = { x: event.screenX, y: event.screenY };
			// The first move after open() only establishes a baseline. Selecting
			// on it would let the synthesized move that follows the very first
			// render hijack the preselected top result.
			if (!p) return;
			if (p.x === event.screenX && p.y === event.screenY) return;

			const idx = this._indexFromEvent(event);
			if (idx !== -1 && idx !== this._selectedIndex) {
				this._selectedIndex = idx;
				this._paintSelection();
			}
		});

		this._root = root;
		this._backdrop = backdrop;
		this._input = input;
		this._list = list;
		this._status = status;
	},

	/** Map a pointer event to an index in the CURRENT result array, or -1. */
	_indexFromEvent(event) {
		const row = event.target.closest ? event.target.closest('.zqs-row') : null;
		if (!row || !this._list || !this._list.contains(row)) return -1;
		const id = Number(row.dataset.itemId);
		if (!id) return -1;
		return this._results.findIndex(r => r.entry.id === id);
	},

	/* ---------------------------------------------------------------- *
	 * Show / hide
	 * ---------------------------------------------------------------- */

	isOpen() {
		return this._visible;
	},

	toggle() {
		if (this._visible) this.close();
		else this.open();
	},

	open() {
		if (!this._root || this._visible) return;

		// Remember where focus was so Escape can put it back. Without this the
		// chrome window is left with nothing focused and the next keystroke
		// goes nowhere.
		try {
			this._prevFocus = this._doc.activeElement;
		}
		catch (e) {
			this._prevFocus = null;
		}

		this._cancelPending();
		this._results = [];
		this._display = null;
		this._rows = null;
		this._selectedRow = -1;
		this._selectedIndex = 0;
		this._lastPointer = null;
		this._input.value = '';
		this._list.replaceChildren();
		this._setStatus('Type to search your library');

		this._root.removeAttribute('hidden');
		this._visible = true;

		this._focusInput();

		// Kick the (lazy) index build now, while the user is still typing their
		// first characters, so the build overlaps the typing rather than
		// following it. Chunked, so it does not block.
		try {
			this._win.ZQS_Engine.ensureIndex().catch(() => {});
		}
		catch (e) {}
	},

	/**
	 * @param {Object} [options]
	 * @param {Boolean} [options.restoreFocus] put focus back where it was.
	 *   Pass false when the caller is about to move focus deliberately (opening
	 *   a tab), so we don't fight Zotero's own refocus hook.
	 */
	close({ restoreFocus = true } = {}) {
		if (!this._root || !this._visible) return;
		this._cancelPending();
		this._visible = false;
		this._root.setAttribute('hidden', 'true');
		try {
			this._input.blur();
		}
		catch (e) {}

		if (restoreFocus && this._prevFocus) {
			try {
				// The element may have been torn down (a tab closed) while the
				// overlay was up, so verify it is still in the document.
				if (this._prevFocus.isConnected !== false && this._prevFocus.focus) {
					this._prevFocus.focus();
				}
			}
			catch (e) {}
		}
		// _prevFocus can be a reader tab's <browser>; holding it would pin a
		// detached docshell. Results and display records are released too, so a
		// closed switcher pins nothing.
		this._prevFocus = null;
		this._results = [];
		this._display = null;
		this._selectedRow = -1;
		if (this._rows) {
			for (const row of this._rows) {
				try {
					row.remove();
				}
				catch (e) {}
			}
			this._rows = null;
		}
	},

	/** Cancel the debounce AND invalidate any search already past it. */
	_cancelPending() {
		if (this._debounceTimer && this._win) {
			try {
				this._win.clearTimeout(this._debounceTimer);
			}
			catch (e) {}
		}
		this._debounceTimer = null;
		this._searchSeq++;
	},

	/**
	 * Focus can be coming back from inside a reader iframe, so verify it landed
	 * and retry once on the next tick if it didn't.
	 */
	_focusInput() {
		const input = this._input;
		if (!input) return;
		try {
			input.focus();
			input.select();
		}
		catch (e) {}

		this._win.setTimeout(() => {
			if (!this._visible || !this._input || !this._doc) return;
			if (this._doc.activeElement !== this._input) {
				try {
					this._input.focus();
				}
				catch (e) {}
			}
		}, 0);
	},

	/* ---------------------------------------------------------------- *
	 * Searching
	 * ---------------------------------------------------------------- */

	_onInput() {
		const win = this._win;
		if (!win) return;
		if (this._debounceTimer) win.clearTimeout(this._debounceTimer);
		const value = this._input.value;
		this._debounceTimer = win.setTimeout(() => {
			this._debounceTimer = null;
			if (!this._visible) return; // dismissed while the timer was pending
			this._runSearch(value);
		}, this.DEBOUNCE_MS);
	},

	/** True if this search is still the current one and the UI still exists. */
	_stillCurrent(seq) {
		return seq === this._searchSeq && !!this._doc && this._visible;
	},

	async _runSearch(query) {
		const seq = ++this._searchSeq;
		const trimmed = (query || '').trim();

		if (!trimmed) {
			this._results = [];
			this._renderSafely();
			this._setStatus('Type to search your library');
			return;
		}

		let payload;
		try {
			payload = await this._win.ZQS_Engine.search(trimmed, {
				limit: this.MAX_RESULTS,
				// Checked between chunks so a superseded scan stops immediately
				// instead of finishing work that will be discarded. Typing ten
				// characters costs about one scan, not ten.
				isCurrent: () => this._stillCurrent(seq),
			});
		}
		catch (e) {
			Zotero.logError(new Error('[quick-switcher] search failed: ' + e));
			if (!this._stillCurrent(seq)) return;
			this._results = [];
			this._renderSafely();
			this._setStatus('Search unavailable — see Help → Debug Output');
			return;
		}

		if (payload.abandoned || !this._stillCurrent(seq)) return;

		// The index holds only matching data. Display strings come from Zotero
		// for the handful of rows actually shown, which halves index memory and
		// keeps Zotero's own title formatting (base-mapped fields and all).
		let display;
		try {
			display = await this._loadDisplay(payload.results);
		}
		catch (e) {
			Zotero.debug('[quick-switcher] display load failed: ' + e);
			display = new Map();
		}
		if (!this._stillCurrent(seq)) return;

		this._results = payload.results;
		this._display = display;
		this._selectedIndex = 0;
		this._renderSafely();

		if (!this._results.length) {
			this._setStatus(payload.truncated
				? 'No matches in the most recent items'
				: 'No matches');
		}
		else {
			const shown = this._results.length;
			const more = payload.total > shown ? ` of ${payload.total}` : '';
			this._setStatus(`${shown}${more} result${payload.total === 1 ? '' : 's'}`
				+ (payload.truncated ? ' · large library, newest indexed' : ''));
		}
	},

	/**
	 * Fetch display fields for the results being shown.
	 * @returns {Promise<Map<Number, Object>>} itemID -> display record
	 */
	async _loadDisplay(results) {
		const out = new Map();
		if (!results.length) return out;

		const ids = results.map(r => r.entry.id);
		let items = [];
		try {
			items = await Zotero.Items.getAsync(ids);
		}
		catch (e) {
			return out;
		}

		for (const item of items) {
			if (!item) continue;
			const rec = { title: '', meta: '', foreign: false };
			try {
				rec.title = this._sanitize(item.getDisplayTitle() || '');
			}
			catch (e) {}
			try {
				const bits = [];
				const creator = item.getField('firstCreator', true);
				if (creator) bits.push(creator);
				const year = item.getField('year');
				if (year) bits.push(year);
				const pub = item.getField('publicationTitle', false, true);
				if (pub) bits.push(pub);
				rec.meta = this._sanitize(bits.join('  ·  '));
			}
			catch (e) {}
			try {
				// BACKSTOP. The index is restricted to My Library in SQL, so
				// this should never fire. It stays because it is cheap and it
				// fails safe: if that filter were ever wrong, a group-library
				// item would be visibly labelled rather than silently sitting
				// at the top of the list.
				const userLib = Zotero.Libraries.userLibraryID;
				if (item.libraryID !== userLib) {
					rec.foreign = true;
					const lib = Zotero.Libraries.get(item.libraryID);
					rec.libraryName = this._sanitize((lib && lib.name) || 'group library');
				}
			}
			catch (e) {}
			out.set(item.id, rec);
		}
		return out;
	},

	/**
	 * Strip characters that let a title render as something other than what it
	 * is: bidirectional overrides and zero-width/invisible characters. A
	 * group-library item could otherwise display as a different paper than the
	 * one Enter opens. Also collapses newlines and caps length, so one hostile
	 * item cannot blow up the row.
	 */
	_sanitize(s) {
		if (!s) return '';
		return s.toString()
			.replace(/[‪-‮⁦-⁩‎‏؜]/g, '')
			.replace(/[​-‍⁠﻿]/g, '')
			.replace(/\s+/g, ' ')
			.slice(0, 300)
			.trim();
	},

	/* ---------------------------------------------------------------- *
	 * Rendering
	 * ---------------------------------------------------------------- */

	/**
	 * Render, and on failure reset _results so the array can never disagree
	 * with what is actually on screen (pressing Enter on an apparently empty
	 * list must not open something invisible).
	 */
	_renderSafely() {
		try {
			this._render();
		}
		catch (e) {
			Zotero.logError(new Error('[quick-switcher] render failed: ' + e));
			this._results = [];
			this._display = null;
			this._rows = null;
			this._selectedRow = -1;
			this._selectedIndex = 0;
			try {
				this._list.replaceChildren();
			}
			catch (ignored) {}
		}
	},

	/**
	 * Rows are REUSED rather than rebuilt. The previous version recreated every
	 * element on every keystroke — 200 element creations and 100 textContent
	 * writes per character typed.
	 */
	_render() {
		const doc = this._doc;
		if (!doc || !this._list) return;

		const rows = this._rows || (this._rows = []);
		const n = this._results.length;

		while (rows.length < n) {
			const row = doc.createElement('div');
			row.className = 'zqs-row';
			row.setAttribute('role', 'option');

			const text = doc.createElement('div');
			text.className = 'zqs-text';
			const title = doc.createElement('div');
			title.className = 'zqs-title';
			const meta = doc.createElement('div');
			meta.className = 'zqs-meta';
			text.appendChild(title);
			text.appendChild(meta);

			const badge = doc.createElement('span');
			badge.className = 'zqs-badge';
			badge.hidden = true;

			const lib = doc.createElement('span');
			lib.className = 'zqs-lib';
			lib.hidden = true;

			row.appendChild(text);
			row.appendChild(lib);
			row.appendChild(badge);
			row._zqs = { title, meta, badge, lib };
			rows.push(row);
			this._list.appendChild(row);
		}

		while (rows.length > n) {
			const row = rows.pop();
			try {
				row.remove();
			}
			catch (e) {}
		}

		const tabs = this._win && this._win.Zotero_Tabs;
		for (let i = 0; i < n; i++) {
			const entry = this._results[i].entry;
			const row = rows[i];
			const parts = row._zqs;
			const d = (this._display && this._display.get(entry.id)) || null;

			row.dataset.itemId = String(entry.id);
			parts.title.textContent = (d && d.title) || '(untitled)';
			parts.meta.textContent = (d && d.meta) || '';

			if (d && d.foreign) {
				parts.lib.textContent = d.libraryName;
				parts.lib.hidden = false;
			}
			else {
				parts.lib.hidden = true;
			}

			// Resolved here, for the ≤50 visible rows only.
			let tabID = null;
			try {
				const att = this._win.ZQS_Opener.peekAttachmentID(entry);
				if (att && tabs) tabID = tabs.getTabIDByItemID(Number(att));
			}
			catch (e) {}
			parts.badge.hidden = !tabID;
			if (tabID) parts.badge.textContent = 'open';
		}

		this._selectedRow = -1;
		this._paintSelection();
	},

	/**
	 * Touch only the two rows that changed. The previous version rewrote all 50
	 * rows and forced a synchronous layout flush on every arrow key, including
	 * under key repeat.
	 */
	_paintSelection() {
		const rows = this._rows;
		if (!rows || !rows.length) return;

		if (this._selectedIndex >= rows.length) this._selectedIndex = rows.length - 1;
		if (this._selectedIndex < 0) this._selectedIndex = 0;

		const prev = this._selectedRow;
		const next = this._selectedIndex;
		if (prev === next) return;

		if (prev >= 0 && prev < rows.length) {
			rows[prev].classList.remove('selected');
			rows[prev].setAttribute('aria-selected', 'false');
		}
		const row = rows[next];
		if (row) {
			row.classList.add('selected');
			row.setAttribute('aria-selected', 'true');
			try {
				row.scrollIntoView({ block: 'nearest' });
			}
			catch (e) {}
		}
		this._selectedRow = next;
	},

	_select(index) {
		if (!this._results.length) return;
		this._selectedIndex = Math.max(0, Math.min(index, this._results.length - 1));
		this._paintSelection();
	},

	_move(delta) {
		const n = this._results.length;
		if (!n) return;
		this._selectedIndex = ((this._selectedIndex + delta) % n + n) % n; // wraps
		this._paintSelection();
	},

	_setStatus(text) {
		if (this._status) this._status.textContent = text;
	},

	/* ---------------------------------------------------------------- *
	 * Activation
	 * ---------------------------------------------------------------- */

	_activate({ reveal = false, background = false } = {}) {
		// _results holds { entry, score } wrappers; the opener wants the entry.
		const selected = this._results[this._selectedIndex];
		if (!selected || !selected.entry) return;

		const win = this._win;

		// Zotero.Reader.open hardcodes Zotero.getMainWindow() — the most recent
		// navigator:browser — for its existing-tab lookup (reader.js:2700). With
		// two main windows open, acting from a background one would open the tab
		// in the other window. Refuse rather than surprise.
		try {
			if (win.Services && win.Services.focus
				&& win.Services.focus.activeWindow
				&& win.Services.focus.activeWindow !== win) {
				Zotero.debug('[quick-switcher] ignoring activation from a non-active window');
				this.close();
				return;
			}
		}
		catch (e) {}

		// Close FIRST: Zotero_Tabs.select() snapshots document.activeElement and
		// fires the type's refocus hook on setTimeout(…, 0) (tabs.js:911-916,
		// 941-944), so anything focused after it is stolen a tick later.
		// restoreFocus:false because the tab we are about to open owns focus.
		this.close({ restoreFocus: false });

		win.ZQS_Opener.openEntry(selected.entry, { reveal, background }).catch((e) => {
			Zotero.logError(new Error('[quick-switcher] open failed: ' + e));
		});
	},
};
