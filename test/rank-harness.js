// Load engine.js in a vm with a stubbed Zotero and check that ranking behaves.
const fs = require('fs');
const vm = require('vm');

const SRC = __dirname + '/../src/engine.js';

const Zotero = {
	debug() {}, logError() {},
	Notifier: { registerObserver: () => 'obs', unregisterObserver() {} },
	Items: { get: () => null },
	Libraries: { getAll: () => [] },
	Prefs: { get: () => undefined },
};

const ctx = { Zotero, Math, JSON, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'engine.js' });
const E = ctx.ZQS_Engine;
E._win = {};

// --- stub items -----------------------------------------------------------
function item({ id, title, creators = [], year = '', pub = '', type = 'journalArticle' }) {
	return {
		id, dateModified: '2026-01-01 00:00:00', deleted: false,
		isRegularItem: () => true,
		isAttachment: () => false,
		parentID: false,
		getDisplayTitle: () => title,
		getCreators: () => creators.map(([f, l]) => ({ firstName: f, lastName: l })),
		getAttachments: () => [],
		getField(f, unformatted, baseMapped) {
			if (f === 'firstCreator') return creators.length ? creators[0][1] : '';
			if (f === 'year') return year;
			if (f === 'publicationTitle') return pub;
			if (f === 'title') return title;
			return '';
		},
	};
}

const LIB = [
	item({ id: 1, title: 'Attention Is All You Need', creators: [['Ashish', 'Vaswani']], year: '2017', pub: 'Advances in Neural Information Processing Systems' }),
	item({ id: 2, title: 'Deep Residual Learning for Image Recognition', creators: [['Kaiming', 'He']], year: '2016', pub: 'CVPR' }),
	item({ id: 3, title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', creators: [['Jacob', 'Devlin']], year: '2019', pub: 'NAACL' }),
	item({ id: 4, title: 'Attention', creators: [['Jane', 'Smith']], year: '1999', pub: 'Psychology Today' }),
	item({ id: 5, title: 'A Survey of Deep Learning for Attention Mechanisms in Vision', creators: [['Li', 'Wang']], year: '2021', pub: 'ACM Computing Surveys' }),
	item({ id: 6, title: 'Language Models are Few-Shot Learners', creators: [['Tom', 'Brown']], year: '2020', pub: 'NeurIPS' }),
];

E._entries = LIB.map(i => E.makeEntry(i)).filter(Boolean);
E._dirty = false;

console.log(`indexed ${E._entries.length}/${LIB.length} items`);
console.log(`initials of #1: "${E._entries[0].l.initials}"`);
console.log(`creators of #1: "${E._entries[0].l.creators}"\n`);

async function q(query, expectTopId) {
	const { results, total } = await E.search(query);
	const top = results[0];
	const ok = top && top.entry.id === expectTopId;
	console.log(`${ok ? 'PASS' : 'FAIL'}  "${query}"  -> ${total} hits` +
		(top ? `, top = [${top.entry.id}] ${top.entry.title.slice(0, 46)} (${top.score.toFixed(3)})` : ', NO RESULTS'));
	if (!ok && top) console.log(`      expected id ${expectTopId}`);
	if (results.length > 1) {
		console.log('      then: ' + results.slice(1, 4)
			.map(r => `[${r.entry.id}] ${r.score.toFixed(3)}`).join(', '));
	}
	return ok;
}

(async () => {
	let pass = 0, n = 0;
	const t = async (...a) => { n++; if (await q(...a)) pass++; };

	console.log('--- exact / prefix ---');
	await t('Attention', 4);                    // exact title match wins over longer
	await t('attention is all', 1);
	await t('attention is all you need', 1);

	console.log('\n--- fuzzy / acronym (impossible with SQL LIKE) ---');
	await t('aiayn', 1);                        // initials
	await t('atnisallyn', 1);                   // subsequence
	await t('bert', 3);

	console.log('\n--- multi-word AND across fields ---');
	await t('vaswani attention', 1);
	await t('he residual', 2);
	await t('deep learning', 5);

	console.log('\n--- creator in both orders ---');
	await t('kaiming he', 2);
	await t('he kaiming', 2);

	console.log('\n--- year / venue ---');
	await t('brown 2020', 6);
	await t('naacl', 3);

	console.log('\n--- negative cases ---');
	n++; const { results: r1 } = await E.search('zzzzqqq');
	if (!r1.length) { pass++; console.log('PASS  "zzzzqqq" -> 0 hits'); }
	else console.log(`FAIL  "zzzzqqq" -> ${r1.length} hits (expected 0)`);

	n++; const { results: r2 } = await E.search('attention quantum');
	if (!r2.length) { pass++; console.log('PASS  "attention quantum" -> 0 hits (AND semantics)'); }
	else console.log(`FAIL  "attention quantum" -> ${r2.length} (expected 0)`);

	n++; const { results: r3 } = await E.search('"attention');   // unbalanced quote
	if (r3.length && r3[0].entry.id === 4) { pass++; console.log('PASS  unbalanced quote handled'); }
	else console.log(`FAIL  unbalanced quote -> ${r3.length ? r3[0].entry.id : 'none'} (expected 4)`);

	console.log(`\n${pass}/${n} passed`);
	process.exit(pass === n ? 0 : 1);
})();
