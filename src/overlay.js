/**
 * Zotero Quick Switcher — the overlay UI.
 *
 * Why a XUL <panel> and not an absolutely-positioned <div>:
 * a reader tab is a XUL <browser> living inside <deck id="tabs-deck"> inside
 * <stack id="zotero-pane-stack">. A sibling div in that stack is not a reliable
 * way to paint over a browser element, whereas a <panel> renders in its own
 * popup layer, always above content. It is also the pattern Zotero itself uses
 * for the closest existing UI — the tabs menu (elements/tabsMenuPanel.js), a
 * filterable list with a preselected row and arrow-key navigation.
 *
 * Hotkey capture: a CAPTURE-phase keydown listener on the chrome document.
 * The reader is in-process (its <browser> sets neither remote nor
 * maychangeremoteness, reader.js:1812-1818), so content key events do travel
 * through the chrome document, and capture phase runs before the reader's own
 * capturing handler (resource/reader/reader.js:72684-72690) can call
 * stopPropagation() on the combos it claims. This is exactly how Zotero
 * implements Cmd+W-closes-a-reader-tab (ZoteroPane.captureKeyDown,
 * zoteroPane.js:79-81, 921-1043).
 */

var ZQS_Overlay = {
	PANEL_ID: 'zqs-panel',
	STYLESHEET_ID: 'zqs-stylesheet',
	MAX_RESULTS: 50,
	VISIBLE_ROWS: 10,
	DEBOUNCE_MS: 130,

	_win: null,
	_doc: null,
	_rootURI: null,
	_panel: null,
	_input: null,
	_list: null,
	_status: null,
	_link: null,

	_results: [],
	_selectedIndex: 0,
	_searchSeq: 0,
	_debounceTimer: null,
	_hotkey: null,

	_onKeyDownCapture: null,
	_onWindowDeactivate: null,
	_onMouseDownCapture: null,

	/* ---------------------------------------------------------------- *
	 * Lifecycle
	 * ---------------------------------------------------------------- */

	init(win, rootURI) {
		this._win = win;
		this._doc = win.document;
		this._rootURI = rootURI;

		win.ZQS_Engine.init(win);
		win.ZQS_Opener.init(win);

		this._hotkey = this._readHotkeyPref();
		this._injectStylesheet();
		this._buildPanel();

		this._onKeyDownCapture = this._handleKeyDownCapture.bind(this);
		// Capture phase on the document — see file header.
		this._doc.addEventListener('keydown', this._onKeyDownCapture, true);

		this._onWindowDeactivate = () => this.close();
		win.addEventListener('deactivate', this._onWindowDeactivate);

		this._onMouseDownCapture = (event) => {
			if (!this.isOpen()) return;
			if (this._panel && !this._panel.contains(event.target)) this.close();
		};
		this._doc.addEventListener('mousedown', this._onMouseDownCapture, true);
	},

	destroy() {
		const win = this._win;
		const doc = this._doc;

		if (doc && this._onKeyDownCapture) {
			doc.removeEventListener('keydown', this._onKeyDownCapture, true);
		}
		if (doc && this._onMouseDownCapture) {
			doc.removeEventListener('mousedown', this._onMouseDownCapture, true);
		}
		if (win && this._onWindowDeactivate) {
			win.removeEventListener('deactivate', this._onWindowDeactivate);
		}
		if (this._debounceTimer) {
			win.clearTimeout(this._debounceTimer);
			this._debounceTimer = null;
		}

		try {
			if (this._panel) {
				if (this.isOpen()) this._panel.hidePopup();
				this._panel.remove();
			}
		}
		catch (e) {}

		try {
			if (this._link) this._link.remove();
		}
		catch (e) {}

		try {
			if (win && win.ZQS_Engine) win.ZQS_Engine.destroy();
			if (win && win.ZQS_Opener) win.ZQS_Opener.destroy();
		}
		catch (e) {}

		this._panel = this._input = this._list = this._status = this._link = null;
		this._results = [];
		this._win = this._doc = null;
		this._onKeyDownCapture = this._onWindowDeactivate = this._onMouseDownCapture = null;
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

		// Match on either the logical key or the physical code, so the binding
		// survives non-US keyboard layouts.
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
			this.toggle();
			return;
		}

		if (!this.isOpen()) return;

		// While open, we own these keys wherever focus happens to be.
		switch (event.key) {
			case 'Escape':
				event.preventDefault();
				event.stopPropagation();
				this.close();
				break;
			case 'ArrowDown':
				event.preventDefault();
				event.stopPropagation();
				this._move(1);
				break;
			case 'ArrowUp':
				event.preventDefault();
				event.stopPropagation();
				this._move(-1);
				break;
			case 'Enter':
				event.preventDefault();
				event.stopPropagation();
				this._activate();
				break;
			default:
				break;
		}
	},

	/* ---------------------------------------------------------------- *
	 * DOM construction
	 * ---------------------------------------------------------------- */

	_injectStylesheet() {
		const doc = this._doc;
		if (doc.getElementById(this.STYLESHEET_ID)) return;
		const link = doc.createElement('link');
		link.id = this.STYLESHEET_ID;
		link.rel = 'stylesheet';
		link.href = this._rootURI + 'skin/quickSwitcher.css';
		doc.documentElement.appendChild(link);
		this._link = link;
	},

	_buildPanel() {
		const doc = this._doc;

		const existing = doc.getElementById(this.PANEL_ID);
		if (existing) existing.remove();

		// createXULElement for the panel; plain createElement for the HTML
		// content inside it (zoteroPane.xhtml is an XHTML document).
		const panel = doc.createXULElement('panel');
		panel.id = this.PANEL_ID;
		panel.setAttribute('noautohide', 'true');
		panel.setAttribute('level', 'parent');
		panel.setAttribute('role', 'dialog');

		const box = doc.createElement('div');
		box.className = 'zqs-box';

		const input = doc.createElement('input');
		input.className = 'zqs-input';
		input.setAttribute('type', 'text');
		input.setAttribute('placeholder', 'Search your library…');
		input.setAttribute('aria-label', 'Search your library');

		const list = doc.createElement('div');
		list.className = 'zqs-list';
		list.setAttribute('role', 'listbox');

		const status = doc.createElement('div');
		status.className = 'zqs-status';

		box.appendChild(input);
		box.appendChild(list);
		box.appendChild(status);
		panel.appendChild(box);

		// The popupset is where Zotero keeps its own panels.
		const host = doc.querySelector('popupset') || doc.documentElement;
		host.appendChild(panel);

		input.addEventListener('input', () => this._onInput());
		panel.addEventListener('popupshown', () => {
			// Focus must wait for popupshown, otherwise it lands nowhere when
			// the previous focus was inside a reader iframe.
			input.focus();
			input.select();
		});

		list.addEventListener('click', (event) => {
			const row = event.target.closest('.zqs-row');
			if (!row) return;
			const idx = parseInt(row.dataset.index, 10);
			if (!isNaN(idx)) {
				this._selectedIndex = idx;
				this._activate();
			}
		});

		list.addEventListener('mousemove', (event) => {
			const row = event.target.closest('.zqs-row');
			if (!row) return;
			const idx = parseInt(row.dataset.index, 10);
			if (!isNaN(idx) && idx !== this._selectedIndex) {
				this._selectedIndex = idx;
				this._paintSelection();
			}
		});

		this._panel = panel;
		this._input = input;
		this._list = list;
		this._status = status;
	},

	/* ---------------------------------------------------------------- *
	 * Show / hide
	 * ---------------------------------------------------------------- */

	isOpen() {
		return !!this._panel && ['showing', 'open'].includes(this._panel.state);
	},

	toggle() {
		if (this.isOpen()) this.close();
		else this.open();
	},

	open() {
		if (!this._panel || this.isOpen()) return;
		const win = this._win;

		this._results = [];
		this._selectedIndex = 0;
		this._input.value = '';
		this._list.replaceChildren();
		this._setStatus('Type to search your library');

		// Centred horizontally, a bit above the middle — Obsidian-like.
		const width = 640;
		const x = win.screenX + Math.max(0, Math.round((win.outerWidth - width) / 2));
		const y = win.screenY + Math.round(win.outerHeight * 0.16);
		this._panel.openPopupAtScreen(x, y, false);
	},

	close() {
		if (!this._panel || !this.isOpen()) return;
		try {
			this._panel.hidePopup();
		}
		catch (e) {}
		// Invalidate any search still in flight.
		this._searchSeq++;
	},

	/* ---------------------------------------------------------------- *
	 * Searching
	 * ---------------------------------------------------------------- */

	_onInput() {
		const win = this._win;
		if (this._debounceTimer) win.clearTimeout(this._debounceTimer);
		this._debounceTimer = win.setTimeout(() => {
			this._debounceTimer = null;
			this._runSearch(this._input.value);
		}, this.DEBOUNCE_MS);
	},

	async _runSearch(query) {
		const seq = ++this._searchSeq;
		const trimmed = (query || '').trim();

		if (trimmed.length < this._win.ZQS_Engine.MIN_QUERY_LENGTH) {
			this._results = [];
			this._render();
			this._setStatus(trimmed ? 'Keep typing…' : 'Type to search your library');
			return;
		}

		let payload;
		try {
			payload = await this._win.ZQS_Engine.search(trimmed, { limit: this.MAX_RESULTS });
		}
		catch (e) {
			Zotero.logError(new Error('[quick-switcher] search failed: ' + e));
			if (seq !== this._searchSeq) return;
			this._results = [];
			this._render();
			this._setStatus('Search failed — see Debug Output');
			return;
		}

		// A newer keystroke already started; drop these results.
		if (seq !== this._searchSeq) return;

		this._results = payload.results;
		this._selectedIndex = 0;
		this._render();

		if (!this._results.length) {
			this._setStatus('No matches');
		}
		else {
			const n = this._results.length;
			this._setStatus(`${n} result${n === 1 ? '' : 's'}${payload.truncated ? ' (narrowed)' : ''}`);
		}

		this._markOpenTabs(seq);
	},

	/* ---------------------------------------------------------------- *
	 * Rendering
	 * ---------------------------------------------------------------- */

	_render() {
		const doc = this._doc;
		const rows = doc.createDocumentFragment();

		this._results.forEach(({ item }, index) => {
			const row = doc.createElement('div');
			row.className = 'zqs-row';
			row.dataset.index = String(index);
			row.setAttribute('role', 'option');

			const title = doc.createElement('div');
			title.className = 'zqs-title';
			title.textContent = item.getDisplayTitle() || '(untitled)';

			const meta = doc.createElement('div');
			meta.className = 'zqs-meta';
			meta.textContent = this._metaLine(item);

			const badge = doc.createElement('span');
			badge.className = 'zqs-badge';
			badge.hidden = true;
			badge.textContent = 'open';

			const text = doc.createElement('div');
			text.className = 'zqs-text';
			text.appendChild(title);
			text.appendChild(meta);

			row.appendChild(text);
			row.appendChild(badge);
			rows.appendChild(row);
		});

		this._list.replaceChildren(rows);
		this._paintSelection();
	},

	_metaLine(item) {
		const bits = [];
		try {
			const creator = item.getField('firstCreator', true);
			if (creator) bits.push(creator);
			const year = item.getField('year');
			if (year) bits.push(year);
			const pub = item.getField('publicationTitle');
			if (pub) bits.push(pub);
		}
		catch (e) {}
		return bits.join('  ·  ');
	},

	_paintSelection() {
		const rows = this._list.children;
		for (let i = 0; i < rows.length; i++) {
			const selected = i === this._selectedIndex;
			rows[i].classList.toggle('selected', selected);
			rows[i].setAttribute('aria-selected', selected ? 'true' : 'false');
			if (selected) rows[i].scrollIntoView({ block: 'nearest' });
		}
	},

	_move(delta) {
		if (!this._results.length) return;
		const n = this._results.length;
		// Wrap around, like Obsidian's switcher.
		this._selectedIndex = ((this._selectedIndex + delta) % n + n) % n;
		this._paintSelection();
	},

	_setStatus(text) {
		if (this._status) this._status.textContent = text;
	},

	/**
	 * Badge rows whose paper already has a tab open. Async and best-effort:
	 * a stale sequence number just means the user kept typing.
	 */
	async _markOpenTabs(seq) {
		const opener = this._win.ZQS_Opener;
		const rows = [...this._list.children];

		for (let i = 0; i < rows.length; i++) {
			if (seq !== this._searchSeq) return;
			const entry = this._results[i];
			if (!entry) continue;
			let tabID = null;
			try {
				tabID = await opener.getOpenTabID(entry.item);
			}
			catch (e) {}
			if (seq !== this._searchSeq) return;
			const badge = rows[i].querySelector('.zqs-badge');
			if (badge) badge.hidden = !tabID;
		}
	},

	/* ---------------------------------------------------------------- *
	 * Activation
	 * ---------------------------------------------------------------- */

	_activate() {
		const entry = this._results[this._selectedIndex];
		if (!entry) return;

		// Close FIRST. Both Zotero_Tabs.select() and Zotero.Reader.open() move
		// focus (tabs.js:941-959, reader.js:2786-2790), and there is no option
		// to leave it alone — so the overlay must be gone before we open.
		this.close();

		this._win.ZQS_Opener.openItem(entry.item).catch((e) => {
			Zotero.logError(new Error('[quick-switcher] open failed: ' + e));
		});
	},
};
