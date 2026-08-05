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

	_onKeyDownCapture: null,
	_onWindowDeactivate: null,

	/* ---------------------------------------------------------------- *
	 * Lifecycle
	 * ---------------------------------------------------------------- */

	async init(win, rootURI) {
		this._win = win;
		this._doc = win.document;
		this._rootURI = rootURI;

		win.ZQS_Engine.init(win);
		win.ZQS_Opener.init(win);

		this._hotkey = this._readHotkeyPref();
		await this._injectStylesheet();
		this._buildDOM();

		this._onKeyDownCapture = this._handleKeyDownCapture.bind(this);
		win.addEventListener('keydown', this._onKeyDownCapture, true);

		this._onWindowDeactivate = () => this.close();
		win.addEventListener('deactivate', this._onWindowDeactivate);

		// Warm the index in the background so the first Cmd+O is instant.
		win.ZQS_Engine.ensureIndex().catch((e) => {
			Zotero.debug('[quick-switcher] initial index build failed: ' + e);
		});
	},

	destroy() {
		const win = this._win;

		// Invalidate anything in flight BEFORE nulling fields, so a suspended
		// _runSearch cannot resume and dereference a null _doc.
		this._searchSeq++;
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
		this._results = [];
		this._win = this._doc = null;
		this._onKeyDownCapture = this._onWindowDeactivate = null;
	},

	/* ---------------------------------------------------------------- *
	 * Hotkey
	 * ---------------------------------------------------------------- */

	_readHotkeyPref() {
		let spec = 'accel+O';
		try {
			const val = Zotero.Prefs.get('extensions.quickswitcher.hotkey', true);
			if (val && typeof val === 'string' && val.trim()) spec = val.trim();
		}
		catch (e) {}

		const parts = spec.split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
		const key = parts.pop() || 'o';
		const mods = new Set(parts);
		return {
			key,
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

		// event.code is layout-independent; event.key is uppercased when Shift
		// is held. Accept either so the binding survives odd layouts.
		const key = (event.key || '').toLowerCase();
		const code = (event.code || '').toLowerCase();
		if (key !== hk.key && code !== 'key' + hk.key) return false;

		const wantCtrl = hk.ctrl || (hk.accel && !Zotero.isMac);
		const wantMeta = hk.meta || (hk.accel && Zotero.isMac);

		return event.ctrlKey === wantCtrl
			&& event.metaKey === wantMeta
			&& event.altKey === hk.alt
			&& event.shiftKey === hk.shift;
	},

	_handleKeyDownCapture(event) {
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
				consume();
				this._select(0);
				break;
			case 'End':
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
			return;
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
		list.addEventListener('click', (event) => {
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
			if (p && p.x === event.screenX && p.y === event.screenY) return;
			this._lastPointer = { x: event.screenX, y: event.screenY };

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

		this._cancelPending();
		this._results = [];
		this._selectedIndex = 0;
		this._lastPointer = null;
		this._input.value = '';
		this._list.replaceChildren();
		this._setStatus('Type to search your library');

		this._root.removeAttribute('hidden');
		this._visible = true;

		this._focusInput();
	},

	close() {
		if (!this._root || !this._visible) return;
		this._cancelPending();
		this._visible = false;
		this._root.setAttribute('hidden', 'true');
		try {
			this._input.blur();
		}
		catch (e) {}
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
			payload = await this._win.ZQS_Engine.search(trimmed, { limit: this.MAX_RESULTS });
		}
		catch (e) {
			Zotero.logError(new Error('[quick-switcher] search failed: ' + e));
			if (!this._stillCurrent(seq)) return;
			this._results = [];
			this._renderSafely();
			this._setStatus('Search failed — see Debug Output');
			return;
		}

		if (!this._stillCurrent(seq)) return;

		this._results = payload.results;
		this._selectedIndex = 0;
		this._renderSafely();

		if (!this._results.length) {
			this._setStatus('No matches');
		}
		else {
			const shown = this._results.length;
			const more = payload.total > shown ? ` of ${payload.total}` : '';
			this._setStatus(`${shown}${more} result${payload.total === 1 ? '' : 's'}`);
		}
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
			this._selectedIndex = 0;
			try {
				this._list.replaceChildren();
			}
			catch (ignored) {}
		}
	},

	_render() {
		const doc = this._doc;
		if (!doc || !this._list) return;

		const win = this._win;
		const tabs = win && win.Zotero_Tabs;
		const frag = doc.createDocumentFragment();

		this._results.forEach(({ entry }, index) => {
			const row = doc.createElement('div');
			row.className = 'zqs-row';
			row.dataset.itemId = String(entry.id);
			row.dataset.index = String(index);
			row.setAttribute('role', 'option');

			const text = doc.createElement('div');
			text.className = 'zqs-text';

			const title = doc.createElement('div');
			title.className = 'zqs-title';
			title.textContent = entry.title || '(untitled)';

			const meta = doc.createElement('div');
			meta.className = 'zqs-meta';
			meta.textContent = [entry.firstCreator, entry.year, entry.publication]
				.filter(Boolean).join('  ·  ');

			text.appendChild(title);
			text.appendChild(meta);
			row.appendChild(text);

			// The attachment id is resolved synchronously at index time, so the
			// "already open" badge needs no async work per row.
			if (entry.attachmentID && tabs) {
				let tabID;
				try {
					tabID = tabs.getTabIDByItemID(Number(entry.attachmentID));
				}
				catch (e) {}
				if (tabID) {
					const badge = doc.createElement('span');
					badge.className = 'zqs-badge';
					badge.textContent = 'open';
					row.appendChild(badge);
				}
			}

			frag.appendChild(row);
		});

		this._list.replaceChildren(frag);
		this._paintSelection();
	},

	_paintSelection() {
		if (!this._list) return;
		const rows = this._list.children;
		if (!rows.length) return;

		// Keep the index inside the current result set at all times.
		if (this._selectedIndex >= rows.length) this._selectedIndex = rows.length - 1;
		if (this._selectedIndex < 0) this._selectedIndex = 0;

		for (let i = 0; i < rows.length; i++) {
			const selected = i === this._selectedIndex;
			rows[i].classList.toggle('selected', selected);
			rows[i].setAttribute('aria-selected', selected ? 'true' : 'false');
			if (selected) {
				try {
					rows[i].scrollIntoView({ block: 'nearest' });
				}
				catch (e) {}
			}
		}
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
		const entry = this._results[this._selectedIndex];
		if (!entry) return;

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
		this.close();

		win.ZQS_Opener.openEntry(entry.entry, { reveal, background }).catch((e) => {
			Zotero.logError(new Error('[quick-switcher] open failed: ' + e));
		});
	},
};
