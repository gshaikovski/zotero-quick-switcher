# Zotero Quick Switcher — Scale & Memory Audit

**Audit target:** commit `9ba2637` (HEAD at audit time). All five auditors' line citations
were re-checked against this commit and every one is exact.

**Method:** the real `src/engine.js` was executed in `node`/`vm` against stubbed Zotero
objects at 1k–500k papers; Zotero API claims were verified against the extracted Zotero
9.0.6 source (`omni.ja`); schema and cost claims were verified against a read-only copy of
`zotero.sqlite.bak`. Numbers below are labelled **[measured]**, **[measured — synthetic DB]**,
or **[modelled]**. The plugin was never installed and Zotero was never launched.

> ### ⚠ A rewrite is already in flight in the working tree
> The working tree is **not** the audited commit. `src/engine.js`, `src/overlay.js`,
> `src/opener.js`, `manifest.json` and `skin/quickSwitcher.css` were modified during this
> audit (last write 11:27 today). The uncommitted version already replaces the object-graph
> index with a `Zotero.DB.queryAsync` SQL index, fixes the `_building` wedge, adds a
> character bitmap, chunking, bounded top-K, and a library-provenance badge — i.e. it has
> already adopted this document's recommendation. **This audit describes `9ba2637`.** The
> section "What the in-flight rewrite already fixes" at the end maps the findings onto it.
> None of the rewrite has been measured or tested by me.

---

## 1. Verdict

**Not acceptable for a large library — but the problem is working-set size and main-thread
blocking, not a leak.** Three auditors independently hunted for leaks and found none: 20,000
overlay open/search/close cycles drift 8.6 B/cycle, 2,000 window attach/detach cycles are
flat, and 3,000 sync-storm iterations are flat. The design is honest and the teardown works
on the happy path. What breaks is scale. The plugin indexes every top-level item in every
library by materialising each one as a `Zotero.Item` and force-loading all ten of its data
types — of which it reads three. At 100k papers that is ~188 MB of its own index plus a
**[modelled]** 350–460 MB stranded permanently inside Zotero's own never-evicted
`_objectCache`, which `destroy()` has no way to release; at 500k it is 940 MB plus ~1.9 GB.
Search is a linear scan with no candidate generation, so every keystroke blocks the entire
Zotero UI — including a PDF reader tab — for 43–123 ms at 100k and 217–659 ms at 500k. The
16 ms frame budget is gone at roughly 12k papers. Separately, and independent of scale, a
one-line promise-assignment ordering bug can wedge the index permanently (verified,
reproduced). For the user's actual ~570-paper library the current design is fine and fast;
it stops being fine somewhere around 10k–20k.

---

## 2. Measured numbers

All figures below are **[measured]** by executing the real `HEAD:src/engine.js` in node/vm
(Apple M5, node v25.8.1, V8). Zotero runs SpiderMonkey, typically slower on string-scalar
loops, so treat these as *optimistic*.

### Index build, memory, and latency

| Papers | Build (JS only) | Index post-build | B/entry post-build | Index settled | B/entry settled | Keystroke latency (median range) |
|---|---|---|---|---|---|---|
| 1k | 8.9 ms | 2.0 MB | 2,087 | 0.8 MB | 867 | 0.4 – 1.1 ms |
| 10k | 65.9 ms | 18.9 MB | 1,986 | 6.7 MB | 701 | 4.2 – 11.8 ms |
| 100k | 700.8 ms | 187.8 MB | 1,970 | 64.3 MB | 674 | 43 – 123 ms |
| 500k | 3,053.9 ms | 940.0 MB | 1,971 | 322.1 MB | 675 | 217 – 659 ms |

Latency range spans eight representative queries: `zzqq` (no match) at the low end,
`attention is all you need` (5 tokens) at the high end. Build time is **JS only** and
excludes Zotero's SQL, which is the larger cost (next table).

**Resolving the auditors' memory disagreement.** Reported figures ranged from 800 to
3,650 B/entry. Two effects explain the whole spread, and both are real:

1. **String flattening.** `normalize()` builds its haystacks through a chain of
   `String.replace()` calls, which V8 represents as unflattened cons/sliced string trees.
   The index therefore costs **~1,970 B/entry from window startup until the first search**,
   and settles to **~674 B/entry** once `indexOf` flattens the strings in place. The plugin
   sits at the 2.9× peak for the entire time between startup warm-up and the user's first
   query. Auditors who sampled before the first search reported ~2,000–3,650; those who
   sampled after reported ~700–950. Both were right about different moments.
