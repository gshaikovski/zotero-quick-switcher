/**
 * Zotero Quick Switcher — turning a selected row into an open tab.
 *
 * The row is a regular (parent) item, but what opens in a tab is one of its
 * child attachments. Two things are easy to get wrong:
 *
 *   - Zotero_Tabs.getTabIDByItemID() matches tab.data.itemID, which for a
 *     reader tab is the ATTACHMENT's id, never the parent's (reader.js:1802-1804).
 *   - Zotero.Reader.open() already does its own already-open detection when
 *     allowDuplicate is falsy (reader.js:2712-2738): it finds an existing tab,
 *     loaded or unloaded, and selects it rather than duplicating. "Switch to it
 *     if already open" is therefore Zotero's behaviour, not ours to reimplement.
 */

var ZQS_Opener = {
	_win: null,

	init(win) {
		this._win = win;
	},

	destroy() {
		this._win = null;
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
	 * Open an index entry.
	 *
	 * @param {Object} entry index entry ({ id, attachmentID, … })
	 * @param {Object} [options]
	 * @param {Boolean} [options.reveal] select in the library instead of opening
	 * @param {Boolean} [options.background] open the tab without focusing it
	 */
	async openEntry(entry, { reveal = false, background = false } = {}) {
		const win = this._win;
		if (!win || !entry) return;

		// Re-resolve from the id: the item may have been deleted between render
		// and Enter, and its attachments may have changed since indexing.
		let item;
		try {
			item = Zotero.Items.get(entry.id);
		}
		catch (e) {
			item = null;
		}
		if (!item) return;

		if (reveal) return this.revealInLibrary(item);

		const attachment = this._resolveAttachment(item, entry);

		if (attachment && attachment.attachmentReaderType) {
			// Honour the user's external-handler preference unless they've asked
			// us to always land in a Zotero tab. Zotero's own double-click path
			// checks Prefs 'fileHandler.<readerType>' first and only then falls
			// through to Reader.open (fileHandlers.js:50-58).
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
					// Reader.open returns undefined when it switched to an
					// existing UNLOADED tab (reader.js:2719) — which is common,
					// since Zotero unloads all but the 3-5 most recent reader
					// tabs. Never dereference the return value.
					await Zotero.Reader.open(attachment.id, null, {
						openInBackground: background,
					});
					return;
				}
				// File is missing: fall through to viewItems, which shows the
				// not-found dialog and can trigger a sync download.
			}
		}

		// Mirror double-click: external app for a .docx, else url/DOI in the
		// browser. Note viewItems does NOTHING — no error, no message — when
		// there is no attachment and no url and no DOI (zoteroPane.js:5044-5068),
		// so we check whether it had anything to act on and reveal if not.
		if (attachment || this._hasLaunchableURL(item)) {
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

	/**
	 * Prefer the attachment recorded at index time, but verify it still exists
	 * and is still reader-openable; otherwise re-derive it.
	 */
	_resolveAttachment(item, entry) {
		if (entry && entry.attachmentID) {
			try {
				const att = Zotero.Items.get(entry.attachmentID);
				if (att && !att.deleted && att.attachmentReaderType) return att;
			}
			catch (e) {}
		}
		try {
			const win = this._win;
			const id = win.ZQS_Engine._pickReaderAttachment(item);
			return id ? Zotero.Items.get(id) : null;
		}
		catch (e) {
			return null;
		}
	},

	_hasLaunchableURL(item) {
		try {
			if (item.getField('url')) return true;
			const doi = item.getField('DOI');
			if (doi && Zotero.Utilities.cleanDOI(doi)) return true;
			for (const id of item.getAttachments()) {
				let att;
				try {
					att = Zotero.Items.get(id);
				}
				catch (e) {
					continue;
				}
				if (att && att.getField('url')) return true;
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
