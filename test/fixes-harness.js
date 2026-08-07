// Hotkey matching across layouts and named keys, plus normalisation basics.
const fs = require('fs');
const vm = require('vm');
const { makeZotero, makeWin, loadEngine, buildIndex, search, OVERLAY } = require('./stub');

let pass = 0, total = 0;
const check = (name, cond, detail = '') => {
	total++; if (cond) { pass++; console.log(`PASS  ${name}`); }
	else console.log(`FAIL  ${name}   ${detail}`);
};

const PAPERS = [
	{ id: 1, title: "Don't Stop Believing in Gradient Descent" },
	{ id: 2, title: 'Maxwell’s Equations Revisited' },
	{ id: 3, title: 'A Study of Something Else', creators: [['Conor', 'O’Brien']] },
];

(async () => {
	const { Zotero } = makeZotero(PAPERS);
	const E = loadEngine(Zotero);
	const win = makeWin(Zotero);
	E.init(win);
	await buildIndex(E, win);

	const ids = async (q) => (await search(E, win, q)).results.map(r => r.entry.id);

	console.log('--- normalisation ---');
	check('folds apostrophe away', JSON.stringify(E.tokenize("don't")) === '["dont"]',
		JSON.stringify(E.tokenize("don't")));
	check('strips a stray leading quote', JSON.stringify(E.tokenize('"attention')) === '["attention"]');
	check('keeps a quoted phrase whole', JSON.stringify(E.tokenize('"deep learning" bert')) === '["deep learning","bert"]');
	check('apostrophe-free query matches', (await ids('dont')).includes(1));
	check('straight query finds curly title', (await ids("maxwell's")).includes(2));
	check('curly query finds straight title', (await ids('don’t')).includes(1));
	check('apostrophe surname matches', (await ids("o'brien")).includes(3));

	console.log('\n--- hotkey matching ---');
	const octx = { Zotero, Math, JSON, console, Object, Number, String, Array, Set, Map, Promise, Error };
	vm.createContext(octx);
	vm.runInContext(fs.readFileSync(OVERLAY, 'utf8'), octx, { filename: 'overlay.js' });
	const O = octx.ZQS_Overlay;

	const withSpec = (spec) => { Zotero.Prefs.get = () => spec; O._hotkey = O._readHotkeyPref(); return O; };
	const ev = (o) => Object.assign(
		{ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, o);

	withSpec('accel+O');
	check('Cmd+O matches on mac', O._matchesHotkey(ev({ key: 'o', code: 'KeyO', metaKey: true })));
	check('Cmd+Shift+O does not (that is New Note)',
		!O._matchesHotkey(ev({ key: 'O', code: 'KeyO', metaKey: true, shiftKey: true })));
	check('plain O does not', !O._matchesHotkey(ev({ key: 'o', code: 'KeyO' })));
	check('Ctrl+O does not on mac', !O._matchesHotkey(ev({ key: 'o', code: 'KeyO', ctrlKey: true })));
	check('Dvorak: key labelled O fires', O._matchesHotkey(ev({ key: 'o', code: 'KeyS', metaKey: true })));
	check('Dvorak: QWERTY O position does not double-bind',
		!O._matchesHotkey(ev({ key: 'r', code: 'KeyO', metaKey: true })));

	withSpec('alt+space');
	check('alt+space matches the spacebar', O._matchesHotkey(ev({ key: ' ', code: 'Space', altKey: true })));
	check('alt+space does not match alt+s', !O._matchesHotkey(ev({ key: 's', code: 'KeyS', altKey: true })));

	withSpec('accel+shift+P');
	check('Cmd+Shift+P matches', O._matchesHotkey(ev({ key: 'P', code: 'KeyP', metaKey: true, shiftKey: true })));

	console.log('\n--- title sanitisation (spoofing defence) ---');
	check('strips bidi override', O._sanitize('safe‮evil') === 'safeevil',
		JSON.stringify(O._sanitize('safe‮evil')));
	check('strips zero-width', O._sanitize('a​b⁠c') === 'abc');
	check('collapses newlines', O._sanitize('a\nb\tc') === 'a b c');
	check('caps runaway length', O._sanitize('x'.repeat(5000)).length <= 300);

	console.log('\n--- overlay opacity ---');
	// The modal must be OPAQUE. Zotero's --color-menu / --material-menu are
	// translucent (rgba(...,.72) light, rgba(...,.58) dark) because the OS
	// paints a blurred backdrop behind native menus; a plain div gets none, so
	// the PDF underneath shows through. This shipped twice; hence the test.
	const css = fs.readFileSync(__dirname + '/../skin/quickSwitcher.css', 'utf8');
	const declarations = css
		.replace(/\/\*[\s\S]*?\*\//g, '')          // strip comments
		.split('\n')
		.filter(l => /^\s*[a-z-]+\s*:/.test(l));
	const translucent = declarations.filter(l =>
		/var\(--(color-menu|material-menu|color-border)\b/.test(l));
	check('no translucent theme token is used in a declaration',
		translucent.length === 0, JSON.stringify(translucent));

	const modal = css.slice(css.indexOf('.zqs-modal'), css.indexOf('.zqs-input'));
	check('modal background is an opaque token',
		/background:\s*var\(--color-background/.test(modal),
		(modal.match(/background:[^;]*;/) || ['none'])[0].trim());
	check('modal fallback colour is opaque (Canvas, not Menu)',
		/--color-background,\s*Canvas\)/.test(modal) && !/,\s*Menu\)/.test(modal));

	// The inline emergency stylesheet has to be opaque too, or a failed
	// stylesheet read leaves a see-through overlay covering the window.
	const overlaySrc = fs.readFileSync(OVERLAY, 'utf8');
	const fallbackCss = overlaySrc.slice(overlaySrc.indexOf('#zqs-overlay{position:fixed'));
	check('inline fallback stylesheet is opaque too',
		/background:Canvas/.test(fallbackCss) && !/background:Menu/.test(fallbackCss));

	console.log(`\n${pass}/${total} passed`);
	process.exit(pass === total ? 0 : 1);
})();