2. **Co-author count.** The `creators` haystack indexes every author in *both* name orders.
   My corpus used 1–6 authors/paper; auditors using 1–30 authors measured proportionally
   more memory and ~2× the search latency (152 ms vs my 76 ms for `attention` at 100k).
   A physics library with large collaborations sits at the high end.

### Costs the plugin imposes on Zotero itself

| What | 100k papers | 500k papers | Confidence |
|---|---|---|---|
| Rows `getAll(onlyTopLevel)` returns vs papers wanted | 350k rows / 100k papers | 1.75M / 500k | **[measured — synthetic DB]** |
| Wasted rows (annotations & notes, discarded after full load) | 59–73% | 59–73% | **[measured]** — real library: 2,127 rows → 569 papers = **73% waste** |
| `loadDataTypes()` SQL (all 10 types, inline id list) | 3.4 s | 20.8 s | **[measured — synthetic DB]** |
| Heap stranded in `Zotero.Items._objectCache`, unreleasable | 350–460 MB | ~1.9 GB | **[modelled]** — cannot be measured outside Zotero; three independent models agree within 30% |
| Full rebuild triggered by *any* item change | ~1.1 s JS + 3.4 s SQL | ~6.5 s JS + 20.8 s SQL | **[measured — synthetic DB]** |
| Main-thread duty cycle while typing during a sync | 62–66% | 89–94% | **[measured]** (virtual-time simulation) |

### Facts about Zotero, verified against 9.0.6 source and the real database

- **There is no search index to plug into.** Zero FTS or virtual tables in the schema
  (`SELECT count(*) FROM sqlite_master WHERE sql LIKE '%VIRTUAL%'` → **0**).
  `fulltextWords`/`fulltextItemWords` is a hand-rolled inverted index over **PDF file text
  only** — on the real library it holds 555 attachments and **zero** top-level regular
  items, and contains no titles or creators. The user's hoped-for option does not exist.
- **`itemDataValues.value` cannot be searched by index.** `EXPLAIN QUERY PLAN` confirms
  `value LIKE '%x%'` → `SCAN`, `value LIKE 'x%'` → `SCAN` (BINARY collation with
  `case_sensitive_like` off defeats the prefix optimisation), while `value = ?` → covering
  index. Every quicksearch token is a full table scan.
- **`quicksearch-titleCreatorYear` expands to 7 `LIKE '%v%'` conditions per token**
  (title, publicationTitle, shortTitle, court, year, citationKey, creator) — verified at
  `search.js:315-362` and `search.js:1644-1658`.
- **`search.js` contains zero `ORDER BY` statements**, so `Zotero.Search` returns an
  unranked `Integer[]`. Ranking must live in the plugin regardless of architecture.
- **`getAll(onlyTopLevel=true)` LEFT JOINs only `itemNotes` and `itemAttachments`**
  (`items.js:121-140`), so annotations pass the top-level test. Confirmed by reading.
- **`loadDataTypes(items)` with no second argument loads all ten data types**
  (`dataObjects.js:450-453` → `Item.prototype._dataTypes` at `item.js:104-116`). Confirmed.
- **`_objectCache` is a plain `{}` with no LRU and no eviction** (`dataObjects.js:54`);
  the only removal paths are explicit `unload()` (`:984-996`) and a library purge/reload
  (`:939-941`). A plugin that populates it cannot un-populate it.

---

## 3. Architecture options

Memory and latency are at **100k papers**. "Fuzzy" means the subsequence match that lets
`aiayn` find *Attention Is All You Need* — the reason this plugin exists.

### (a) `Zotero.Search` per keystroke

Run Zotero's own `quicksearch-titleCreatorYear` on each keystroke and rank the returned ids.

- **Memory:** ~0 MB. **Latency: 746 ms (1 token) – 1,500 ms (3 tokens)**
  **[measured — synthetic DB]**, from a line-by-line reconstruction of the generated SQL.
  Floor check: a single `LIKE '%attention%'` scan of `itemDataValues` alone is 68 ms warm,
  and quicksearch runs six of those plus a creator scan *per token*.
- **Fuzzy: no — structurally impossible.** `contains` compiles to `LIKE '%value%'`, so a
  candidate must contain every token as a literal substring. `LIKE '%aiayn%'` can never
  match that title. No ranking either (zero `ORDER BY`).
