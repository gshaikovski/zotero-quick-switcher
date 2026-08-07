# Where this stands

**Ready to install and test.** Two correctness review passes and one performance/security/memory
audit are folded in. The offline suite passes (92 assertions across six harnesses). It has still
never been run inside Zotero — that is the remaining step, and it is yours.

## Install

```sh
./build.sh
```

Then Zotero → **Tools → Plugins** → gear icon → **Install Plugin From File…** → pick
`build/zotero-quick-switcher-0.1.0.xpi` → restart Zotero. Press **Cmd+O**.

## Measured behaviour

Against a synthetic 100,000-paper library built on Zotero's real schema:

| | |
|---|---|
| Index build (once, on first Cmd+O) | **214 ms**, chunked so it never blocks |
| Index memory | **38 MB** (entries + word index) |
| Per keystroke | **2–15 ms** |
| At the 200k cap | 795 ms build, 75 MB, 2–31 ms per keystroke |
| Longest uninterrupted UI block, at the cap | **3.3 ms** — under one frame |
| Adversarial 12-token query | 29 ms, flat (character-bitmap prefilter) |
| Hostile 10 MB item title | 1 ms, bounded — length-capped on the way in |
| Leak check | 41 B/cycle over 6,000 searches — i.e. flat |

For comparison, the previous implementation at the same size: 194 MB of index **plus ~376 MB
permanently retained** in Zotero's object cache, and 50–260 ms of *blocking* per keystroke.

## Decisions you made, and what they mean

- **SQL only, no API fallback.** Fastest and simplest. If a future Zotero changes the database
  schema, the switcher stops returning results — but it now fails *loudly*: the overlay says
  "Search unavailable" and the reason is logged, rather than silently showing nothing.
- **My Library only.** Group libraries are excluded in SQL, so a shared library cannot put a crafted
  item under your reflexive Enter. Their papers stay reachable through Zotero's own search.
- **Word index, with fuzzy as fallback.** Common words drop to ~2–10 ms. The cost: when the word
  index already has 50+ hits, the fuzzy pass is skipped, so rankings can occasionally differ from an
  exhaustive scan.
- **Lazy index build.** Zero cost to Zotero's startup. The build kicks off the moment the overlay
  opens, so it overlaps your first keystrokes rather than following them.
- **200k paper cap, newest first.** Bounded at ~75 MB. Beyond that the older tail is not searchable
  here, and the status line says so.
- **Chunked, abandonable scanning.** The UI never blocks, and typing ten characters costs about one
  scan rather than ten.

## What to watch for on first run

Static analysis cannot settle these. If something looks wrong: **Help → Debug Output Logging → View
Output**, and look for `[quick-switcher]`.

1. **The hotkey while a PDF reader tab is focused.** The design rests on a capture-phase keydown
   listener on the chrome window seeing events that originate inside the reader's `<browser>`. The
   source says it will — it is how Cmd+W closes a reader tab — but this deserves a real test. Open a
   PDF, click into the page, press Cmd+O.
2. **Focus landing in the search box.** If the overlay appears but typing goes into the PDF, the
   retry in `_focusInput()` needs strengthening.
3. **The overlay painting above the reader.** It mirrors Zotero's own `#zotero-tab-cover`. If it
   renders behind the PDF, `SPEC.md` §2.1 documents the XUL `<panel>` fallback and its costs.
4. **Ranking quality on your real library.** The weights are reasoned, not tuned against your
   papers. If the wrong paper tops a query you actually type, that is a one-line change per weight
   in `src/engine.js` — worth telling me.

## Tests

```sh
./test/run.sh
```

Six harnesses, 92 assertions, no Zotero required and nothing touched outside the repo. They cover
ranking and fuzzy matching, text normalisation, hotkey matching across layouts, the overlay state
machine and its races, plugin lifecycle (update/disable/window-close), and scale — including
memory-per-entry, keystroke latency, chunk yielding, search abandonment, hostile metadata and a
loud-failure check on the SQL path.

## History

- `SPEC.md` — implementation spec derived from reading the shipped Zotero 9.0.6 source.
- `REVIEW-FINDINGS.md` / `REVIEW-FINDINGS-2.md` — the two correctness review passes.
- `REVIEW-AUDIT.md` — disposition of all 34 pass-2 findings.
- `AUDIT.md` — the performance/security/memory audit, if the synthesis pass wrote it.

## Known gaps, deliberately

- The index rebuilds wholesale on item changes (rate-limited to once per 5 s). Patching individual
  items would be faster during a large sync; measured at 0.02 ms per item, so worth doing if syncs
  ever feel sluggish.
- The index is per main window. Two windows means two copies. Hoisting it to a singleton is a real
  refactor and irrelevant at one window.
- Popped-out reader windows get no overlay — a separate window type that never receives
  `onMainWindowLoad`.
- `_pickReaderAttachment` omits Zotero's parent-URL tiebreak, so an item with several PDFs can open
  a different one than double-click would.

## Ground truth

The extracted Zotero 9.0.6 source used to verify every API call is at
`/Users/george/.claude/jobs/be8c93f2/tmp/omni` — a read-only copy out of
`/Applications/Zotero.app/Contents/Resources/app/omni.ja`. Re-extract with `unzip` if the job dir is
cleaned up. Never write into the app or the Zotero profile.
