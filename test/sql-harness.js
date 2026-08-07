// Runs the plugin's ACTUAL SQL against a database built from Zotero's OWN
// shipped schema, through a queryAsync shim that reproduces Zotero's real
// behaviour — including the statement-type detection that silently returns
// undefined for a query starting with whitespace.
//
// Every other harness stubs queryAsync and hands back arrays, so none of them
// could ever have caught that. This one executes the real strings.
//
// The schema comes from Zotero's resource/schema/userdata.sql (application
// source, not anyone's library). Set ZOTERO_OMNI to point at an extracted
// omni.ja if the default path is gone; the harness skips cleanly without it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

let pass = 0, total = 0;
const check = (name, cond, detail = '') => {
	total++; if (cond) { pass++; console.log(`PASS  ${name}  ${detail}`); }
	else console.log(`FAIL  ${name}  ${detail}`);
};

const OMNI = process.env.ZOTERO_OMNI || '/Users/george/.claude/jobs/be8c93f2/tmp/omni';
const SCHEMA = path.join(OMNI, 'resource/schema/userdata.sql');

if (!fs.existsSync(SCHEMA)) {
	console.log(`SKIP  Zotero schema not found at ${SCHEMA}`);
	console.log('      (re-extract omni.ja, or set ZOTERO_OMNI)');
	console.log('\n0/0 passed');
	process.exit(0);
}

const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zqs-sql-')), 'test.sqlite');
if (process.env.ZQS_KEEP) console.log('  [db] ' + db);
// -bail so a failing statement stops immediately, and stderr is surfaced —
// an earlier version used INSERT OR IGNORE and silently built an empty fixture.
const sqlite = (sqlText) => {
	try {
		return execFileSync('sqlite3', ['-bail', db], {
			input: sqlText, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
		});
	}
	catch (e) {
		throw new Error('fixture SQL failed: ' + (e.stderr || e.message));
	}
};

// ---- build a database from Zotero's shipped schema -----------------------
// userdata.sql carries "-- N" version comments and Zotero's own directives;
// the CREATE statements are what we need.
const schemaText = fs.readFileSync(SCHEMA, 'utf8')
	.split('\n')
	.filter(l => !l.trim().startsWith('--'))
	.join('\n');
sqlite(schemaText);

const tables = sqlite("SELECT COUNT(*) FROM sqlite_master WHERE type='table';").trim();
check('database created from Zotero\'s own schema', Number(tables) > 30, `${tables} tables`);

