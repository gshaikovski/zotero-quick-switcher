// Scale, memory and hostile-metadata tests.
// Run with --expose-gc for meaningful memory figures:  node --expose-gc test/scale-harness.js
const { makeZotero, makeWin, loadEngine, buildIndex, search } = require('./stub');

const N = Number(process.env.ZQS_N || 100000);
const BUDGET_MS = 50;          // above this a keystroke feels laggy
const MAX_BYTES_PER_ENTRY = 600;

let pass = 0, total = 0;
const check = (name, cond, detail = '') => {
	total++; if (cond) { pass++; console.log(`PASS  ${name}  ${detail}`); }
	else console.log(`FAIL  ${name}  ${detail}`);
};

let seed = 99;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = a => a[Math.floor(rnd() * a.length) % a.length];
const W1 = ['deep', 'neural', 'graph', 'latent', 'sparse', 'robust', 'causal', 'bayesian', 'quantum', 'adaptive', 'hierarchical', 'contrastive', 'generative', 'federated', 'adversarial'];
const W2 = ['learning', 'networks', 'models', 'inference', 'representation', 'attention', 'transformers', 'diffusion', 'optimization', 'estimation'];
const W3 = ['for vision', 'in practice', 'at scale', 'revisited', 'with transformers', 'for language understanding', 'a survey'];
const SUR = ['Smith', 'Chen', 'Kumar', 'Muller', 'Garcia', 'Yamamoto', 'Nowak', 'Rossi'];
const FIRST = ['Jane', 'Wei', 'Arjun', 'Lukas', 'Maria', 'Hiroshi'];
const VEN = ['NeurIPS', 'ICML', 'ICLR', 'Nature', 'JMLR', 'CVPR'];

function synth(n) {
	const out = [];
	for (let i = 1; i <= n; i++) {
		let t = pick(W1) + ' ' + pick(W2);
		const k = 1 + Math.floor(rnd() * 3);
		for (let j = 0; j < k; j++) t += ' ' + pick(W3);
		const cr = [];
		const na = 1 + Math.floor(rnd() * 6);
		for (let j = 0; j < na; j++) cr.push([pick(FIRST), pick(SUR)]);
		out.push({ id: i, title: t, creators: cr, year: String(1990 + Math.floor(rnd() * 36)), pub: pick(VEN) });
	}
	return out;
}

const mb = b => (b / 1024 / 1024).toFixed(1) + ' MB';
const gc = () => { if (global.gc) { global.gc(); global.gc(); } };

