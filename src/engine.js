/**
 * Zotero Quick Switcher — search engine and relevance ranking.
 *
 * Loaded into a main-window scope via Services.scriptloader.loadSubScript,
 * so `Zotero` here is the window's Zotero global.
 *
 * Two-stage design:
 *
 *   1. Narrowing (SQLite, via Zotero.Search). We use the same
 *      'quicksearch-titleCreatorYear' condition Zotero's own search box uses.
 *      It tokenises the query, ORs each token across
 *      title / publicationTitle / shortTitle / court / year / citationKey /
 *      creator, ANDs the tokens together, and appends noChildren so child
 *      notes/attachments/annotations never appear.
 *
 *   2. Ranking (here, in JS). Zotero.Search returns bare itemIDs with no
 *      ORDER BY and no score anywhere in search.js — the IDs come back in
 *      SQLite natural order. Relevance ordering is entirely ours to produce.
 *      Zotero's own citation dialog does the same thing
 *      (integration/citationDialog/searchHandler.mjs:409-490).
 *
 * Consequence of stage 1 worth knowing: candidates always contain each query
 * token as a literal substring (SQL LIKE '%token%'), so a pure subsequence
 * query like "aiayn" for "Attention Is All You Need" can never reach the
 * ranker. Matching is per-word substring, AND-ed across words. See README.
 */

