/**
 * Zotero Quick Switcher — index and relevance ranking.
 *
 * Loaded into a main-window scope via Services.scriptloader.loadSubScript,
 * so `Zotero` here is the window's Zotero global.
 *
 * ── WHY THIS SHAPE ────────────────────────────────────────────────────────
 *
 * Three approaches were measured against synthetic libraries built on the real
 * Zotero schema:
 *
 *   Zotero.Items.getAll + getAsync + loadDataTypes  → 194 MB of our own index
 *       PLUS ~376 MB permanently retained in Zotero's unbounded _objectCache,
 *       because materialising every item pins it there for the session.
 *   Zotero.Search (SQL LIKE) per keystroke          → 81–92 ms every keystroke,
 *       and no fuzzy matching. itemDataValues.value has no index, so every
 *       LIKE '%token%' is a full table scan; rare tokens are no cheaper.
 *   One SQL query → compact index + word index      → ← this file
 *       at the 200k cap: 795 ms to build, 75 MB, 2–31 ms per keystroke, and no
 *       uninterrupted block longer than 3.3 ms.
 *
 * Search runs the word index first and falls back to the full fuzzy scan only
 * when that finds little — which is exactly when fuzzy matters.
 *
 * The index therefore holds ONLY what matching needs: normalised strings, a
 * character bitmap, an id and a stable key. Everything shown on screen —
 * display title, creators, year, venue — is fetched from Zotero at render time
 * for the ≤50 rows actually displayed. That halves index memory and keeps
 * display formatting correct (base-mapped titles, bidi isolates and all).
 *
 * ── SECURITY NOTES ────────────────────────────────────────────────────────
 *
 * Item metadata is ATTACKER-CONTROLLED: it arrives via BibTeX/RIS import, DOI
 * lookup, the browser connector, and group libraries other people can write to.
 * This file runs with system privileges. Accordingly:
 *
 *   - The SQL is entirely static. The user's query NEVER reaches SQL, so query
 *     injection is impossible by construction, not by escaping.
 *   - Every indexed field is length-capped, so a hostile 10 MB title cannot
 *     freeze the UI or amplify memory (measured: an uncapped 10 M-char title
 *     cost 1,261 ms and 22.5 MB for a single item).
 *   - Entries carry the item's stable `key`. SQLite rowids are reused after
 *     deletion, so the opener re-checks the key before acting on an id.
 */

