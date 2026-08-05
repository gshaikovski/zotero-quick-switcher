/**
 * Zotero Quick Switcher — turning a selected row into an open tab.
 *
 * The row the user selects is a regular (parent) item, but what actually opens
 * in a tab is one of its child attachments. Two consequences that are easy to
 * get wrong:
 *
 *   - Zotero_Tabs.getTabIDByItemID() matches on tab.data.itemID, which for a
 *     reader tab is the ATTACHMENT's id, never the parent's (reader.js:1802-1804).
 *
 *   - Zotero.Reader.open() already does its own already-open detection when
 *     allowDuplicate is falsy (reader.js:2712-2738): it finds an existing tab
 *     (loaded or unloaded) and selects it instead of opening a duplicate. So we
 *     get "switch to it if already open" for free, and must NOT implement a
 *     competing version of it.
 */

var ZQS_Opener = {
	_win: null,
	/** itemID -> attachment item or null. Cleared when items change. */
	_attachmentCache: new Map(),
	_notifierID: null,

	init(win) {
		this._win = win;
		this._attachmentCache = new Map();

		this._notifierID = Zotero.Notifier.registerObserver({
			notify: (event, type, ids) => {
				if (type !== 'item') return;
				// Any item change can add/remove/retarget a child attachment.
				if (event === 'add' || event === 'modify' || event === 'delete' || event === 'trash') {
					this._attachmentCache.clear();
				}
			},
		}, ['item'], 'quick-switcher-opener');
	},

	destroy() {
		if (this._notifierID) {
			Zotero.Notifier.unregisterObserver(this._notifierID);
			this._notifierID = null;
		}
		this._attachmentCache.clear();
		this._win = null;
	},

	/**
	 * The attachment that would open for this item, or null.
	 * getBestAttachment() throws (a bare string) for non-regular items, so the
	 * isRegularItem() guard is required, not defensive noise.
	 */
	async getOpenableAttachment(item) {
		if (this._attachmentCache.has(item.id)) {
			return this._attachmentCache.get(item.id);
		}

		let attachment = null;
		try {
			if (item.isAttachment()) {
				attachment = item;
			}
			else if (item.isRegularItem()) {
				attachment = (await item.getBestAttachment()) || null;
			}
		}
		catch (e) {
			Zotero.debug('[quick-switcher] getBestAttachment failed: ' + e);
			attachment = null;
		}

		this._attachmentCache.set(item.id, attachment);
		return attachment;
	},

	/**
	 * The id of an already-open tab showing this item, or null.
	 * Used purely to badge rows in the result list.
	 */
	async getOpenTabID(item) {
		const win = this._win;
		if (!win || !win.Zotero_Tabs) return null;
		const attachment = await this.getOpenableAttachment(item);
		if (!attachment) return null;
		// Strict equality against a Number (tabs.js:524-527).
		return win.Zotero_Tabs.getTabIDByItemID(Number(attachment.id)) || null;
	},

	/**
	 * Does this item have anything to fall back to when there is no attachment?
	 * Mirrors the url -> DOI -> first-attachment-url chain in
	 * ZoteroPane.viewItems (zoteroPane.js:5044-5068), which silently does
	 * nothing when all three are absent.
	 */
	_hasLaunchableURL(item) {
		try {
			if (item.getField('url')) return true;
			const doi = item.getField('DOI');
			if (doi && Zotero.Utilities.cleanDOI(doi)) return true;
			const attachmentIDs = item.getAttachments();
			for (const id of attachmentIDs) {
				const att = Zotero.Items.get(id);
				if (att && att.getField('url')) return true;
			}
		}
		catch (e) {
			// Unloaded data or wrong item type — treat as "nothing to launch".
		}
		return false;
	},

	/**
	 * Open the item, preferring a Zotero reader tab.
	 *
	 * Order of preference:
	 *   1. reader-openable attachment whose file is present -> Zotero.Reader.open
	 *      (guarantees a tab, and switches to the existing tab if there is one)
	 *   2. attachment present but not reader-openable, or file missing ->
	 *      ZoteroPane.viewItems, which is exactly what double-click does: it
	 *      handles the missing-file dialog, sync-download, external handlers,
	 *      and the url/DOI fallbacks
	 *   3. nothing openable at all -> reveal the item in the library tab, so
	 *      Enter always does something visible
	 */
	async openItem(item) {
		const win = this._win;
		if (!win || !item) return;

		const attachment = await this.getOpenableAttachment(item);

		if (attachment && attachment.attachmentReaderType) {
			let exists = true;
			try {
				exists = await attachment.fileExists();
			}
			catch (e) {
				exists = true; // can't tell; let the normal path deal with it
			}

			if (exists) {
				// Do NOT await a returned reader's _initPromise: Reader.open
				// returns undefined in the "switched to an existing UNLOADED
				// tab" case (reader.js:2719), which is common because Zotero
				// unloads all but the 3-5 most recent reader tabs.
				await Zotero.Reader.open(attachment.id, null, {});
				return;
			}
		}

		if (attachment || this._hasLaunchableURL(item)) {
			try {
				await win.ZoteroPane.viewItems([item]);
				return;
			}
			catch (e) {
				Zotero.logError(new Error('[quick-switcher] viewItems failed: ' + e));
			}
		}

		// Last resort: switch to the library tab and select it. Zotero's own
		// viewItems does nothing at all here, which would feel broken.
		try {
			await win.ZoteroPane.selectItem(item.id);
		}
		catch (e) {
			Zotero.logError(new Error('[quick-switcher] selectItem failed: ' + e));
		}
	},
};