var ZQS_Engine = {
	/** Below this many characters we don't search at all: LIKE '%a%' matches nearly everything. */
	MIN_QUERY_LENGTH: 2,

	/** Hard ceiling on how many candidates we will load and rank in one pass. */
	RANK_CAP: 5000,

	/** Field weights. Title dominates; everything else is supporting evidence. */
	WEIGHTS: {
		title: 1.0,
		creators: 0.75,
		year: 0.5,
		publication: 0.45,
		shortTitle: 0.6,
		citationKey: 0.5,
	},

	_win: null,
	/** itemID -> { key, strings } cache of the lowercased fields we match against. */
	_cache: new Map(),
	_notifierID: null,

	init(win) {
		this._win = win;
		this._cache = new Map();

		// Drop cached display strings when items change underneath us.
		this._notifierID = Zotero.Notifier.registerObserver({
			notify: (event, type, ids) => {
				if (type !== 'item') return;
				if (event === 'modify' || event === 'delete' || event === 'trash') {
					for (const id of ids) this._cache.delete(Number(id));
				}
			},
		}, ['item'], 'quick-switcher');
	},

	destroy() {
		if (this._notifierID) {
			Zotero.Notifier.unregisterObserver(this._notifierID);
			this._notifierID = null;
		}
		this._cache.clear();
		this._win = null;
	},

	/* ---------------------------------------------------------------- *
	 * Query tokenising
	 * ---------------------------------------------------------------- */

	/**
	 * Split a query into lowercased tokens, keeping "quoted phrases" together.
	 * Mirrors Zotero.SearchConditions.parseSearchString (searchConditions.js:785-810)
	 * closely enough that our ranking agrees with what the DB actually matched.
	 */
	tokenize(query) {
		const tokens = [];
		const re = /"([^"]*)"|(\S+)/g;
		let m;
		while ((m = re.exec(query)) !== null) {
			const text = (m[1] !== undefined ? m[1] : m[2]).trim().toLowerCase();
			if (text) tokens.push(text);
		}
		return tokens;
	},

	/* ---------------------------------------------------------------- *
	 * Stage 1 — narrowing
	 * ---------------------------------------------------------------- */

	/**
	 * @returns {Promise<Number[]>} de-duplicated candidate itemIDs
	 */
	async findCandidateIDs(query) {
		const s = new Zotero.Search();

		// Leaving libraryID unset searches every library. That is what we want
		// for a switcher (user library + groups), except feeds, which are
		// news-like and would swamp results. Zotero's citation dialog excludes
		// them the same way (searchHandler.mjs:310).
		try {
			for (const feed of Zotero.Feeds.getAll()) {
				s.addCondition('libraryID', 'isNot', feed.libraryID);
			}
		}
		catch (e) {
			// Feeds not loaded/available — harmless, carry on unscoped.
		}

		// 'contains' is the operator the quicksearch conditions accept
		// (searchConditions.js:176-218). This single addCondition explodes into
		// the per-token blockStart/blockEnd groups plus noChildren.
		s.addCondition('quicksearch-titleCreatorYear', 'contains', query);

		const ids = await s.search();

		// search() can return duplicate itemIDs — Zotero's own local API
		// defends against this with a Set and a "TODO: Fix in search.js"
		// (server_localAPI.js:665-667).
		return [...new Set(ids)];
	},

	/* ---------------------------------------------------------------- *
	 * Field extraction
	 * ---------------------------------------------------------------- */

	/**
	 * Pull the lowercased strings we rank against, memoised per item.
	 * All accessors used here are synchronous, but they throw
	 * UnloadedDataException unless the item's data is loaded — callers must
	 * have gone through Zotero.Items.getAsync + loadDataTypes first.
	 */
	getStrings(item) {
		const cached = this._cache.get(item.id);
		if (cached) return cached;

		let creators = '';
		try {
			// getField('firstCreator', true) — unformatted, which strips the
			// Unicode bidi isolates Zotero wraps two-author strings in
			// (items.js:1492-1494).
			const first = item.getField('firstCreator', true) || '';
			const names = item.getCreators()
				.map(c => (c.lastName || '') + ' ' + (c.firstName || ''))
				.join(' ');
			creators = (first + ' ' + names).toLowerCase();
		}
		catch (e) {
			creators = '';
		}

		const safe = (field) => {
			try {
				return (item.getField(field) || '').toString().toLowerCase();
			}
			catch (e) {
				return '';
			}
		};

		const strings = {
			title: (item.getDisplayTitle() || '').toLowerCase(),
			shortTitle: safe('shortTitle'),
			creators,
			year: safe('year'),
			publication: safe('publicationTitle'),
			citationKey: safe('citationKey'),
		};

		this._cache.set(item.id, strings);
		return strings;
	},

	/* ---------------------------------------------------------------- *
	 * Stage 2 — scoring
	 * ---------------------------------------------------------------- */

	/**
	 * Score one token against one field. Returns 0..1.
	 * Tiers, strongest first: exact field, field prefix, word-start prefix,
	 * substring, subsequence.
	 */
	scoreToken(token, field) {
		if (!field || !token) return 0;

		if (field === token) return 1.0;
		if (field.startsWith(token)) return 0.9;

		const idx = field.indexOf(token);
		if (idx !== -1) {
			// Does it start a word? Much stronger signal than a mid-word hit.
			const prev = field.charAt(idx - 1);
			if (idx === 0 || /[\s\-–—_/:,.()[\]"']/.test(prev)) return 0.75;
			return 0.5;
		}

		return this._subsequenceScore(token, field);
	},

	/**
	 * Fuzzy fallback: are the token's characters present in order?
	 * Scored by how tightly packed the match is, capped well below a real
	 * substring hit. Rarely decisive given stage 1 already required a
	 * substring somewhere, but it breaks ties sensibly across fields.
	 */
	_subsequenceScore(token, field) {
		if (token.length > 32 || field.length > 400) return 0;

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
		const density = token.length / span; // 1.0 == contiguous
		return 0.25 * density;
	},

	/**
	 * Relevance for one item against the tokenised query.
	 * Returns { score, matchedTitle } — score of 0 means "don't show".
	 */
	scoreItem(item, tokens, rawQuery) {
		const s = this.getStrings(item);
		const W = this.WEIGHTS;

		let total = 0;
		let allTokensInTitle = true;

		for (const token of tokens) {
			const perField = [
				W.title * this.scoreToken(token, s.title),
				W.shortTitle * this.scoreToken(token, s.shortTitle),
				W.creators * this.scoreToken(token, s.creators),
				W.year * this.scoreToken(token, s.year),
				W.publication * this.scoreToken(token, s.publication),
				W.citationKey * this.scoreToken(token, s.citationKey),
			];

			const best = Math.max(...perField);
			if (best <= 0) {
				// Matched in the DB via a field we don't rank on. Keep it, but
				// far down — never drop a result the user can see is valid.
				total += 0.01;
				allTokensInTitle = false;
				continue;
			}
			if (this.scoreToken(token, s.title) <= 0) allTokensInTitle = false;
			total += best;
		}

		let score = total / tokens.length;

		// Whole-query bonuses. These are what make the obviously-right paper
		// sit at the top instead of merely in the list.
		const q = rawQuery.trim().toLowerCase();
		if (q) {
			if (s.title === q) score += 0.60;
			else if (s.title.startsWith(q)) score += 0.30;
			else if (s.title.includes(q)) score += 0.18;
		}
		if (allTokensInTitle) score += 0.12;

		// Gentle preference for concise titles, so a short exact-ish match
		// outranks a long title that happens to contain the same words.
		score += 0.04 / (1 + Math.log(1 + s.title.length / 60));

		return { score, matchedTitle: allTokensInTitle };
	},

	/* ---------------------------------------------------------------- *
	 * Public entry point
	 * ---------------------------------------------------------------- */

	/**
	 * @param {String} query
	 * @param {Object} [options]
	 * @param {Number} [options.limit] max results to return
	 * @returns {Promise<{ results: Array<{item, score}>, truncated: Boolean }>}
	 */
	async search(query, { limit = 50 } = {}) {
		const trimmed = (query || '').trim();
		if (trimmed.length < this.MIN_QUERY_LENGTH) {
			return { results: [], truncated: false };
		}

		const tokens = this.tokenize(trimmed);
		if (!tokens.length) return { results: [], truncated: false };

		let ids = await this.findCandidateIDs(trimmed);
		const truncated = ids.length > this.RANK_CAP;
		if (truncated) {
			Zotero.debug(`[quick-switcher] ${ids.length} candidates, ranking first ${this.RANK_CAP}`);
			ids = ids.slice(0, this.RANK_CAP);
		}
		if (!ids.length) return { results: [], truncated: false };

		// getAsync loads anything not already cached; loadDataTypes then bulk-loads
		// the itemData/creators we need in one pass rather than per-item lazily.
		// Without this, getField()/getCreators() throw UnloadedDataException for
		// items from a library that hasn't been fully loaded (e.g. a group).
		let items = await Zotero.Items.getAsync(ids);
		items = items.filter(Boolean);
		try {
			await Zotero.Items.loadDataTypes(items);
		}
		catch (e) {
			Zotero.debug('[quick-switcher] loadDataTypes failed: ' + e);
		}

		const scored = [];
		for (const item of items) {
			// noChildren already excludes child notes/attachments, but standalone
			// notes and attachments still pass. A switcher is for papers.
			if (!item.isRegularItem()) continue;
			if (item.deleted) continue;

			const { score } = this.scoreItem(item, tokens, trimmed);
			if (score > 0) scored.push({ item, score });
		}

		scored.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			// Stable, meaningful tiebreak: most recently modified first.
			const am = a.item.dateModified || '';
			const bm = b.item.dateModified || '';
			if (am !== bm) return bm < am ? -1 : 1;
			return a.item.id - b.item.id;
		});

		return { results: scored.slice(0, limit), truncated };
	},
};