- **Downsides:** 10–50× too slow to run per keystroke; loses the plugin's entire reason for
  existing; multi-word semantics are cross-field AND, so "deep learning" matches a paper
  whose title has "deep" and whose author is named Learning.
- **Verdict: rejected.**

### (b) Compact SQL-built string index ← **RECOMMENDED**

One SQL query per library reads only the strings needed for matching directly out of
`itemData`/`itemDataValues`/`itemCreators`, into parallel `Array<string>` plus typed arrays
for id/year/bitmask. No `Zotero.Item` is ever constructed for indexing; the ~50 rows
actually rendered are resolved lazily via `Zotero.Items.get()`.

- **Memory: 37 MB** (398 B/item) **[measured]** by an auditor prototype, vs 188 MB today.
  **Zero** addition to Zotero's `_objectCache`.
- **Build: 283–846 ms of SQL** (off-thread in Zotero) **[measured — synthetic DB]**, vs
  3.4 s of SQL + 0.7 s of JS today.
- **Latency: 10–91 ms** **[measured]**, and it returned a **byte-identical top-20 to the
  current engine on all 8 test queries at 570, 50k, 100k and 500k items.**
- **Fuzzy: fully preserved.** This is the key insight and it is worth stating plainly: SQL
  is used only to *fetch* strings, never to *filter* by the query. The candidate set stays
  "every item" and the subsequence scorer is unchanged. A 32-bit character-class bitmask
  (bits 0–25 = a–z, 26 = digit, 27 = other) skips an item when
  `(maskOf(query) & ~maskOf(item)) != 0` — provably exact, because a subsequence match
  requires character-set containment, and empirically verified to return identical hit
  counts.
- **Downsides:** the plugin now owns SQL against Zotero's schema, so a schema change in a
  future Zotero can break it (mitigated by pinning `strict_max_version`). Two traps to
  avoid, both measured: **(i)** do *not* store the strings in one concatenated blob with
  offset arrays — `indexOf` has no end bound, so a token absent from an item's slice scans
  the rest of the index; that prototype failed to finish 8 queries in 600 s where the
  per-item-string form takes 10–91 ms. **(ii)** `queryAsync` defaults to `executeCached`
  and mozStorage's statement cache is unbounded with no eviction and no Zotero caller of
  `discardCachedStatements` — so keep SQL text constant and bind values as parameters, or
  pass `{ noCache: true }`.

### (c) Current full-object index

- **Memory: 188 MB peak / 64 MB settled, plus 350–460 MB [modelled] stranded in Zotero.**
- **Build: 0.7 s JS + 3.4 s SQL. Latency: 43–123 ms.**
- **Fuzzy: yes.**
- **Downsides:** every one of the costs in §2. The stranded `_objectCache` growth is the
  disqualifying one — it is memory the plugin causes Zotero to hold for the rest of the
  session, that disabling or uninstalling the plugin does not give back.
- **Verdict: rejected at scale; acceptable only below ~10k papers.**

### (d) Hybrid: SQL-narrow then fuzzy-rank

Use SQL `LIKE` to narrow to candidates, then run the existing scorer over them.

- **Latency: 141–165 ms *per token* [measured — synthetic DB]** just for the narrowing —
  already more than scanning the whole compact index — plus a DB round-trip inside the
  110 ms debounce.
- **Fuzzy: broken.** Narrowing by `LIKE` re-imposes the substring requirement, so
  subsequence-only matches are eliminated before the ranker sees them. Recovering them
  needs a full-scan fallback, at which point you have paid for both.
- **Verdict: rejected — worst of both.**

### Recommendation: **(b), the compact SQL-built string index.**

It is the only option that is simultaneously cheaper in memory (37 MB vs 188 MB, and
eliminates 350–460 MB of collateral damage inside Zotero), faster to build (0.3–0.8 s vs
4.1 s), faster per keystroke (10–91 ms vs 43–123 ms), and **provably identical in results**
— the byte-identical top-20 at every scale is what makes this a free win rather than a
tradeoff. It also restores Zotero's deliberate lazy per-library item loading, which the
current design defeats for every group library the user has never opened.

**If 100k+ must feel instant**, add an inverted word index (vocabulary + `Int32Array`
postings) on top of (b) as a *later* step: **+18 MB, 416 ms to build, and one-word queries
drop from 140 ms to 2.0 ms [measured]**. Run the subsequence tier only over posting-list
candidates, or only when the substring tier returns fewer than ~50 hits. Do this second —
(b) alone gets 100k to a usable place, and postings add a ranking-semantics question that
deserves its own decision.

