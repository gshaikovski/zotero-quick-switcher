// Ranking behaviour of the real engine, driven through the real SQL-backed
// index path (with a stubbed DB).
const { makeZotero, makeWin, loadEngine, buildIndex, search } = require('./stub');

const PAPERS = [
	{ id: 1, title: 'Attention Is All You Need', creators: [['Ashish', 'Vaswani']], year: '2017', pub: 'Advances in Neural Information Processing Systems' },
	{ id: 2, title: 'Deep Residual Learning for Image Recognition', creators: [['Kaiming', 'He']], year: '2016', pub: 'CVPR' },
	{ id: 3, title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', creators: [['Jacob', 'Devlin']], year: '2019', pub: 'NAACL' },
	{ id: 4, title: 'Attention', creators: [['Jane', 'Smith']], year: '1999', pub: 'Psychology Today' },
	{ id: 5, title: 'A Survey of Deep Learning for Attention Mechanisms in Vision', creators: [['Li', 'Wang']], year: '2021', pub: 'ACM Computing Surveys' },
	{ id: 6, title: 'Language Models are Few-Shot Learners', creators: [['Tom', 'Brown']], year: '2020', pub: 'NeurIPS' },
	{ id: 7, title: 'Human-level Control Through Deep Reinforcement Learning', creators: [['Volodymyr', 'Mnih']], year: '2015', pub: 'Nature' },
	{ id: 8, title: 'Squeeze-and-Excitation Networks', creators: [['Jie', 'Hu'], ['Li', 'Shen']], year: '2018', pub: 'CVPR' },
	{ id: 9, title: 'Learning to Reason Efficiently', creators: [['Andreas', 'Opedal'], ['Abulhair', 'Saparov']], year: '2025', pub: 'arXiv' },
	{ id: 10, title: 'Transformers Struggle to Learn to Search', creators: [['Abulhair', 'Saparov'], ['Srushti', 'Pawar']], year: '2025', pub: 'ICLR' },
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

	console.log(`indexed ${E._entries.length}/${PAPERS.length}`);
	console.log(`initials of #1: "${E._entries.find(e => e.id === 1).i}"\n`);

	const top = async (q) => {
		const r = await search(E, win, q);
		return r.results.length ? r.results[0].entry.id : null;
	};
	const ids = async (q) => (await search(E, win, q)).results.map(r => r.entry.id);

	const t = async (label, q, expect) => {
		const got = await top(q);
		check(`${label.padEnd(22)} "${q}"`, got === expect, `top=${got} expected=${expect}`);
	};

	console.log('--- exact / prefix ---');
	await t('exact short title', 'Attention', 4);
	await t('title prefix', 'attention is all', 1);
	await t('full title', 'attention is all you need', 1);

	console.log('\n--- fuzzy (impossible with SQL LIKE) ---');
	await t('acronym', 'aiayn', 1);
	await t('subsequence', 'atnisallyn', 1);
	await t('single word', 'bert', 3);

	console.log('\n--- multi-word AND ---');
	await t('creator + title', 'vaswani attention', 1);
	await t('creator + title', 'he residual', 2);
	await t('two title words', 'deep learning', 5);

	console.log('\n--- creator order ---');
	await t('first last', 'kaiming he', 2);
	await t('last first', 'he kaiming', 2);

	console.log('\n--- surname ---');
	await t('surname over title word', 'hu', 8);
	await t('first author wins', 'saparov', 10);
	await t('second author found', 'shen', 8);

	console.log('\n--- year / venue ---');
	await t('creator + year', 'brown 2020', 6);
	await t('venue', 'naacl', 3);

	console.log('\n--- negatives ---');
	check('no match returns nothing', (await ids('zzzzqqq')).length === 0);
	check('AND semantics exclude', (await ids('attention quantum')).length === 0);
	check('unbalanced quote handled', (await ids('"attention')).includes(4));

	console.log(`\n${pass}/${total} passed`);
	process.exit(pass === total ? 0 : 1);
})();