// Zotero's system tables (fields, itemTypes, baseFieldMappings) live in
// system.sql and are populated at runtime; insert the minimum this query needs.
sqlite(`
-- fieldsCombined/itemTypesCombined both carry "custom INT NOT NULL" with no
-- default, so it must be supplied explicitly.
INSERT INTO fieldsCombined (fieldID, fieldName, custom) VALUES
  (110,'title',0),(14,'date',0),(12,'publicationTitle',0),(115,'proceedingsTitle',0);
INSERT INTO itemTypesCombined (itemTypeID, typeName, display, custom) VALUES
  (2,'book',1,0),(4,'journalArticle',1,0),(11,'conferencePaper',1,0);
INSERT INTO baseFieldMappingsCombined (itemTypeID, baseFieldID, fieldID) VALUES
  (11, 12, 115);
INSERT INTO libraries (libraryID, type, editable, filesEditable) VALUES (1,'user',1,1),(2,'group',1,1);

INSERT INTO items (itemID, libraryID, itemTypeID, key, dateAdded, dateModified, clientDateModified) VALUES
  (1,1,4,'AAAAAAAA','2026-01-01 00:00:00','2026-01-05 00:00:00','2026-01-05 00:00:00'),
  (2,1,11,'BBBBBBBB','2026-01-01 00:00:00','2026-01-04 00:00:00','2026-01-04 00:00:00'),
  (3,1,4,'CCCCCCCC','2026-01-01 00:00:00','2026-01-03 00:00:00','2026-01-03 00:00:00'),
  (4,1,4,'DDDDDDDD','2026-01-01 00:00:00','2026-01-02 00:00:00','2026-01-02 00:00:00'),
  (5,2,4,'EEEEEEEE','2026-01-01 00:00:00','2026-01-06 00:00:00','2026-01-06 00:00:00');

INSERT INTO itemDataValues (valueID, value) VALUES
  (1,'Attention Is All You Need'),(2,'2017-06-12'),(3,'NeurIPS'),
  (4,'A Conference Paper'),(5,'Proceedings of Everything'),
  (6,'A Trashed Paper'),(7,'A Paper With No Creators'),
  (8,'Group Library Paper');

INSERT INTO itemData (itemID, fieldID, valueID) VALUES
  (1,110,1),(1,14,2),(1,12,3),
  (2,110,4),(2,115,5),
  (3,110,6),
  (4,110,7),
  (5,110,8);

INSERT INTO creators (creatorID, firstName, lastName, fieldMode) VALUES
  (1,'Ashish','Vaswani',0),(2,'Noam','Shazeer',0),(3,'Ada','Lovelace',0);
INSERT INTO itemCreators (itemID, creatorID, creatorTypeID, orderIndex) VALUES
  (1,1,1,0),(1,2,1,1),(2,3,1,0);

-- item 3 is in the trash
INSERT INTO deletedItems (itemID, dateDeleted) VALUES (3,'2026-01-02 00:00:00');

-- a child attachment and a child note, which must NOT be indexed as papers
INSERT INTO items (itemID, libraryID, itemTypeID, key, dateAdded, dateModified, clientDateModified)
  VALUES (10,1,4,'FFFFFFFF','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00'),
         (11,1,4,'GGGGGGGG','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00');
INSERT INTO itemDataValues (valueID, value) VALUES (10,'Some Attachment'),(11,'Some Note');
INSERT INTO itemData (itemID, fieldID, valueID) VALUES (10,110,10),(11,110,11);
INSERT INTO itemAttachments (itemID, parentItemID, linkMode) VALUES (10,1,0);
INSERT INTO itemNotes (itemID, parentItemID) VALUES (11,1);
`);

// The fixture must actually contain data — an empty one would make every
// downstream assertion pass vacuously.
const fieldCount = Number(sqlite('SELECT COUNT(*) FROM fieldsCombined;').trim());
const itemCount = Number(sqlite('SELECT COUNT(*) FROM items;').trim());
check('fixture is populated', fieldCount === 4 && itemCount === 7,
	`${fieldCount} fields, ${itemCount} items`);

// ---- a queryAsync that behaves like Zotero's ------------------------------
// Reproduces the statement-type detection at db.js:645-652 verbatim. This is
// the whole point of the harness: a query that is not recognised as a SELECT
// returns undefined rather than rows, silently.
function makeDB() {
	return {
		calls: [],
		async queryAsync(sql, params) {
			this.calls.push(sql);
			let op = sql.match(/^[^a-z]*[^ ]+/i);
			if (op) op = op.toString().toLowerCase();
			if (op !== 'select' && op !== 'pragma') {
				return undefined;   // exactly what Zotero does
			}
			let bound = sql;
			for (const p of (params || [])) {
				bound = bound.replace('?', typeof p === 'number' ? String(p) : `'${p}'`);
			}
			const out = execFileSync('sqlite3', ['-json', db], { input: bound, encoding: 'utf8' }).trim();
			return out ? JSON.parse(out) : [];
		},
	};
}

const Zotero = {
	isMac: true, debug() {}, logError(e) { (Zotero._errors ||= []).push(String(e)); },
	_errors: [],
	DB: makeDB(),
	Notifier: { registerObserver: () => 'obs', unregisterObserver() {} },
	Libraries: { userLibraryID: 1, get: id => ({ libraryID: id, name: 'lib' + id }) },
	Feeds: { getAll: () => [] },
	Prefs: { get: () => undefined },
};

