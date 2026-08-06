// Targeted tests for the fixes made after review 1:
//  - tokenize keeps interior apostrophes, strips only outer quotes
//  - curly/straight quote normalization on both sides
//  - hotkey named keys (alt+space) and the Dvorak double-bind
const fs = require('fs');
const vm = require('vm');

let pass = 0, total = 0;
const check = (name, cond, detail = '') => {
	total++; if (cond) { pass++; console.log(`PASS  ${name}`); }
	else console.log(`FAIL  ${name}   ${detail}`);
};

// ---------- engine ----------
const Zotero = {
	isMac: true, debug() {}, logError() {},
	Notifier: { registerObserver: () => 'o', unregisterObserver() {} },
	Items: { get: () => null }, Libraries: { getAll: () => [] },
	Prefs: { get: () => undefined },
};
const ectx = { Zotero, Math, JSON, console, Object };
vm.createContext(ectx);
vm.runInContext(fs.readFileSync(__dirname + '/../src/engine.js', 'utf8'), ectx, { filename: 'engine.js' });
const E = ectx.ZQS_Engine;

function item({ id, title, creators = [] }) {
	return {
		id, dateModified: '2026-01-01 00:00:00', deleted: false,
		isRegularItem: () => true, isAttachment: () => false, parentID: false,
		getDisplayTitle: () => title,
		getCreators: () => creators.map(([f, l]) => ({ firstName: f, lastName: l })),
		getAttachments: () => [],
		getField: (f) => (f === 'firstCreator' ? (creators[0] ? creators[0][1] : '') : ''),
	};
}

E._entries = [
	// straight apostrophe
	item({ id: 1, title: "Don't Stop Believing in Gradient Descent" }),
	// curly apostrophe (U+2019) — what word processors and many publishers emit
	item({ id: 2, title: 'Maxwell’s Equations Revisited' }),
	item({ id: 3, title: 'A Study of Something Else Entirely', creators: [["Conor", "O’Brien"]] }),
].map(i => E.makeEntry(i)).filter(Boolean);
E._dirty = false;

(async () => {
	const q = async (query) => (await E.search(query)).results.map(r => r.entry.id);

	console.log('--- tokenize / apostrophes ---');
	// Apostrophes are dropped on BOTH sides, so "don't"/"dont"/"don’t" all
	// collapse to one form instead of being three mutually unmatchable ones.
	check("tokenize folds apostrophe away", JSON.stringify(E.tokenize("don't")) === '["dont"]',
		JSON.stringify(E.tokenize("don't")));
	check("apostrophe-free query matches apostrophe title",
		(await q('dont')).includes(1), JSON.stringify(await q('dont')));
	check("tokenize strips a stray leading quote", JSON.stringify(E.tokenize('"attention')) === '["attention"]',
		JSON.stringify(E.tokenize('"attention')));
	check("tokenize keeps a quoted phrase whole", JSON.stringify(E.tokenize('"deep learning" bert')) === '["deep learning","bert"]',
		JSON.stringify(E.tokenize('"deep learning" bert')));

	check("straight apostrophe query finds straight-apostrophe title", (await q("don't")).includes(1),
		JSON.stringify(await q("don't")));
	check("straight apostrophe query finds CURLY-apostrophe title", (await q("maxwell's")).includes(2),
		JSON.stringify(await q("maxwell's")));
	check("curly apostrophe query finds straight-apostrophe title", (await q("don’t")).includes(1),
		JSON.stringify(await q("don’t")));
	check("apostrophe surname matches", (await q("o'brien")).includes(3),
		JSON.stringify(await q("o'brien")));

	// ---------- hotkey ----------
	console.log('\n--- hotkey matching ---');
	const octx = {
		Zotero, Math, JSON, console, Object, Number, String, Array, Set, Map, Promise,
	};
	vm.createContext(octx);
	vm.runInContext(fs.readFileSync(__dirname + '/../src/overlay.js', 'utf8'), octx, { filename: 'overlay.js' });
	const O = octx.ZQS_Overlay;

	const withSpec = (spec) => {
		Zotero.Prefs.get = () => spec;
		O._hotkey = O._readHotkeyPref();
		return O;
	};
	const ev = (o) => Object.assign({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, o);

	withSpec('accel+O');
	check('accel+O matches Cmd+O on mac', O._matchesHotkey(ev({ key: 'o', code: 'KeyO', metaKey: true })));
	check('accel+O does NOT match Cmd+Shift+O (that is New Note)',
		!O._matchesHotkey(ev({ key: 'O', code: 'KeyO', metaKey: true, shiftKey: true })));
	check('accel+O does NOT match plain O', !O._matchesHotkey(ev({ key: 'o', code: 'KeyO' })));
	check('accel+O does NOT match Ctrl+O on mac', !O._matchesHotkey(ev({ key: 'o', code: 'KeyO', ctrlKey: true })));

	// Dvorak: the key labelled O sits at QWERTY's "s" position (code KeyS).
	check('Dvorak: key labelled O still fires (key match)',
		O._matchesHotkey(ev({ key: 'o', code: 'KeyS', metaKey: true })));
	check('Dvorak: QWERTY O position does NOT double-bind',
		!O._matchesHotkey(ev({ key: 'r', code: 'KeyO', metaKey: true })));

	withSpec('alt+space');
	check('alt+space matches the spacebar (event.key === " ")',
		O._matchesHotkey(ev({ key: ' ', code: 'Space', altKey: true })));
	check('alt+space does not match alt+s', !O._matchesHotkey(ev({ key: 's', code: 'KeyS', altKey: true })));

	withSpec('accel+shift+P');
	check('accel+shift+P matches Cmd+Shift+P (key uppercased by shift)',
		O._matchesHotkey(ev({ key: 'P', code: 'KeyP', metaKey: true, shiftKey: true })));

	console.log(`\n${pass}/${total} passed`);
	process.exit(pass === total ? 0 : 1);
})();