---

## 4. Findings that must be fixed regardless of architecture

Ranked by severity. Severity reflects user-visible consequence, not effort.

| # | Severity | Finding | User-visible impact |
|---|---|---|---|
| 1 | **Critical** | **`_building` promise-assignment ordering wedges the index forever** (`engine.js:123`). `this._building = (async () => {…finally { this._building = null; }})()` — if the body never reaches an `await`, the `finally` runs *before* the assignment, which then writes the settled promise back. **Verified and reproduced by me on the real engine:** a synchronous throw from `Libraries.getAll()` leaves `_building` non-null and **all 5 subsequent searches failed**; a feed-only library list returns the *identical stale array object* forever. | Every search fails with "Search failed — see Debug Output" for the life of the window, or the index silently freezes at its first contents and never rebuilds. Only closing the window recovers. One-line fix: assign to a local first, compare identity in the `finally`. Also restore `_dirty = true` on failure, or a transient error leaves the index silently stale. |
| 2 | **Critical** | **Nothing yields to the main thread.** The scan (`engine.js:495-512`) and the build loop (`:146-149`) are single synchronous blocks with no chunking, no deadline, and no abort. | The entire Zotero UI freezes — including a PDF reader tab mid-scroll — for 43–123 ms per keystroke at 100k and up to 659 ms at 500k, and for 3.1 s during a rebuild at 500k. Chunking at 4,000 entries/slice cuts the longest block to 5.2 ms with unchanged total throughput **[measured]**. |
| 3 | **Critical** | **A superseded search runs to completion before being discarded.** `overlay.js:597` checks `_stillCurrent(seq)` only *after* the scan returns; `engine.search()` takes no abort token. Queued searches resume as one microtask chain, which input and paint cannot preempt. | After any sync marks the index dirty, typing 9 characters produces **one uninterruptible 1,485 ms freeze at 100k / 8,319 ms at 500k**, of which 89% is work already known to be irrelevant **[measured]**. |
| 4 | **High** | **Any item change invalidates the entire index.** The notifier ignores the `ids` array Zotero passes and sets a global dirty flag; the next keystroke pays a full rebuild. `_lastBuilt` is stamped at build *end*, so the effective cycle is (build + 2 s), and once a build exceeds 2 s the rate limiter bounds nothing. | During a sync or import the main thread is **62–66% busy at 100k, 89–94% at 500k** **[measured]**. Re-indexing a single item costs 0.02 ms **[measured]**, so a 100-item sync batch should cost 2 ms, not ~900 ms. |
| 5 | **High** | **Group-library items can be ranked to #1, are preselected, and show no provenance.** Ranking ties break on `dateModified DESC` (`engine.js:506-512`, verified) — which an attacker sets by touching the item — and a *shorter* title wins outright without any cloning. `overlay.js:600` preselects rank #1. `libraryID` is not even in the index entry, so a hostile group item is visually identical to your own paper. Enter reaches `ZoteroPane.viewItems` → `loadURI`, which filters only `javascript:`/`data:` and routes everything else to the OS protocol handler. | A single item in any joined group library can occupy the top slot for a query you type habitually; your trained Cmd+O → 3 chars → Enter reflex then launches an attacker-chosen URI, while the row on screen names the paper you meant. **[measured]:** attacker at rank 1 for `attention`, `aiayn`, and the full title. |
| 6 | **High** | **Two teardown branches leak an entire window.** The shutdown-mid-attach abort branch (`bootstrap.js:88-103`) has `handles.notifierIDs` in scope and never uses it; the catch branch (`:119-128`) runs before `windowState.set()`. Both rely on `overlay.destroy()`, which calls `win.removeEventListener` unguarded *before* reaching engine teardown — on a dead window that throws and destroy aborts. | A surviving Notifier observer on the Zotero singleton retains the engine → its `_win` → the whole ChromeWindow and document → that window's entire index (~138 MB at 100k) for the rest of the session. **[measured]:** 1 stranded observer in each branch when the window is dead. Note: a `WeakMap` for `windowState` is a *false* fix — with the Map cleared but observers left, 20/20 closed windows were still strongly reachable **[measured]**. |
| 7 | **Medium** | **The deferred-attach path is dead code.** `attachToWindow` stores a `windowState` entry at `bootstrap.js:75` for a not-ready window, then the `load` handler re-enters and hits the guard at `:62` (`windowState.has(win)`) and returns immediately. Confirmed by reading; the entry is never deleted before re-entry. | Any main window seen before its scripts have run gets **no overlay, no hotkey, and no engine, permanently**, with nothing logged. Reachable via `startup()`, which iterates `getMainWindows()` with no readiness filter. |
| 8 | **Medium** | **No length cap on any indexed field**, and Zotero enforces none either (`itemDataValues.value` is an untyped column; no `MAX_LENGTH` in `item.js`). | One imported item with a 10 MB title costs 1.1 s of frozen UI and 5× its size in retained memory; 1,000 items with 100 KB titles cost 4.6 s **per rebuild** **[measured]**. Real-world ground truth: the longest field value in the user's library is **2,744 chars**, longest title 147 — so a 512-char cap costs nothing. |
| 9 | **Medium** | **Token count and query length are unbounded** (`engine.js:374`). Cost is O(N × tokens × fields). | Pasting a long citation — an explicitly intended use case — hits this on the first input event: 64 tokens is 2,340 ms at 100k, and 16 non-discriminating tokens is **9.9 s p50 / 12.5 s p99 at 500k** **[measured]**. |
| 10 | **Medium** | **Entries are keyed by the reusable SQLite rowid.** `items.itemID` is `INTEGER PRIMARY KEY` with **zero** `AUTOINCREMENT` in `userdata.sql`, so rowids are reused; the index is stale for at least 2 s. | The row on screen names paper X while Enter opens item Y — including Y's `url`, feeding finding #5. Also causes ordinary wrong-item-opened bugs during syncs. Fix: key on `libraryID` + `key`, the identity Zotero itself uses. |
| 11 | **Medium** | **`destroy()` does not cancel an in-flight build.** No generation token; the async IIFE runs to completion and assigns `_entries` on a discarded engine. | Closing a window mid-build burns a full 3.2 s build and allocates ~692 MB at 500k for a window that is going away — exactly when Zotero is trying to tear down. |
| 12 | **Low** | **Unsigned auto-update channel points at an unpublished path.** `manifest.json` declares `update_url: https://gshaikov.github.io/…/updates.json`. Verified in Zotero's prefs: `xpinstall.signatures.required` is set to **`false`** at `zotero.js:1462` (overriding the `true` at :27) and `extensions.blocklist.enabled` is `false`, with `autoUpdateDefault` `true`. No `updates.json` exists in the repo. | Whoever controls that URL can push arbitrary chrome-privileged JavaScript to every install within one update interval, with no signature check. Total compromise, delivered by the update mechanism. *(The working tree has already changed this to `127.0.0.1`.)* |
| 13 | **Low** | **Bidi and zero-width characters render verbatim.** `textContent` correctly prevents markup injection (12 payloads verified to reach `textContent` only — there is no XSS here), but U+202E and zero-width characters survive and are honoured by the renderer. | A group-library item can render a row that visually reads as a different paper than the one Enter opens — removing the user's only defence against finding #5. |
| 14 | **Low** | **Per-window index duplication.** `loadSubScript` gives each main window its own engine, index, and observer. | Two windows = two full indexes (188 MB each at 100k) and two uncoordinated rebuilds racing on the same thread. |
| 15 | **Low** | **Minor retention and churn:** `_prevFocus` pins a detached element while the overlay is open; `close()` leaves 50 result wrappers and 50 DOM rows alive until the next `open()`; the notifier allocates a 5-element array per event; `_paintSelection` rewrites all 50 rows and forces a synchronous layout *from inside* the mutation loop on every arrow key. | Small and bounded, but the layout thrash sits directly on top of the scan, and all four are a few lines each. |

