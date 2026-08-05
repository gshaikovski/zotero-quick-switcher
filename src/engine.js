/**
 * Zotero Quick Switcher — in-memory index and relevance ranking.
 *
 * Loaded into a main-window scope via Services.scriptloader.loadSubScript,
 * so `Zotero` here is the window's Zotero global.
 *
 * WHY A CLIENT-SIDE INDEX RATHER THAN Zotero.Search PER KEYSTROKE
 *
 * Zotero.Search.search() returns a bare Integer[] with no ORDER BY anywhere in
 * search.js and no score column, so ranking has to happen here regardless.
 * Given that, running it per keystroke buys nothing and costs two things:
 *
 *   - 'contains' compiles to SQL LIKE '%token%' (search.js:1644-1658), so a
 *     candidate must contain every token as a literal substring. Subsequence
 *     queries — "aiayn" for "Attention Is All You Need" — can never reach the
 *     ranker at all. Obsidian's switcher is fuzzy; matching that requires
 *     owning the candidate set.
 *   - its multi-word semantics are cross-field AND with per-field OR, so
 *     "deep learning" matches an item whose title has "deep" and whose creator
 *     is named "Learning" (search.js:1774-1829).
 *
 * The index is small: Zotero.Items.getAll(libraryID, true) on this library
 * returns ~2100 rows, of which only ~570 are actual papers.
 *
 * MANDATORY FILTER: getAll(onlyTopLevel = true) only LEFT JOINs itemNotes and
 * itemAttachments, so ANNOTATIONS pass the top-level test (items.js:122-127) —
 * 1553 of them here. isRegularItem() is what removes them.
 */

