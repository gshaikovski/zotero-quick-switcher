// Text-normalisation cases: pasted citation titles, author order, punctuation,
// diacritics, and the index-staleness race.
const { makeZotero, makeWin, loadEngine, buildIndex, search } = require('./stub');

const PAPERS = [
	{ id: 1, title: 'A Cookbook of Self-Supervised Learning', creators: [['Randall', 'Balestriero']], year: '2023' },
	{ id: 2, title: 'A General-Purpose Self-Supervised Model for Computational Pathology', year: '2023' },
	{ id: 3, title: 'Deep Learning', creators: [['Yann', 'LeCun'], ['Yoshua', 'Bengio']], year: '2015', pub: 'Nature' },
	{ id: 4, title: 'High-Resolution Image Synthesis with Latent Diffusion Models', creators: [['Robin', 'Rombach']], year: '2022' },
	{ id: 5, title: 'Attention Is All You Need', creators: [['Ashish', 'Vaswani']], year: '2017' },
	{ id: 6, title: 'Über die Quantentheorie der Strahlung', creators: [['Albert', 'Einstein']], year: '1917' },
	{ id: 7, title: 'A Survey on Graph-Based Deep Learning for Computational Histopathology', year: '2022' },
	{ id: 8, title: "Don't Stop Believing in Gradient Descent", year: '2020' },
	{ id: 9, title: 'Maxwell’s Equations Revisited', year: '1990' },
	{ id: 10, title: 'A Study of Something Else', creators: [['Conor', 'O’Brien']], year: '2001' },
];

let pass = 0, total = 0;
const check = (name, cond, detail = '') => {
	total++; if (cond) { pass++; console.log(`PASS  ${name}`); }
	else console.log(`FAIL  ${name}   ${detail}`);
};

(async () => {
	const { Zotero } = makeZotero(PAPERS);
	const E = loadEngine(Zotero);
	const win = makeWin(Zotero);
	E.init(win);
	await buildIndex(E, win);

	const ids = async (q) => (await search(E, win, q)).results.map(r => r.entry.id);
	const top = async (q) => { const r = await ids(q); return r.length ? r[0] : null; };

	console.log('--- pasted citation titles (trailing punctuation) ---');
	check('exact title ranks first', await top('A Cookbook of Self-Supervised Learning') === 1);
	check('trailing period does not reject', await top('A Cookbook of Self-Supervised Learning.') === 1,
		'top=' + await top('A Cookbook of Self-Supervised Learning.'));
	check('trailing question mark', (await ids('graph-based deep learning?')).includes(7));
	check('full title with period', await top('High-Resolution Image Synthesis with Latent Diffusion Models.') === 4);

	console.log('\n--- "Last, First" author form ---');
	check('LeCun, Yann', (await ids('LeCun, Yann')).includes(3), JSON.stringify(await ids('LeCun, Yann')));
	check('Rombach, Robin', await top('Rombach, Robin') === 4);
	check('(LeCun 2015)', (await ids('(LeCun 2015)')).includes(3));
	check('Vaswani, 2017', (await ids('Vaswani, 2017')).includes(5));

	console.log('\n--- punctuation and hyphens ---');
	check('bare hyphen dropped', JSON.stringify(E.tokenize('Smith - 2020')) === '["smith","2020"]',
		JSON.stringify(E.tokenize('Smith - 2020')));
	check('hyphenated becomes phrase', JSON.stringify(E.tokenize('graph-based')) === '["graph based"]');

	console.log('\n--- apostrophes ---');
	check('folds apostrophe', JSON.stringify(E.tokenize("don't")) === '["dont"]');
	check('apostrophe-free query finds it', (await ids('dont stop')).includes(8));
	check('curly apostrophe title found', (await ids("maxwell's")).includes(9));
	check('apostrophe surname', (await ids("o'brien")).includes(10));

	console.log('\n--- diacritics ---');
	check('unaccented finds accented', (await ids('uber quantentheorie')).includes(6));
	check('accented still finds', (await ids('über')).includes(6));

	console.log('\n--- index staleness race ---');
	// A notification arriving DURING a build must not be swallowed by it.
	E._dirty = false;
	E._lastBuiltStart = 0;
	E._dirty = true;
	const p = E.ensureIndex();
	Zotero.Notifier.fire('modify', 'item');   // fires mid-build
	for (let i = 0; i < 200; i++) { await Promise.resolve(); if (win._pending()) win._flush(); }
	await p;
	check('change during rebuild leaves index dirty', E._dirty === true, '_dirty=' + E._dirty);

	console.log('\n--- ranking bonus ---');
	const e5 = E._entries.find(e => e.id === 5);
	const strong = E.scoreEntry(e5, ['attention'], 'attention');
	const weak = E.scoreEntry(e5, ['antn'], 'antn');
	check('substring beats subsequence', strong > weak, `${strong.toFixed(3)} vs ${weak.toFixed(3)}`);

	console.log(`\n${pass}/${total} passed`);
	process.exit(pass === total ? 0 : 1);
})();