**Explicitly cleared — not problems.** No memory leak on the happy path (8.6 B/cycle over
20,000 cycles; 0 stranded observers). No XSS (no `innerHTML`/`eval` anywhere; all 12
payloads land on `textContent`). No ReDoS (all 11 regexes measured linear). No prototype
pollution (`KEY_ALIASES` correctly guards with `hasOwnProperty.call`). No idle CPU cost
with the overlay closed (no intervals, no polling, no O(n²) anywhere).

**One inaccurate citation:** `overlay.js:241` justifies `stopImmediatePropagation` as
"Zotero's own idiom (zoteroPane.js:932-933)". Those lines contain only
`preventDefault`/`stopPropagation`, and `stopImmediatePropagation` appears **zero** times
in `zoteroPane.js`. The call is defensible for a modal overlay; the justification is not.
All other cited line numbers spot-checked were accurate.

---

## 5. Decisions needed from you

Each is a genuine either/or with a real cost on both sides.

**1. How big should this actually scale?**
→ **(A)** Tune for libraries up to ~20k papers. The current architecture stays; you fix the
correctness bugs in §4 and stop. Cheapest path, works today, and matches your real library
(570 papers) with 35× headroom.
→ **(B)** Target 100k–500k. That means the rewrite to architecture (b). More work, and the
plugin takes on a dependency on Zotero's database schema.
*Everything below only matters if you pick (B).*