const ctx = { Zotero, Math, JSON, console, Object, Date, Number, String, Array, Set, Map, Promise, Error, Int32Array };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../src/engine.js', 'utf8'), ctx, { filename: 'engine.js' });
const E = ctx.ZQS_Engine;

let timers = [];
const win = { setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {} };

(async () => {
	// ---- the regression itself -------------------------------------------
	// Deliberately NOT trimmed: Zotero sees the raw constant, and a leading
	// newline is exactly what made queryAsync return undefined in the field.
	const opOf = (sql) => {
		const m = sql.match(/^[^a-z]*[^ ]+/i);
		return m ? m.toString().toLowerCase() : null;
	};
	check('SQL_ITEMS starts at the SELECT keyword',
		opOf(E.SQL_ITEMS) === 'select', JSON.stringify(E.SQL_ITEMS.slice(0, 12)));
	check('SQL_CREATORS starts at the SELECT keyword',
		opOf(E.SQL_CREATORS) === 'select', JSON.stringify(E.SQL_CREATORS.slice(0, 12)));

	E.init(win);
	let err = null;
	const p = E.ensureIndex().catch((e) => { err = e; return null; });
	for (let i = 0; i < 200; i++) {
		await new Promise(r => setImmediate(r));
		while (timers.length) { const t = timers.shift(); t(); }
	}
	const entries = await p;

	check('index builds against the real schema without throwing', !err && !!entries,
		err ? String(err) : '');
	if (err || !entries) {
		console.log(`\n${pass}/${total} passed`);
		process.exit(1);
	}

	const byTitle = new Map(entries.map(e => [e.t, e]));
	const titles = entries.map(e => e.t).sort();
	console.log('  indexed titles:', JSON.stringify(titles));

	check('indexes the ordinary paper', byTitle.has('attention is all you need'));
	check('resolves base-mapped venue (conferencePaper -> proceedingsTitle)',
		byTitle.get('a conference paper')
		&& byTitle.get('a conference paper').p === 'proceedings of everything',
		byTitle.get('a conference paper') ? JSON.stringify(byTitle.get('a conference paper').p) : 'missing');
	check('joins creators', byTitle.get('attention is all you need')
		&& /vaswani/.test(byTitle.get('attention is all you need').c),
		byTitle.get('attention is all you need') ? JSON.stringify(byTitle.get('attention is all you need').c) : '');
	check('a paper with no creators is still indexed', byTitle.has('a paper with no creators'));
	check('excludes trashed items', !byTitle.has('a trashed paper'));
	check('excludes child attachments', !byTitle.has('some attachment'));
	check('excludes child notes', !byTitle.has('some note'));
	check('excludes other libraries (My Library only)', !byTitle.has('group library paper'));
	check('reads the year from the date field',
		byTitle.get('attention is all you need')
		&& byTitle.get('attention is all you need').y === '2017',
		byTitle.get('attention is all you need') ? byTitle.get('attention is all you need').y : '');

	// ---- and the search actually returns something ------------------------
	const runSearch = async (q) => {
		const sp = E.search(q, {}).catch(() => ({ results: [], total: 0 }));
		for (let i = 0; i < 200; i++) {
			await new Promise(r => setImmediate(r));
			while (timers.length) { const t = timers.shift(); t(); }
		}
		return sp;
	};
	const r1 = await runSearch('attention');
	check('search returns the paper end to end', r1.results.length === 1
		&& r1.results[0].entry.key === 'AAAAAAAA',
		`${r1.results.length} results`);
	const r2 = await runSearch('vaswani');
	check('search matches on creator', r2.results.length === 1);
	const r3 = await runSearch('aiayn');
	check('fuzzy acronym works against real data', r3.results.length === 1);

	check('libraryID was passed as a bound parameter, not interpolated',
		Zotero.DB.calls.every(s => !/libraryID\s*=\s*\d/.test(s)),
		'no inlined ids');

	console.log(`\n${pass}/${total} passed`);
	process.exit(pass === total ? 0 : 1);
})();
