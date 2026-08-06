// Tests for the fixes made after review pass 2.
//
// The headline case: pasting a reference-list title (which ends in a period)
// used to score the correct paper at exactly 0 and preselect an unrelated one,
// so Enter opened the wrong paper with no sign anything had gone wrong.
const fs = require('fs');
const vm = require('vm');

let pass = 0, total = 0;
const check = (name, cond, detail = '') => {
	total++; if (cond) { pass++; console.log(`PASS  ${name}`); }
	else console.log(`FAIL  ${name}   ${detail}`);
};

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

function item({ id, title, creators = [], year = '', pub = '' }) {
	return {
		id, dateModified: '2026-01-01 00:00:00', deleted: false,
		isRegularItem: () => true, isAttachment: () => false, parentID: false,
		getDisplayTitle: () => title,
		getCreators: () => creators.map(([f, l]) => ({ firstName: f, lastName: l })),
		getAttachments: () => [],
		getField(f) {
			if (f === 'firstCreator') return creators.length ? creators[0][1] : '';
			if (f === 'year') return year;
			if (f === 'publicationTitle') return pub;
			return '';
		},
	};
}

E._entries = [
	item({ id: 1, title: 'A Cookbook of Self-Supervised Learning', creators: [['Randall', 'Balestriero']], year: '2023' }),
	item({ id: 2, title: 'A General-Purpose Self-Supervised Model for Computational Pathology', year: '2023' }),
	item({ id: 3, title: 'Deep Learning', creators: [['Yann', 'LeCun'], ['Yoshua', 'Bengio']], year: '2015', pub: 'Nature' }),
	item({ id: 4, title: 'High-Resolution Image Synthesis with Latent Diffusion Models', creators: [['Robin', 'Rombach']], year: '2022' }),
	item({ id: 5, title: 'Attention Is All You Need', creators: [['Ashish', 'Vaswani']], year: '2017' }),
	item({ id: 6, title: 'Über die Quantentheorie der Strahlung', creators: [['Albert', 'Einstein']], year: '1917' }),
	item({ id: 7, title: 'A Survey on Graph-Based Deep Learning for Computational Histopathology', year: '2022' }),
].map(i => E.makeEntry(i)).filter(Boolean);
E._dirty = false;

const q = async (query) => (await E.search(query)).results.map(r => r.entry.id);
const top = async (query) => { const r = (await E.search(query)).results; return r.length ? r[0].entry.id : null; };

(async () => {
	console.log('--- pasted citation titles (trailing punctuation) ---');
	check('exact title still ranks first', await top('A Cookbook of Self-Supervised Learning') === 1);
	check('trailing period does not reject the paper',
		await top('A Cookbook of Self-Supervised Learning.') === 1,
		'top=' + await top('A Cookbook of Self-Supervised Learning.'));
	check('trailing question mark is harmless',
		(await q('graph-based deep learning?')).includes(7),
		JSON.stringify(await q('graph-based deep learning?')));
	check('full title with period finds the paper',
		await top('High-Resolution Image Synthesis with Latent Diffusion Models.') === 4);

	console.log('\n--- "Last, First" author form ---');
	check('LeCun, Yann finds the LeCun paper', (await q('LeCun, Yann')).includes(3),
		JSON.stringify(await q('LeCun, Yann')));
	check('Rombach, Robin finds the Rombach paper', await top('Rombach, Robin') === 4,
		'top=' + await top('Rombach, Robin'));
	check('(LeCun 2015) parenthesised citation works', (await q('(LeCun 2015)')).includes(3),
		JSON.stringify(await q('(LeCun 2015)')));
	check('Vaswani, 2017 works', (await q('Vaswani, 2017')).includes(5),
		JSON.stringify(await q('Vaswani, 2017')));

	console.log('\n--- punctuation-only and hyphen tokens ---');
	check('a bare hyphen token is dropped, not matched',
		JSON.stringify(E.tokenize('Smith - 2020')) === '["smith","2020"]',
		JSON.stringify(E.tokenize('Smith - 2020')));
	check('hyphenated query becomes a contiguous phrase',
		JSON.stringify(E.tokenize('graph-based')) === '["graph based"]',
		JSON.stringify(E.tokenize('graph-based')));

	console.log('\n--- diacritics ---');
	check('unaccented query finds accented title', (await q('uber quantentheorie')).includes(6),
		JSON.stringify(await q('uber quantentheorie')));
	check('accented query still finds it', (await q('über')).includes(6));

	console.log('\n--- index staleness race ---');
	// A change arriving mid-rebuild must not be swallowed by the build that
	// was already running.
	E._entries = []; E._dirty = true; E._building = null;
	let releaseBuild;
	const origGetAll = Zotero.Libraries.getAll;
	Zotero.Libraries.getAll = () => {
		// Simulate a notifier firing while the scan is in flight.
		E._dirty = true;
		return [];
	};
	await E.ensureIndex();
	Zotero.Libraries.getAll = origGetAll;
	check('item change during a rebuild leaves the index dirty', E._dirty === true,
		'_dirty=' + E._dirty);

	console.log('\n--- allTokensInTitle bonus ---');
	// The staleness test above emptied the index; rebuild it directly.
	E._entries = [E.makeEntry(item({ id: 5, title: 'Attention Is All You Need', creators: [['Ashish', 'Vaswani']], year: '2017' }))];
	E._dirty = false;
	// The +0.12 bonus must not be handed out for a weak subsequence hit.
	const e5 = E._entries.find(e => e.id === 5);
	const weak = E.scoreEntry(e5, ['antn'], 'antn');       // subsequence only
	const strong = E.scoreEntry(e5, ['attention'], 'attention');
	check('substring match outscores subsequence noise', strong > weak,
		`strong=${strong.toFixed(3)} weak=${weak.toFixed(3)}`);

	console.log(`\n${pass}/${total} passed`);
	process.exit(pass === total ? 0 : 1);
})();