var ZQS_Engine = {
	/** Fields we match against, and how much each is worth. */
	WEIGHTS: {
		title: 1.0,
		initials: 0.9,
		shortTitle: 0.7,
		creators: 0.85,
		year: 0.6,
		publication: 0.4,
		citationKey: 0.5,
	},

	_win: null,
	_entries: [],
	_building: null,
	_dirty: true,
	_notifierID: null,

	init(win) {
		this._win = win;
		this._entries = [];
		this._dirty = true;
		this._building = null;

		this._notifierID = Zotero.Notifier.registerObserver({
			notify: (event, type) => {
				if (type !== 'item') return;
				// Any add/modify/delete/trash can change titles, creators or
				// which attachment is "best". Rebuilding ~570 entries is cheap
				// enough that incremental patching isn't worth the bug surface.
				if (['add', 'modify', 'delete', 'trash', 'restore'].includes(event)) {
					this._dirty = true;
				}
			},
		}, ['item'], 'quick-switcher-index');
	},

	destroy() {
		if (this._notifierID) {
			try {
				Zotero.Notifier.unregisterObserver(this._notifierID);
			}
			catch (e) {}
			this._notifierID = null;
		}
		this._entries = [];
		this._building = null;
		this._dirty = true;
		this._win = null;
	},

	/* ---------------------------------------------------------------- *
	 * Index construction
	 * ---------------------------------------------------------------- */

	/** Build (or rebuild) the index. Concurrent callers share one build. */
	async ensureIndex() {
		if (!this._dirty && this._entries.length) return this._entries;
		if (this._building) return this._building;

		this._building = (async () => {
			const entries = [];
			try {
				for (const lib of Zotero.Libraries.getAll()) {
					if (lib.libraryType === 'feed') continue; // noise for a paper switcher
					try {
						await lib.waitForDataLoad('item');
						const ids = await Zotero.Items.getAll(lib.libraryID, true, false, true);
						const items = await Zotero.Items.getAsync(ids);
						// Bulk-load creators/itemData up front. If this throws we
						// still continue — makeEntry guards every accessor, so
						// unloadable items degrade to being skipped, not to a
						// failed search.
						try {
							await Zotero.Items.loadDataTypes(items);
						}
						catch (e) {
							Zotero.debug('[quick-switcher] loadDataTypes failed: ' + e);
						}
						for (const item of items) {
							const entry = this.makeEntry(item);
							if (entry) entries.push(entry);
						}
					}
					catch (e) {
						Zotero.logError(new Error(
							'[quick-switcher] indexing library ' + lib.libraryID + ' failed: ' + e));
					}
				}
			}
			finally {
				this._building = null;
			}

			this._entries = entries;
			this._dirty = false;
			Zotero.debug('[quick-switcher] indexed ' + entries.length + ' items');
			return entries;
		})();

		return this._building;
	},

	/**
	 * Extract one index entry, or null if the item isn't a paper.
	 * EVERY accessor is guarded: getField/getCreators/getDisplayTitle all throw
	 * UnloadedDataException when the item's data didn't load (item.js:291-296),
	 * and one such item must never be able to take down the whole index.
	 */
	makeEntry(item) {
		try {
			// Drops notes and — critically — annotations, which getAll leaks.
			const standaloneAttachment = item.isAttachment()
				&& !item.parentID
				&& item.attachmentReaderType;
			if (!item.isRegularItem() && !standaloneAttachment) return null;
			if (item.deleted) return null;
		}
		catch (e) {
			return null;
		}

		const get = (field, baseMapped = false) => {
			try {
				return (item.getField(field, false, baseMapped) || '').toString();
			}
			catch (e) {
				return '';
			}
		};

		let title = '';
		try {
			title = (item.getDisplayTitle() || '').toString();
		}
		catch (e) {
			title = get('title');
		}

		// Creators in BOTH orders. Zotero's creator condition matches on
		// TRIM(firstName || ' ' || lastName) (searchConditions.js:406-415), so a
		// quoted "John Smith" must hit; but "Smith, John" is how people also
		// type it. Indexing both makes either work.
		let creators = '';
		let firstCreator = '';
		try {
			firstCreator = (item.getField('firstCreator', true) || '').toString();
			const parts = new Set();
			if (firstCreator) parts.add(firstCreator);
			for (const c of item.getCreators()) {
				const first = (c.firstName || '').trim();
				const last = (c.lastName || '').trim();
				if (first && last) {
					parts.add(first + ' ' + last);
					parts.add(last + ' ' + first);
				}
				else if (last) parts.add(last);
				else if (first) parts.add(first);
			}
			creators = [...parts].join(' ').trim();
		}
		catch (e) {
			creators = firstCreator;
		}

		// includeBaseMapped = true is required: a conferencePaper stores its
		// venue in proceedingsTitle, a bookSection in bookTitle, etc. Without
		// it getField('publicationTitle') returns '' for nine item types
		// (item.js:273-288, 569-573).
		const publication = get('publicationTitle', true);
		const year = get('year');
		const shortTitle = get('shortTitle');
		const citationKey = get('citationKey');

		const titleLower = this.normalize(title);

		return {
			id: item.id,
			title,
			firstCreator,
			year,
			publication,
			// Lowercased haystacks.
			l: {
				title: titleLower,
				initials: this._initials(titleLower),
				shortTitle: this.normalize(shortTitle),
				creators: this.normalize(creators),
				year: this.normalize(year),
				publication: this.normalize(publication),
				citationKey: this.normalize(citationKey),
			},
			attachmentID: this._pickReaderAttachment(item),
			dateModified: (() => {
				try {
					return item.dateModified || '';
				}
				catch (e) {
					return '';
				}
			})(),
		};
	},

	/** "attention is all you need" -> "aiayn", so acronym queries work. */
	_initials(titleLower) {
		const words = titleLower.split(/[^a-z0-9]+/).filter(Boolean);
		if (words.length < 2) return '';
		return words.map(w => w.charAt(0)).join('');
	},

	/**
	 * The reader-openable attachment for this item, resolved SYNCHRONOUSLY.
	 *
	 * item.getBestAttachment() is async and would mean one await per indexed
	 * item, plus another per rendered row to badge "already open". getAttachments()
	 * is synchronous and returns child ids (item.js:3973-4010), so we mirror the
	 * ordering getBestAttachments uses (PDF first, then oldest) but restrict to
	 * types the reader can actually open.
	 *
	 * @returns {Number|null} attachment itemID
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
				// attachmentReaderType is the definitive "can the reader open
				// this" test: 'pdf' | 'epub' | 'snapshot' | undefined
				// (item.js:3264-3280).
				const type = att.attachmentReaderType;
				if (!type) continue;
				candidates.push({ id: att.id, isPDF: type === 'pdf', dateAdded: att.dateAdded || '' });
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

	/* ---------------------------------------------------------------- *
	 * Query
	 * ---------------------------------------------------------------- */

	/**
	 * Normalise text for matching: lowercase, fold curly quotes onto straight
	 * ones, and NFC-normalise. Applied to BOTH the index and the query, so a
	 * title containing a typographic apostrophe still matches a typed one.
	 */
	normalize(s) {
		let out = (s || '').toString().toLowerCase()
			.replace(/[‘’ʼ′]/g, "'")
			.replace(/[“”″]/g, '"');
		try {
			out = out.normalize('NFC');
		}
		catch (e) {}
		return out;
	},

	/**
	 * Tokenise a query. Splits on whitespace and keeps "quoted phrases" whole.
	 *
	 * Only LEADING/TRAILING quotes are stripped, never interior ones: stripping
	 * every quote would turn "O'Brien" into "obrien" and "don't" into "dont",
	 * neither of which appears in the index, so those queries would match
	 * nothing while a half-typed phrase like `"attention` still needs its stray
	 * opening quote removed.
	 */
	tokenize(query) {
		const tokens = [];
		const re = /"([^"]*)"|(\S+)/g;
		let m;
		while ((m = re.exec(query)) !== null) {
			const raw = m[1] !== undefined ? m[1] : m[2];
			const text = this.normalize(raw).replace(/^["']+|["']+$/g, '').trim();
			if (text) tokens.push(text);
		}
		return tokens;
	},

	/** Score one token against one field, 0..1. */
	scoreToken(token, field) {
		if (!field || !token) return 0;
		if (field === token) return 1.0;
		if (field.startsWith(token)) return 0.9;

		const idx = field.indexOf(token);
		if (idx !== -1) {
			const prev = field.charAt(idx - 1);
			// Word-start hits are a much stronger signal than mid-word ones.
			if (idx === 0 || /[\s\-–—_/:,.()[\]"']/.test(prev)) return 0.75;
			return 0.5;
		}
		return this._subsequenceScore(token, field);
	},

	/**
	 * Fuzzy tier: are the token's characters present in order? Scored by how
	 * tightly packed the match is, so "aiayn" scores well against
	 * "attention is all you need" and poorly against a long unrelated title
	 * that happens to contain those letters scattered about.
	 */
	_subsequenceScore(token, field) {
		if (token.length < 2 || token.length > 32 || field.length > 400) return 0;

		let fi = 0;
		let first = -1;
		let last = -1;
		for (let ti = 0; ti < token.length; ti++) {
			const ch = token.charAt(ti);
			let found = -1;
			while (fi < field.length) {
				if (field.charAt(fi) === ch) { found = fi; fi++; break; }
				fi++;
			}
			if (found === -1) return 0;
			if (first === -1) first = found;
			last = found;
		}
		const span = (last - first) + 1;
		return 0.45 * (token.length / span); // 0.45 when perfectly contiguous
	},

	/**
	 * Relevance of one entry. Returns 0 when any token matches nothing at all —
	 * with no SQL prefilter, this AND across tokens is what does the filtering.
	 */
	scoreEntry(entry, tokens, rawQuery) {
		const W = this.WEIGHTS;
		const l = entry.l;
		let total = 0;
		let allTokensInTitle = true;

		for (const token of tokens) {
			const best = Math.max(
				W.title * this.scoreToken(token, l.title),
				W.initials * (l.initials.startsWith(token) ? 1 : 0),
				W.shortTitle * this.scoreToken(token, l.shortTitle),
				W.creators * this.scoreToken(token, l.creators),
				W.year * this.scoreToken(token, l.year),
				W.publication * this.scoreToken(token, l.publication),
				W.citationKey * this.scoreToken(token, l.citationKey)
			);
			if (best <= 0) return 0; // this token matches nothing — reject the item
			if (this.scoreToken(token, l.title) <= 0) allTokensInTitle = false;
			total += best;
		}

		let score = total / tokens.length;

		// Whole-query bonuses: what makes the obviously-right paper sit first
		// rather than merely appear somewhere in the list.
		const q = this.normalize(rawQuery).trim();
		if (q) {
			if (l.title === q) score += 0.60;
			else if (l.title.startsWith(q)) score += 0.30;
			else if (l.title.includes(q)) score += 0.18;
			if (l.initials === q) score += 0.45;
		}
		if (allTokensInTitle) score += 0.12;

		// Gentle preference for concise titles, so a short precise match beats
		// a long title containing the same words.
		score += 0.04 / (1 + Math.log(1 + l.title.length / 60));

		return score;
	},

	/**
	 * @returns {Promise<{results: Array<{entry, score}>, total: Number}>}
	 */
	async search(query, { limit = 50 } = {}) {
		const trimmed = (query || '').trim();
		if (!trimmed) return { results: [], total: 0 };

		const tokens = this.tokenize(trimmed);
		if (!tokens.length) return { results: [], total: 0 };

		const entries = await this.ensureIndex();

		// Deliberately NO prefilter. A cheap substring prefilter would silently
		// drop subsequence-only matches — exactly the fuzzy queries this index
		// exists to support — and would reintroduce the "results depend on how
		// big your library is" failure mode. Scoring is a handful of indexOf
		// calls per entry; the debounce absorbs it.
		const scored = [];
		for (const entry of entries) {
			let score = 0;
			try {
				score = this.scoreEntry(entry, tokens, trimmed);
			}
			catch (e) {
				continue; // one bad entry must never break the search
			}
			if (score > 0) scored.push({ entry, score });
		}

		scored.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			const am = a.entry.dateModified || '';
			const bm = b.entry.dateModified || '';
			if (am !== bm) return bm < am ? -1 : 1;
			return a.entry.id - b.entry.id;
		});

		return { results: scored.slice(0, limit), total: scored.length };
	},
};
