// Shared test scaffolding: a fake Zotero whose DB answers the engine's two
// queries, so the real engine.js can be exercised without Zotero installed.
const fs = require('fs');
const vm = require('vm');

const ENGINE = __dirname + '/../src/engine.js';
const OVERLAY = __dirname + '/../src/overlay.js';

/**
 * @param {Array} papers [{id, key?, lib?, title, creators:[[first,last]], year, pub, dateModified?}]
 */
function makeZotero(papers = [], opts = {}) {
	const itemRows = papers.map((p, n) => ({
		itemID: p.id,
		libraryID: p.lib === undefined ? 1 : p.lib,
		key: p.key || ('KEY' + String(p.id).padStart(5, '0')),
		dateModified: p.dateModified || ('2026-01-' + String((n % 28) + 1).padStart(2, '0')),
		title: p.title,
		pub: p.pub || null,
		date: p.year ? p.year + '-01-01' : null,
	}));
	const creatorRows = papers
		.filter(p => p.creators && p.creators.length)
		.map(p => ({
			itemID: p.id,
			names: p.creators.map(([f, l]) => l + ' ' + f).join(' '),
			surnames: p.creators.map(([, l]) => l).join('\x1f'),
		}));

	const items = new Map();
	for (const p of papers) {
		items.set(p.id, {
			id: p.id,
			key: p.key || ('KEY' + String(p.id).padStart(5, '0')),
			libraryID: p.lib === undefined ? 1 : p.lib,
			deleted: false,
			isRegularItem: () => true,
			isAttachment: () => false,
			getAttachments: () => p.attachments || [],
			getDisplayTitle: () => p.title,
			getField(f) {
				if (f === 'firstCreator') return p.creators && p.creators.length ? p.creators[0][1] : '';
				if (f === 'year') return p.year || '';
				if (f === 'publicationTitle') return p.pub || '';
				return '';
			},
		});
	}

	const Zotero = {
		isMac: true,
		debug() {}, logError(e) { (Zotero._errors ||= []).push(String(e)); },
		_errors: [],
		DB: {
			_calls: 0,
			async queryAsync(sql) {
				Zotero.DB._calls++;
				if (opts.failDB) throw new Error('no such table: itemDataValues');
				return /itemCreators/.test(sql) ? creatorRows : itemRows;
			},
		},
		Notifier: {
			_n: 0, _observers: new Map(),
			registerObserver(ref) {
				const id = 'obs' + (++Zotero.Notifier._n);
				Zotero.Notifier._observers.set(id, ref);
				return id;
			},
			unregisterObserver(id) { Zotero.Notifier._observers.delete(id); },
			fire(event, type) {
				for (const o of Zotero.Notifier._observers.values()) o.notify(event, type, []);
			},
		},
		Feeds: { getAll: () => opts.feeds || [] },
		Libraries: {
			userLibraryID: 1,
			get: id => ({ libraryID: id, name: id === 1 ? 'My Library' : 'Shared Group ' + id }),
		},
		Items: {
			get: id => items.get(id) || null,
			async getAsync(ids) {
				return (Array.isArray(ids) ? ids : [ids]).map(i => items.get(i)).filter(Boolean);
			},
		},
		Prefs: { get: () => undefined },
		File: { getResourceAsync: async () => '/* css */' },
		Reader: { open: async () => undefined },
	};
	return { Zotero, items };
}

/** A window stub with controllable timers, so tests drive the event loop. */
function makeWin(Zotero) {
	let timers = [], next = 1;
	const win = {
		Zotero_Tabs: { getTabIDByItemID: () => null },
		Services: { focus: { activeWindow: null } },
		setTimeout(fn) { const id = next++; timers.push({ id, fn }); return id; },
		clearTimeout(id) { timers = timers.filter(t => t.id !== id); },
		addEventListener() {}, removeEventListener() {},
		_flush() { const t = timers; timers = []; for (const x of t) x.fn(); return t.length; },
		_pending: () => timers.length,
	};
	return win;
}

function loadEngine(Zotero) {
	const ctx = { Zotero, Math, JSON, console, Object, Date, Number, String, Array, Set, Map, Promise, Error };
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(ENGINE, 'utf8'), ctx, { filename: 'engine.js' });
	return ctx.ZQS_Engine;
}

/** Build the index, draining the engine's chunk yields. */
async function buildIndex(E, win) {
	const p = E.ensureIndex();
	for (let i = 0; i < 400; i++) {
		await Promise.resolve();
		if (win._pending()) win._flush();
	}
	return p;
}

/** Run a search to completion, draining chunk yields. */
async function search(E, win, q, opts) {
	const p = E.search(q, opts);
	for (let i = 0; i < 600; i++) {
		await Promise.resolve();
		if (win._pending()) win._flush();
	}
	return p;
}

module.exports = { makeZotero, makeWin, loadEngine, buildIndex, search, ENGINE, OVERLAY };