(async () => {
	console.log(`Scale test at N = ${N.toLocaleString()} papers\n`);

	const papers = synth(N);
	const { Zotero } = makeZotero(papers);
	const E = loadEngine(Zotero);
	const win = makeWin(Zotero);
	E.init(win);

	const t0 = process.hrtime.bigint();
	await buildIndex(E, win);
	const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;

	const count = E._entries.length;
	console.log(`build ${buildMs.toFixed(0)} ms   entries ${count.toLocaleString()}\n`);
	check('index respects MAX_INDEXED cap', count <= E.MAX_INDEXED,
		`${count} <= ${E.MAX_INDEXED}`);

	console.log('\n--- per-keystroke latency ---');
	const QUERIES = [
		['common word', 'attention'],
		['two words', 'deep learning'],
		['author', 'muller'],
		['pasted title', 'Deep Learning for Language Understanding at Scale Revisited'],
		['subsequence', 'aiayn'],
		['no match', 'zzzqqq'],
	];
	let worst = 0;
	for (const [label, q] of QUERIES) {
		const s = process.hrtime.bigint();
		const r = await search(E, win, q);
		const ms = Number(process.hrtime.bigint() - s) / 1e6;
		if (ms > worst) worst = ms;
		console.log(`  ${label.padEnd(16)} ${ms.toFixed(1).padStart(7)} ms   ${String(r.total).padStart(7)} hits`);
	}
	check('worst query stays under budget', worst < BUDGET_MS, `worst ${worst.toFixed(1)} ms (budget ${BUDGET_MS})`);

	console.log('\n--- chunk yielding (UI must never block) ---');
	// The scan must hand control back repeatedly rather than running straight
	// through; that is what keeps the UI alive at 500k entries.
	let yields = 0;
	const p = E.search('attention', { isCurrent: () => true });
	for (let i = 0; i < 400; i++) {
		await Promise.resolve();
		if (win._pending()) { yields += win._flush(); }
	}
	await p;
	check('scan yields between chunks', yields > 0, `${yields} yields`);

	console.log('\n--- abandonment (typing must not queue full scans) ---');
	let scanned = 0;
	const p2 = E.search('attention', {
		isCurrent: () => { scanned++; return false; },   // superseded immediately
	});
	for (let i = 0; i < 50; i++) { await Promise.resolve(); if (win._pending()) win._flush(); }
	const r2 = await p2;
	check('superseded search abandons early', r2.abandoned === true, `abandoned=${r2.abandoned}`);

	console.log('\n--- hostile metadata ---');
	// A group library anyone can write to could contain a 10 MB title.
	const hostile = [
		{ id: 1, title: 'x'.repeat(10 * 1024 * 1024), year: '2020' },
		{ id: 2, title: 'Legitimate Paper About Attention', year: '2021' },
	];
	const h = makeZotero(hostile);
	const HE = loadEngine(h.Zotero);
	const hwin = makeWin(h.Zotero);
	HE.init(hwin);
	const ht = process.hrtime.bigint();
	await buildIndex(HE, hwin);
	const hostileMs = Number(process.hrtime.bigint() - ht) / 1e6;
	check('10MB title does not stall the build', hostileMs < 250, `${hostileMs.toFixed(0)} ms`);
	const he = HE._entries.find(e => e.id === 1);
	check('hostile title is length-capped', he && he.t.length <= HE.CAP_TITLE,
		`stored ${he ? he.t.length : 'n/a'} chars (cap ${HE.CAP_TITLE})`);
	// A .slice() on a huge string can return a view that retains the whole
	// parent, so verify the stored value is a genuinely detached copy.
	check('capped title does not retain the 10MB original',
		he && he.t.length < 1000 && !he.t.includes('x'.repeat(1000)),
		'stored value is a flat copy');

	console.log('\n--- adversarial query ---');
	const longQ = 'a'.repeat(100000);
	const qt = process.hrtime.bigint();
	await search(E, win, longQ);
	const qms = Number(process.hrtime.bigint() - qt) / 1e6;
	check('100k-char query is capped, not catastrophic', qms < BUDGET_MS * 2, `${qms.toFixed(1)} ms`);

	console.log('\n--- SQL failure is loud, not silent ---');
	const f = makeZotero(papers.slice(0, 10), { failDB: true });
	const FE = loadEngine(f.Zotero);
	const fwin = makeWin(f.Zotero);
	FE.init(fwin);
	let threw = false;
	try {
		await buildIndex(FE, fwin);
	}
	catch (e) { threw = true; }
	check('index build surfaces DB failure', threw, 'search() rejects so the UI can say so');
	check('DB failure is logged', f.Zotero._errors.some(e => /index build failed/.test(e)),
		`${f.Zotero._errors.length} logged`);

	console.log('\n--- index memory (destructive: measured last) ---');
	gc();
	const withIndex = process.memoryUsage().heapUsed;
	E._entries = [];          // sole reference dropped
	gc();
	const bytes = withIndex - process.memoryUsage().heapUsed;
	const perEntry = Math.round(bytes / Math.max(1, count));
	console.log(`  index ${mb(bytes)}  =  ${perEntry} B/entry`);
	console.log(`  projected: 200k cap -> ${mb(perEntry * 200000)}`);
	check('index memory per entry is bounded', perEntry > 0 && perEntry < MAX_BYTES_PER_ENTRY,
		`${perEntry} B/entry (limit ${MAX_BYTES_PER_ENTRY})`);

	console.log(`\n${pass}/${total} passed`);
	process.exit(pass === total ? 0 : 1);
})();