**2. Fuzzy matching everywhere, or instant results at 500k?**
→ **(A)** Keep fuzzy over the whole library. Architecture (b) gets 100k to 10–91 ms per
keystroke — good — but 500k stays around 300–500 ms, which is noticeable.
→ **(B)** Add a word index on top (+18 MB) so one-word queries drop to ~2 ms even at 500k.
The cost: fuzzy matching becomes a *fallback* that runs only when normal matching finds
fewer than ~50 results, rather than always running. In practice that is when you actually
need it (typing `aiayn`), but the ranking will occasionally differ from today's.

**3. Build the index at startup, or on first use?**
→ **(A)** At startup (today's behaviour). The switcher is instant the first time you press
the hotkey, but every Zotero launch pays the full build whether or not you use it.
→ **(B)** On first hotkey press, showing "Indexing…" for a moment. Zotero starts faster and
costs nothing for users who never open the switcher; you wait once per session.

**4. Include shared group libraries in search results by default?**
→ **(A)** Yes (today's behaviour). You can find everything from one place. But anyone with
write access to a shared library can craft an item that outranks your own paper for a query
you type every day, and pressing Enter on it can launch a link they chose.
→ **(B)** Only your own library by default, with group libraries opt-in per library. Safer,
but you have to remember to enable the ones you actually work in.

**5. Should the top result stay preselected?**
→ **(A)** Yes. Cmd+O → type → Enter stays a two-second reflex — the whole point of the tool.
→ **(B)** Preselect only when the top hit is from your own library; a group-library hit
requires one arrow-down. Costs one keystroke in a rare case, removes the entire
one-keystroke hijack risk. *(A middle option: always preselect, but label every non-personal
row with its library name so a foreign item is never invisible. This is what the in-flight
rewrite does.)*

**6. Cap the length of indexed text?**
→ **(A)** Yes — truncate titles and author lists at ~512 characters. The longest field in
your entire library is 2,744 characters and the longest title is 147, so this is invisible
in practice and removes a whole class of freeze.
→ **(B)** No cap. One malformed import with a huge title can freeze Zotero for seconds on
every index rebuild.
*(Recommendation: (A). This one is close to free.)*

**7. Ship auto-updates now, or turn them off until there's a release process?**
→ **(A)** Keep `update_url`. Users get fixes automatically — but because Zotero disables
add-on signature checks, whoever controls that URL controls every install. It currently
points at a path that has never served a file.
→ **(B)** Remove `update_url` until updates are published from CI on a tagged release with
a pinned hash. Manual updates in the meantime.
*(Recommendation: (B) until the release process exists.)*

---

## Appendix — what the in-flight rewrite already fixes

Read from the uncommitted working tree; **not measured, tested, or reviewed by me.**

**Appears addressed:** architecture (b) via `Zotero.DB.queryAsync` (#c); the `_building`
wedge, now assigned before the `.finally()` chain with a generation guard (#1); chunking and
bounded top-K (#2); character bitmask; `charCodeAt`; library provenance on rows via
`libraryID` and a `.zqs-lib` badge (#5, #13); `_lastBuiltStart` stamped at build start (#4,
partially); `update_url` neutralised (#12).

**Appears still open:** the notifier still sets a whole-index dirty flag rather than
patching the `ids` it receives (#4); no token/query-length cap (#9); no field-length cap
(#8). The bootstrap findings (#6, #7) are in `bootstrap.js`, which is unmodified.

**Recommendation:** re-run the correctness checks in §4 against the rewrite before
committing — in particular #4, #8 and #9, which the rewrite does not appear to cover, and
#6/#7, which it does not touch at all.
