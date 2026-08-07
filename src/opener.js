/**
 * Zotero Quick Switcher — turning a selected row into an open tab.
 *
 * The row is a regular (parent) item, but what actually opens in a tab is one
 * of its child attachments. Two things are easy to get wrong:
 *
 *   - Zotero_Tabs.getTabIDByItemID() matches tab.data.itemID, which for a
 *     reader tab is the ATTACHMENT's id, never the parent's (reader.js:1802-1804).
 *   - Zotero.Reader.open() already does its own already-open detection when
 *     allowDuplicate is falsy (reader.js:2712-2738): it finds an existing tab,
 *     loaded or unloaded, and selects it rather than duplicating. "Switch to it
 *     if already open" is Zotero's behaviour, not ours to reimplement.
 *
 * SECURITY: index entries carry the item's stable `key` as well as its id.
 * SQLite reuses rowids after deletion, so an id cached at index time can point
 * at a *different* item by the time Enter is pressed — which would mean opening
 * a URL the displayed row never named. Every id is re-checked against its key
 * before it is acted on.
 */

var ZQS_Opener = {
	_win: null,
	/** itemID -> attachment id | null, for the ≤50 rows on screen. */
	_attCache: null,

	/** @returns {null} no Notifier observer of its own; kept for symmetry */
	init(win) {
		this._win = win;
		this._attCache = new Map();
		return null;
	},

	destroy() {
		this._win = null;
		this._attCache = null;
	},

	_prefBool(name, fallback) {
		try {
			const v = Zotero.Prefs.get('extensions.quickswitcher.' + name, true);
			return typeof v === 'boolean' ? v : fallback;
		}
		catch (e) {
			return fallback;
		}
	},

	/**
	 * Resolve an index entry to its live Zotero item, verifying identity.
	 * @returns {Zotero.Item|null}
	 */
	resolveItem(entry) {
		if (!entry) return null;
		let item;
		try {
			item = Zotero.Items.get(entry.id);
		}
		catch (e) {
			return null;
		}
		if (!item) return null;
		// Guards against SQLite rowid reuse: if the id now belongs to a
		// different item than the one indexed, refuse rather than open the
		// wrong thing.
		if (entry.key && item.key && item.key !== entry.key) {
			Zotero.debug('[quick-switcher] stale index entry (key mismatch); ignoring');
			return null;
		}
		return item;
	},

	/**
	 * Best reader-openable attachment id for a rendered row, or null.
	 * Synchronous and memoised — called once per visible row to draw the
	 * "open" badge, so it must not await.
	 */
	peekAttachmentID(entry) {
		if (!entry) return null;
		if (this._attCache && this._attCache.has(entry.id)) {
			return this._attCache.get(entry.id);
		}
		let out = null;
		try {
			const item = this.resolveItem(entry);
			if (item) out = this._pickReaderAttachment(item);
		}
		catch (e) {
			out = null;
		}
		if (this._attCache) {
			// Bounded: only ever holds what has been displayed.
			if (this._attCache.size > 500) this._attCache.clear();
			this._attCache.set(entry.id, out);
		}
		return out;
	},

	/**
	 * Mirrors the ordering of Zotero's getBestAttachments (item.js:4040-4060) —
	 * PDF first, then oldest — but restricted to types the reader can open.
	 */
	_pickReaderAttachment(item) {
		try {
			if (item.isAttachment()) {
				return item.attachmentReaderType ? item.id : null;
			}
			if (!item.isRegularItem()) return null;

			const ids = item.getAttachments();
			if (!ids || !ids.length) return null;

			const candidates = [];
			for (const id of ids) {
				let att;
				try {
					att = Zotero.Items.get(id);
				}
				catch (e) {
					continue;
				}
				if (!att || att.deleted) continue;
				const type = att.attachmentReaderType;
				if (!type) continue;
				candidates.push({
					id: att.id,
					isPDF: type === 'pdf',
					dateAdded: att.dateAdded || '',
				});
			}
			if (!candidates.length) return null;

			candidates.sort((a, b) => {
				if (a.isPDF !== b.isPDF) return a.isPDF ? -1 : 1;
				if (a.dateAdded !== b.dateAdded) return a.dateAdded < b.dateAdded ? -1 : 1;
				return a.id - b.id;
			});
			return candidates[0].id;
		}
		catch (e) {
			return null;
		}
	},

	/**
	 * Open an index entry.
	 *
	 * @param {Object} entry index entry ({ id, key, ... })
	 * @param {Object} [options]
	 * @param {Boolean} [options.reveal] select in the library instead of opening
	 * @param {Boolean} [options.background] open the tab without focusing it
	 */
	async openEntry(entry, { reveal = false, background = false } = {}) {
		const win = this._win;
		if (!win || !entry) return;

		// Re-resolve from the id and verify identity: the item may have been
		// deleted, or its rowid reused, between render and Enter.
		let item = this.resolveItem(entry);
		if (!item) {
			try {
				await Zotero.Items.getAsync(entry.id);
				item = this.resolveItem(entry);
			}
			catch (e) {
				item = null;
			}
		}
		if (!item) return;

		if (reveal) return this.revealInLibrary(item);

		const attID = this._pickReaderAttachment(item);
		let attachment = null;
		if (attID) {
			try {
				attachment = Zotero.Items.get(attID);
			}
			catch (e) {
				attachment = null;
			}
		}

		if (attachment && attachment.attachmentReaderType) {
			// Honour the user's external-handler preference unless they have
			// asked us to always land in a Zotero tab. Zotero's own
			// double-click path checks Prefs 'fileHandler.<readerType>' first
			// and only then falls through to Reader.open (fileHandlers.js:50-58).
			const forceTab = this._prefBool('alwaysOpenInZoteroTab', true);
			let externalHandler = '';
			try {
				externalHandler = Zotero.Prefs.get(
					'fileHandler.' + attachment.attachmentReaderType) || '';
			}
			catch (e) {}

			if (forceTab || !externalHandler) {
				let exists = true;
				try {
					exists = await attachment.fileExists();
				}
				catch (e) {
					exists = true; // can't tell — let the normal path handle it
				}

				if (exists) {
					try {
						// Reader.open returns undefined when it switched to an
						// existing UNLOADED tab (reader.js:2719), which is
						// common since Zotero unloads all but the 3-5 most
						// recent reader tabs. Never dereference the return value.
						await Zotero.Reader.open(attachment.id, null, {
							openInBackground: background,
						});
						return;
					}
					catch (e) {
						// Unguarded, a throw here would skip the whole fallback
						// chain below and make Enter a silent no-op.
						Zotero.logError(new Error('[quick-switcher] Reader.open failed: ' + e));
					}
				}
				// File missing: fall through to viewItems, which shows the
				// not-found dialog and can trigger a sync download.
			}
		}

		// Mirror double-click: external app for a .docx, else url/DOI in the
		// browser. `attachment` is only ever a READER-openable one, so the gate
		// has to ask about attachments in general — otherwise an item whose
		// sole attachment is a .docx would skip viewItems entirely and just get
		// revealed, never opening in the app the user configured.
		if (attachment || this._hasAnyAttachment(item) || this._hasLaunchableURL(item)) {
			try {
				await win.ZoteroPane.viewItems([item]);
				return;
			}
			catch (e) {
				Zotero.logError(new Error('[quick-switcher] viewItems failed: ' + e));
			}
		}

		return this.revealInLibrary(item);
	},

	/** Any non-trashed child attachment at all, reader-openable or not. */
	_hasAnyAttachment(item) {
		try {
			if (item.isAttachment()) return true;
			for (const id of item.getAttachments()) {
				let att;
				try {
					att = Zotero.Items.get(id);
				}
				catch (e) {
					continue;
				}
				if (att && !att.deleted) return true;
			}
		}
		catch (e) {}
		return false;
	},

	/**
	 * Would ZoteroPane.viewItems find something to launch?
	 *
	 * Deliberately mirrors its exact chain (zoteroPane.js:5044-5068): the item's
	 * url, then its DOI, then the url of the FIRST attachment only. Scanning
	 * every attachment here would be more generous than viewItems actually is,
	 * so the gate would open, viewItems would silently do nothing, and Enter
	 * would appear dead instead of falling through to revealing the item.
	 */
	_hasLaunchableURL(item) {
		try {
			if (item.getField('url')) return true;
			const doi = item.getField('DOI');
			if (doi && Zotero.Utilities.cleanDOI(doi)) return true;
			const ids = item.getAttachments();
			if (ids && ids.length) {
				let first;
				try {
					first = Zotero.Items.get(ids[0]);
				}
				catch (e) {
					first = null;
				}
				if (first && first.getField('url')) return true;
			}
		}
		catch (e) {}
		return false;
	},

	/**
	 * Switch to the library tab and select the item. selectItems() would switch
	 * tabs itself (zoteroPane.js:3138-3140), but doing it explicitly first makes
	 * the switch immediate rather than waiting on the async selection.
	 */
	async revealInLibrary(item) {
		const win = this._win;
		if (!win) return;
		try {
			win.Zotero_Tabs.select('zotero-pane');
		}
		catch (e) {
			Zotero.debug('[quick-switcher] tab select failed: ' + e);
		}
		try {
			await win.ZoteroPane.selectItem(item.id);
		}
		catch (e) {
			Zotero.logError(new Error('[quick-switcher] selectItem failed: ' + e));
		}
	},
};