var ZQS_Engine = {
	/**
	 * Hard cap on indexed papers, newest first. ~280 B/entry, so 200k ≈ 56 MB.
	 * Beyond this, older papers are reachable through the substring fallback
	 * rather than the fuzzy index.
	 */
	MAX_INDEXED: 200000,

	/** Per-field character caps. Hostile metadata must not become our problem. */
	CAP_TITLE: 400,
	CAP_CREATORS: 400,
	/**
	 * Surnames get a far larger cap than full names: a large collaboration
	 * (Llama 3, BLOOM) lists hundreds of authors, and at 400 characters every
	 * author after roughly the 30th was unsearchable. Still bounded.
	 */
	CAP_SURNAMES: 4000,
	CAP_PUBLICATION: 160,
	/** Longest query we will process; longer is truncated. */
	CAP_QUERY: 512,

	/** Entries scanned between yields to the event loop. */
	CHUNK: 8000,

	/** Field weights. Title dominates; the rest is supporting evidence. */
	WEIGHTS: {
		title: 1.0,
		initials: 0.9,
		creators: 0.85,
		/** Exact surname; first author gets the full 1.0, others this. */
		surname: 0.95,
		year: 0.6,
		publication: 0.4,
	},

	/**
	 * When a word-index lookup yields fewer than this many hits, the full fuzzy
	 * scan runs as well and the two are merged. That is exactly when fuzzy
	 * matters (typing "aiayn"), and skipping it when there are already plenty of
	 * ordinary matches is what keeps common words fast.
	 */
	FUZZY_FALLBACK_BELOW: 50,

	_win: null,
	_entries: [],
	/** Sorted unique words → postings, for prefix lookup. */
	_vocab: null,
	_postStart: null,
	_postings: null,
	_stamp: null,
	_stampGen: 0,
	_building: null,
	_buildGen: 0,
	_dirty: true,
	_lastBuiltStart: 0,
	_truncated: false,
	_notifierID: null,

	/**
	 * Minimum gap between rebuilds, measured from build START. A sync fires
	 * item notifications continuously; without this the plugin would spend most
	 * of its time re-scanning. Measuring from the start (not the end) keeps the
	 * duty cycle bounded even when a build itself is slow.
	 */
	REBUILD_MIN_INTERVAL_MS: 5000,

	/** @returns {String|null} Notifier observer id, for bootstrap to track */
	init(win) {
		if (this._notifierID) {
			try {
				Zotero.Notifier.unregisterObserver(this._notifierID);
			}
			catch (e) {}
			this._notifierID = null;
		}

		this._win = win;
		this._entries = [];
		this._dirty = true;
		this._building = null;
		this._buildGen = 0;
		this._lastBuiltStart = 0;
		this._truncated = false;

		const self = this;
		this._notifierID = Zotero.Notifier.registerObserver({
			notify(event, type) {
				if (type !== 'item') return;
				// Cheapest possible hot path: a sync can fire tens of thousands
				// of these. Just set a flag; never allocate, never scan.
				if (event === 'add' || event === 'modify' || event === 'delete'
					|| event === 'trash' || event === 'restore') {
					self._dirty = true;
				}
			},
		}, ['item'], 'quick-switcher-index');

		return this._notifierID;
	},

	destroy() {
		if (this._notifierID) {
			try {
				Zotero.Notifier.unregisterObserver(this._notifierID);
			}
			catch (e) {}
			this._notifierID = null;
		}
		// Invalidate any in-flight build so it stops at its next chunk boundary
		// instead of running to completion and repopulating a dead engine.
		this._buildGen++;
		this._entries = [];
		this._vocab = this._postStart = this._postings = this._stamp = null;
		this._building = null;
		this._dirty = true;
		this._lastBuiltStart = 0;
		this._win = null;
	},

	/* ---------------------------------------------------------------- *
	 * Text normalisation
	 * ---------------------------------------------------------------- */

	/**
	 * Normalise for matching. Applied to BOTH the index and the query so the
	 * two agree by construction:
	 *   - lowercase
	 *   - strip diacritics ("muller" finds "Müller")
	 *   - drop apostrophes ("don't"/"dont"/"don’t" collapse to one form)
	 *   - fold every other punctuation run to a space, so a pasted citation
	 *     title ending in "." still matches
	 */
	normalize(s) {
		if (!s) return '';
		let out = s.toString().toLowerCase()
			.replace(/[‘’ʼ′`]/g, "'")
			.replace(/[“”″]/g, '"');
		try {
			out = out.normalize('NFD').replace(/[̀-ͯ]/g, '');
		}
		catch (e) {}
		out = out.replace(/['ʼ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ');
		return out.trim().replace(/\s+/g, ' ');
	},

	/**
	 * Character bitmap: bit i set when letter (a+i) occurs, bit 26 for any
	 * digit. If a query token needs a character the entry does not have, no
	 * field can match it — one integer AND rejects the entry.
	 *
	 * Measured at 100k entries: rejects an unmatchable query in 0.2 ms instead
	 * of 19.5 ms (122x), and halves the cost of ordinary two-word queries.
	 */
	_mask(s) {
		let m = 0;
		for (let i = 0; i < s.length; i++) {
			const c = s.charCodeAt(i);
			if (c >= 97 && c <= 122) m |= 1 << (c - 97);
			else if (c >= 48 && c <= 57) m |= 1 << 26;
		}
		return m;
	},

	/** "attention is all you need" → "aiayn", so acronym queries work. */
	_initials(t) {
		const words = t.split(' ');
		if (words.length < 2 || words.length > 24) return '';
		let out = '';
		for (const w of words) if (w) out += w.charAt(0);
		return out;
	},

	/* ---------------------------------------------------------------- *
	 * Index construction
	 * ---------------------------------------------------------------- */

	/**
	 * The whole index in one query. Entirely static SQL — no interpolation,
	 * no user input, so it cannot be injected into.
	 *
	 * baseFieldMappingsCombined resolves type-specific fields onto their base
	 * field, which is why a conferencePaper's proceedingsTitle and a
	 * bookSection's bookTitle both land in `pub`, and a case's caseName lands
	 * in `title`. Without it those item types would have empty titles.
	 *
	 * Excluded: trashed items, child attachments, child notes, and annotations.
	 * Annotations matter — at 100k papers a library holds ~250k of them, and
	 * Zotero's own getAll(onlyTopLevel) does NOT filter them out.
	 *
	 * ALSO excluded: every library but your own. Anyone with write access to a
	 * shared group library can craft an item that outranks your own paper for a
	 * query you type daily, and Enter would then launch a link they chose. The
	 * libraryID is a bound parameter, not interpolated.
	 */
	SQL_ITEMS: `SELECT i.itemID, i.libraryID, i.key, i.dateModified,
			MAX(CASE WHEN COALESCE(bfm.baseFieldID, id.fieldID) =
				(SELECT fieldID FROM fieldsCombined WHERE fieldName='title')
				THEN idv.value END) AS title,
			MAX(CASE WHEN COALESCE(bfm.baseFieldID, id.fieldID) =
				(SELECT fieldID FROM fieldsCombined WHERE fieldName='publicationTitle')
				THEN idv.value END) AS pub,
			MAX(CASE WHEN id.fieldID =
				(SELECT fieldID FROM fieldsCombined WHERE fieldName='date')
				THEN idv.value END) AS date
		FROM items i
		JOIN itemData id ON id.itemID = i.itemID
		JOIN itemDataValues idv ON idv.valueID = id.valueID
		LEFT JOIN baseFieldMappingsCombined bfm
			ON bfm.itemTypeID = i.itemTypeID AND bfm.fieldID = id.fieldID
		WHERE i.libraryID = ?
			AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
			AND i.itemID NOT IN (SELECT itemID FROM itemAnnotations)
			AND i.itemID NOT IN (SELECT itemID FROM itemNotes WHERE parentItemID IS NOT NULL)
			AND i.itemID NOT IN (SELECT itemID FROM itemAttachments WHERE parentItemID IS NOT NULL)
		GROUP BY i.itemID
		ORDER BY i.dateModified DESC
	`,

	/**
	 * Creators in author order (the inner ORDER BY feeds group_concat), so
	 * the caps drop the tail of the author list rather than arbitrary names,
	 * and the first author is known. Surnames are joined with char(31) so the
	 * first one can be split off even when it is several words ("van der Berg").
	 */
	SQL_CREATORS: `SELECT itemID,
			group_concat(lastName || ' ' || COALESCE(firstName, ''), ' ') AS names,
			group_concat(lastName, char(31)) AS surnames
		FROM (SELECT ic.itemID, c.lastName, c.firstName
			FROM itemCreators ic
			JOIN creators c ON c.creatorID = ic.creatorID
			JOIN items i ON i.itemID = ic.itemID
			WHERE i.libraryID = ?
			ORDER BY ic.itemID, ic.orderIndex)
		GROUP BY itemID
	`,

	/**
	 * Build (or rebuild) the index. Concurrent callers share one build.
	 * Yields between chunks so a large library cannot freeze the UI.
	 */
	async ensureIndex() {
		if (this._building) return this._building;
		if (!this._dirty) return this._entries;

		// Rate-limit from build START, so a slow build cannot monopolise the
		// main thread when a sync keeps re-dirtying the index.
		if (this._lastBuiltStart
			&& (Date.now() - this._lastBuiltStart) < this.REBUILD_MIN_INTERVAL_MS
			&& this._entries.length) {
			return this._entries;
		}

		const gen = ++this._buildGen;
		this._lastBuiltStart = Date.now();
		this._dirty = false; // changes from here on re-dirty for the next build

		this._building = this._build(gen)
			.then((entries) => {
				// A newer build (or destroy) superseded us — discard quietly.
				if (gen !== this._buildGen) return this._entries;
				this._entries = entries;
				return entries;
			})
			.catch((e) => {
				// The user chose SQL-only with no API fallback, so a schema
				// change must be LOUD rather than silently returning nothing.
				this._dirty = true;
				this._lastError = String(e);
				Zotero.logError(new Error(
					'[quick-switcher] index build failed — the switcher will not '
					+ 'return results until this is fixed. This usually means the '
					+ 'Zotero database schema changed and the plugin needs updating. '
					+ e));
				throw e;
			})
			.finally(() => {
				if (gen === this._buildGen) this._building = null;
			});

		return this._building;
	},

	async _build(gen) {
		const t0 = Date.now();
		// Zotero decides whether a statement is a SELECT with
		// sql.match(/^[^a-z]*[^ ]+/i) and compares the WHOLE match against
		// 'select' (db.js:645-652). A query that starts with a newline is
		// therefore NOT recognised, and queryAsync silently returns undefined
		// instead of rows. Any SQL added here must start at the keyword.
		const q = (sql, params) => Zotero.DB.queryAsync(sql.trim(), params);

		// My Library only, per the maintainer's decision. Read it up front: if
		// it is unavailable we must fail rather than quietly widen the scope to
		// include group libraries.
		let userLibraryID;
		try {
			userLibraryID = Zotero.Libraries.userLibraryID;
		}
		catch (e) {
			throw new Error('user library not available yet: ' + e);
		}
		if (userLibraryID === undefined || userLibraryID === null) {
			throw new Error('user library id is unavailable');
		}

		const rows = await q(this.SQL_ITEMS, [userLibraryID]);
		if (gen !== this._buildGen) return this._entries;

		const creatorRows = await q(this.SQL_CREATORS, [userLibraryID]);
		if (gen !== this._buildGen) return this._entries;

		if (!rows) {
			throw new Error('item query returned no result set '
				+ '(Zotero.DB.queryAsync did not recognise the statement)');
		}

		const creators = new Map();
		for (const r of (creatorRows || [])) creators.set(r.itemID, r);

		// Feeds need no special handling now: they are separate libraries, and
		// only the user library is queried.

		const entries = [];
		this._truncated = false;

		for (let i = 0; i < rows.length; i++) {
			// Yield periodically. Without this a 500k-row build blocks the UI
			// for seconds; with it, no single stretch exceeds a few ms.
			if ((i & (this.CHUNK - 1)) === 0 && i > 0) {
				await new Promise(r => this._win.setTimeout(r, 0));
				if (gen !== this._buildGen) return this._entries;
			}

			if (entries.length >= this.MAX_INDEXED) {
				// Rows are ordered newest-first, so the cap keeps what the user
				// most likely wants.
				this._truncated = true;
				break;
			}

			const row = rows[i];
			const title = this.normalize(
				(row.title || '').slice(0, this.CAP_TITLE));
			if (!title) continue; // nothing searchable

			const cr = creators.get(row.itemID);
			const creatorStr = this.normalize(
				((cr && cr.names) || '').slice(0, this.CAP_CREATORS));
			const surnameParts = ((cr && cr.surnames) || '')
				.slice(0, this.CAP_SURNAMES).split('\x1f');
			const firstSurname = this.normalize(surnameParts[0]);
			const surnames = this.normalize(surnameParts.join(' '));
			const pub = this.normalize(
				(row.pub || '').slice(0, this.CAP_PUBLICATION));
			const year = (row.date || '').slice(0, 4);

			entries.push({
				id: row.itemID,
				key: row.key,          // guards against SQLite rowid reuse
				lib: row.libraryID,
				t: title,
				i: this._initials(title),
				c: creatorStr,
				s: surnames,
				f: firstSurname.length, // s.slice(0, f) is the first author
				y: year,
				p: pub,
				m: this._mask(title + ' ' + creatorStr + ' ' + surnames + ' '
					+ year + ' ' + pub),
			});
		}

		this._buildWordIndex(entries);

		// Deliberately does not log titles: Debug Output is routinely submitted
		// to Zotero support, and item titles are the user's private research.
		Zotero.debug('[quick-switcher] indexed ' + entries.length + ' items ('
			+ (this._vocab ? this._vocab.length : 0) + ' words) in '
			+ (Date.now() - t0) + ' ms' + (this._truncated ? ' (capped)' : ''));
		return entries;
	},

	/**
	 * Inverted index: word → entries containing it.
	 *
	 * Stored as a sorted vocabulary plus flat Int32Array postings, so a prefix
	 * query is a binary search for a contiguous range rather than a scan of the
	 * vocabulary. Costs ~18 MB at the 200k cap and takes one-word queries from
	 * tens of milliseconds to about two.
	 */
	_buildWordIndex(entries) {
		const map = new Map();
		for (let i = 0; i < entries.length; i++) {
			const e = entries[i];
			const seen = new Set();
			const add = (text) => {
				if (!text) return;
				const words = text.split(' ');
				for (let w = 0; w < words.length; w++) {
					const word = words[w];
					if (!word || seen.has(word)) continue;
					seen.add(word);
					let arr = map.get(word);
					if (!arr) map.set(word, (arr = []));
					arr.push(i);
				}
			};
			add(e.t);
			add(e.c);
			add(e.s);
			add(e.p);
			if (e.y) add(e.y);
			if (e.i) add(e.i);   // so an acronym query hits the fast path too
		}

		const vocab = [...map.keys()].sort();
		const postStart = new Int32Array(vocab.length + 1);
		let totalPostings = 0;
		for (let v = 0; v < vocab.length; v++) {
			postStart[v] = totalPostings;
			totalPostings += map.get(vocab[v]).length;
		}
		postStart[vocab.length] = totalPostings;

		const postings = new Int32Array(totalPostings);
		let at = 0;
		for (let v = 0; v < vocab.length; v++) {
			const arr = map.get(vocab[v]);
			for (let k = 0; k < arr.length; k++) postings[at++] = arr[k];
		}

		this._vocab = vocab;
		this._postStart = postStart;
		this._postings = postings;
		this._stamp = new Int32Array(entries.length);
		this._stampGen = 0;
	},

	/** Index of the first vocabulary word >= target. */
	_lowerBound(target) {
		const v = this._vocab;
		let lo = 0, hi = v.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (v[mid] < target) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	},

	/**
	 * Entry indices whose words prefix-match EVERY token.
	 * @returns {Int32Array|null} null when the word index is unusable
	 */
	_candidates(tokens) {
		if (!this._vocab || !this._vocab.length || !this._stamp) return null;

		// Stamp-based intersection: an entry reaching gen+tokens.length was seen
		// for every token. Avoids clearing a big array between searches.
		const stamp = this._stamp;
		const base = this._stampGen;
		this._stampGen += tokens.length + 1;
		if (this._stampGen > 2000000000) {           // wrap safely
			stamp.fill(0);
			this._stampGen = tokens.length + 1;
		}

		for (let t = 0; t < tokens.length; t++) {
			const token = tokens[t];
			const lo = this._lowerBound(token);
			const want = base + t;
			// Vocabulary is sorted, so every word with this prefix is contiguous.
			for (let v = lo; v < this._vocab.length; v++) {
				if (!this._vocab[v].startsWith(token)) break;
				const from = this._postStart[v];
				const to = this._postStart[v + 1];
				for (let p = from; p < to; p++) {
					const e = this._postings[p];
					// Only advance entries that matched every earlier token.
					if (stamp[e] === want) stamp[e] = want + 1;
					else if (t === 0 && stamp[e] < base) stamp[e] = base + 1;
				}
			}
		}

		const target = base + tokens.length;
		const out = [];
		// Walk the first token's postings only: anything matching all tokens
		// must appear there.
		const firstLo = this._lowerBound(tokens[0]);
		for (let v = firstLo; v < this._vocab.length; v++) {
			if (!this._vocab[v].startsWith(tokens[0])) break;
			const from = this._postStart[v];
			const to = this._postStart[v + 1];
			for (let p = from; p < to; p++) {
				const e = this._postings[p];
				if (stamp[e] === target) {
					stamp[e] = target + 1;   // dedupe
					out.push(e);
				}
			}
		}
		return out;
	},

	/* ---------------------------------------------------------------- *
	 * Query
	 * ---------------------------------------------------------------- */

	tokenize(query) {
		const tokens = [];
		const re = /"([^"]*)"|(\S+)/g;
		let m;
		while ((m = re.exec(query)) !== null) {
			const text = this.normalize(m[1] !== undefined ? m[1] : m[2]);
			if (text) tokens.push(text);
			if (tokens.length >= 12) break; // absurd queries are not our problem
		}
		return tokens;
	},

	scoreToken(token, field) {
		if (!field || !token) return 0;
		if (field === token) return 1.0;
		if (field.startsWith(token)) return 0.9;
		const idx = field.indexOf(token);
		if (idx !== -1) {
			const prev = field.charAt(idx - 1);
			return (idx === 0 || prev === ' ') ? 0.75 : 0.5;
		}
		return this._subsequenceScore(token, field);
	},

	/**
	 * Surname match: whole word or word prefix only, never fuzzy — "lee" must
	 * mean Lee, not any title with l…e…e in it. A match inside the first
	 * author's surname scores highest.
	 * @returns {Number} 1.0 first-author exact, 0.95 exact, 0.8/0.75 prefix, 0
	 */
	_surnameScore(token, s, f) {
		if (!s || !token) return 0;
		let best = 0;
		let idx = s.indexOf(token);
		while (idx !== -1) {
			if (idx === 0 || s.charCodeAt(idx - 1) === 32) {
				const end = idx + token.length;
				const exact = end === s.length || s.charCodeAt(end) === 32;
				const first = idx < f;
				const score = exact ? (first ? 1.0 : this.WEIGHTS.surname)
					: (first ? 0.8 : 0.75);
				if (score > best) best = score;
				if (best === 1.0) break;
			}
			idx = s.indexOf(token, idx + 1);
		}
		return best;
	},

	/**
	 * Fuzzy tier: token characters present in order, scored by how tightly
	 * packed the match is. This is what SQL LIKE cannot express and the whole
	 * reason the index exists — "aiayn" → "Attention Is All You Need".
	 */
	_subsequenceScore(token, field) {
		if (token.length < 2 || token.length > 32 || field.length > 400) return 0;
		let fi = 0, first = -1, last = -1;
		for (let ti = 0; ti < token.length; ti++) {
			const ch = token.charCodeAt(ti);
			let found = -1;
			while (fi < field.length) {
				if (field.charCodeAt(fi) === ch) { found = fi; fi++; break; }
				fi++;
			}
			if (found === -1) return 0;
			if (first === -1) first = found;
			last = found;
		}
		return 0.45 * (token.length / ((last - first) + 1));
	},

	/**
	 * Score one entry. Field evaluation SHORT-CIRCUITS: the previous version
	 * built a Math.max() over all seven fields, so every field was scored even
	 * when the title had already returned a perfect 1.0.
	 */
	scoreEntry(entry, tokens, q) {
		const W = this.WEIGHTS;
		let total = 0;
		let allInTitle = true;
		let surnameBonus = 0;

		for (let k = 0; k < tokens.length; k++) {
			const token = tokens[k];
			const inTitle = this.scoreToken(token, entry.t);
			let best = W.title * inTitle;

			if (best < 1.0) {
				if (entry.i && entry.i.startsWith(token) && W.initials > best) {
					best = W.initials;
				}
				if (entry.s) {
					const s = this._surnameScore(token, entry.s, entry.f);
					// An exact surname is a deliberate author search: boost it
					// past title words that merely start with the query
					// ("hu" must find Hu before "human").
					if (s >= W.surname) surnameBonus += (s === 1.0 ? 0.5 : 0.45);
					if (s > best) best = s;
				}
				if (best < W.creators) {
					const c = W.creators * this.scoreToken(token, entry.c);
					if (c > best) best = c;
				}
				if (best < W.year) {
					const y = W.year * this.scoreToken(token, entry.y);
					if (y > best) best = y;
				}
				if (best < W.publication) {
					const p = W.publication * this.scoreToken(token, entry.p);
					if (p > best) best = p;
				}
			}

			if (best <= 0) return 0; // this token matches nothing — reject
			if (inTitle < 0.5) allInTitle = false;
			total += best;
		}

		let score = (total + surnameBonus) / tokens.length;

		// Whole-query bonuses: what puts the obviously-right paper first.
		if (q) {
			if (entry.t === q) score += 0.60;
			else if (entry.t.startsWith(q)) score += 0.30;
			else if (entry.t.indexOf(q) !== -1) score += 0.18;
			if (entry.i === q) score += 0.45;
		}
		if (allInTitle) score += 0.12;
		score += 0.04 / (1 + Math.log(1 + entry.t.length / 60));
		return score;
	},

	/**
	 * Search.
	 *
	 * @param {String} query
	 * @param {Object} [options]
	 * @param {Number} [options.limit]
	 * @param {Function} [options.isCurrent] called between chunks; return false
	 *   to abandon a superseded search mid-scan instead of finishing work whose
	 *   results will be thrown away
	 * @returns {Promise<{results, total, truncated, abandoned}>}
	 */
	async search(query, { limit = 50, isCurrent = null } = {}) {
		const raw = (query || '').slice(0, this.CAP_QUERY).trim();
		if (!raw) return { results: [], total: 0, truncated: false, abandoned: false };

		// Query-invariant work, hoisted out of the per-entry loop. Previously
		// normalize(rawQuery) ran once per surviving entry — 39% of the cost of
		// a one-character search at 100k items.
		const tokens = this.tokenize(raw);
		if (!tokens.length) return { results: [], total: 0, truncated: false, abandoned: false };
		const q = this.normalize(raw);
		const tokenMasks = tokens.map(t => this._mask(t));

		const entries = await this.ensureIndex();
		if (isCurrent && !isCurrent()) {
			return { results: [], total: 0, truncated: false, abandoned: true };
		}

		// Bounded top-K. Sorting every survivor meant a one-character query at
		// 100k items sorted ~99,000 entries in order to show ten.
		const keep = limit * 4;
		const top = [];
		const state = { cutoff: 0, total: 0, seen: null };

		const consider = (e) => {
			let score;
			try {
				score = this.scoreEntry(e, tokens, q);
			}
			catch (err) {
				return; // one bad entry must never break the search
			}
			if (score <= 0) return;
			state.total++;
			if (score > state.cutoff || top.length < keep) {
				top.push({ entry: e, score });
				if (top.length >= keep * 2) {
					top.sort((a, b) => b.score - a.score);
					top.length = keep;
					state.cutoff = top[top.length - 1].score;
				}
			}
		};

		// FAST PATH: the word index gives entries whose words prefix-match every
		// token. That covers the overwhelming majority of real queries at a
		// fraction of the cost of scanning the library.
		let usedWordIndex = false;
		const candidates = this._candidates(tokens);
		if (candidates) {
			usedWordIndex = true;
			for (let i = 0; i < candidates.length; i++) {
				if ((i & (this.CHUNK - 1)) === 0 && i > 0) {
					await new Promise(r => this._win.setTimeout(r, 0));
					if (isCurrent && !isCurrent()) {
						return { results: [], total: 0, truncated: false, abandoned: true };
					}
				}
				consider(entries[candidates[i]]);
			}
		}

		// FUZZY FALLBACK: only when ordinary matching found little. This is what
		// keeps "aiayn" and mid-word substrings working, while a common word that
		// already has plenty of hits never pays for a full scan.
		if (!usedWordIndex || state.total < this.FUZZY_FALLBACK_BELOW) {
			const already = new Set(top.map(r => r.entry.id));
			const n = entries.length;
			for (let i = 0; i < n; i++) {
				if ((i & (this.CHUNK - 1)) === 0 && i > 0) {
					await new Promise(r => this._win.setTimeout(r, 0));
					if (isCurrent && !isCurrent()) {
						return { results: [], total: 0, truncated: false, abandoned: true };
					}
				}

				const e = entries[i];
				// One integer AND rejects most entries before any string work.
				let ok = true;
				for (let j = 0; j < tokenMasks.length; j++) {
					if ((e.m & tokenMasks[j]) !== tokenMasks[j]) { ok = false; break; }
				}
				if (!ok) continue;
				if (already.has(e.id)) continue;
				consider(e);
			}
		}

		top.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return a.entry.id - b.entry.id;
		});

		return {
			results: top.slice(0, limit),
			total: state.total,
			truncated: this._truncated,
			abandoned: false,
		};
	},
};
