# Zotero Quick Switcher

An Obsidian-style quick switcher for Zotero 9. Press **Cmd+O** from any tab — the library tab or a
PDF you're reading — type a few words, and jump straight to a paper.

- Overlay search bar, available from any tab
- Fuzzy, relevance-ranked results as you type; 10 visible, scrolls past 10
- First result preselected; arrow keys move the selection (wrapping at the ends)
- **Enter** opens the paper in a tab, or switches to its tab if it's already open

<img width="718" height="692" alt="image" src="https://github.com/user-attachments/assets/9e8977b3-57d0-4a26-92f0-2a85cbee7a7a" />

Rows already open in a tab are badged `open`.

| Key | Action |
|---|---|
| `Cmd+O` | Open / close the switcher |
| `↑` `↓` | Move the selection (wraps) |
| `Home` `End` | Jump to first / last result |
| `Enter` | Open the paper in a reader tab, or switch to its existing tab |
| `Shift+Enter` | Reveal the item in the library tab instead |
| `Cmd+Enter` | Open the tab in the background, without focusing it |
| `Esc` | Dismiss, returning focus where it was |

## Install

Build the `.xpi`:

```sh
./build.sh
```

That writes `build/zotero-quick-switcher-1.0.0.xpi`. Then, in Zotero:

1. **Tools → Plugins**
2. Gear icon (top right) → **Install Plugin From File…**
3. Pick `build/zotero-quick-switcher-1.0.0.xpi`
4. Restart Zotero

Press **Cmd+O** to open the switcher.

Installing from a file avoids two traps that make the "drop a proxy file in the profile" workflow
fail silently — see [Development install](#development-install) if you want that route anyway.

## Preferences

Both live in **Advanced → Config Editor**. Restart Zotero (or disable/re-enable the plugin) after
changing either.

**`extensions.quickswitcher.hotkey`** — default `accel+O`. Modifiers joined by `+`, then the key:
`accel+O`, `accel+shift+P`, `alt+space`. `accel` is Cmd on macOS, Ctrl elsewhere.

`accel+O` is the default because it's genuinely unclaimed in Zotero 9: not in any main-window
keyset, not one of the `extensions.zotero.keys.*` shortcuts (those all require accel+**shift**), and
not in the PDF reader's own key table. Note `Cmd+Shift+O` *is* taken (New Note) and `Cmd+Shift+K` is
taken (focus quick search), so avoid those.

**`extensions.quickswitcher.alwaysOpenInZoteroTab`** — default `true`. Enter always opens the paper
in a Zotero reader tab. Set it to `false` to defer to Zotero's own file-handler preferences instead,
so a paper opens in whatever external app you configured under *Settings → General → "Open PDFs
using"* — matching double-click behaviour, but meaning Enter may not produce a tab at all.

## How it works

Zotero has no search index you can reuse for this. The `fulltextWords` tables are a hand-rolled
inverted index over **PDF file text only** — they contain no titles and no creators. And
`itemDataValues.value` carries a `UNIQUE BINARY` index usable only for `=`, so every
`LIKE '%token%'` degrades to a full table scan.

Three approaches were measured against a 100k-paper library built on Zotero's real schema:

| Approach | Build | Per keystroke | Memory | Fuzzy? |
|---|---|---|---|---|
| `Zotero.Items.getAll` + `getAsync` + `loadDataTypes` | seconds | 50–260 ms | 194 MB **+ ~376 MB** permanently retained in Zotero's `_objectCache` | yes |
| `Zotero.Search` (SQL `LIKE`) per keystroke | none | 81–92 ms | ~0 | **no** |
| **One SQL query → compact index + word index** | 214 ms once | **2–15 ms** | **38 MB** | yes |

The third is what this plugin does. Note the second is the *slowest* — SQL cannot help here, because
there is no index to use and no way to express subsequence matching.

At the 200,000-paper cap: 795 ms to build, 75 MB, 2–31 ms per keystroke, and **no uninterrupted
main-thread block longer than 3.3 ms** — the scan yields between slices, so the UI never stutters
even while results are still arriving.

**1. Index** (`src/engine.js`). One static SQL query via `Zotero.DB.queryAsync`, built lazily on your
first Cmd+O. It never materialises `Zotero.Item` objects — that is what caused the 376 MB of
permanently retained heap, since every item touched is pinned in Zotero's unbounded object cache for
the session. `baseFieldMappingsCombined` resolves type-specific fields onto their base field, so a
conference paper's `proceedingsTitle` and a case's `caseName` land in the right place. Annotations
are excluded in SQL — at 100k papers a library holds ~250k of them, and Zotero's own
`getAll(onlyTopLevel)` does *not* filter them out.

The index stores only what matching needs: normalised strings, a character bitmap, an id and a
stable key — **325 bytes per paper**. Everything you see on screen is fetched from Zotero for the
≤50 rows actually displayed.

**2. Match.** A **word index** (sorted vocabulary + flat `Int32Array` postings) answers the common
case: a binary search finds every word starting with your token, and postings are intersected across
tokens. That took a common word from 71 ms to 9.6 ms at 200k papers.

Full **fuzzy scanning is the fallback**, running only when the word index finds fewer than 50 hits —
which is exactly when you need it (`aiayn`, or a mid-word substring). When it runs, a **character
bitmap** per entry rejects most candidates with a single integer AND before any string work.

**3. Rank.** Per token, per field, strongest match wins: exact > prefix > word-start > substring >
subsequence. Title outweighs creators, which outweigh venue and year. Every token must match
something, so multi-word queries narrow rather than broaden. Field scoring **short-circuits**, so a
perfect title match never bothers scoring the venue.

**4. Scan.** Chunked and abandonable: the scan yields to the event loop between slices, so the UI
never blocks, and a superseded search stops the moment you type another character. Typing ten
characters costs roughly one scan, not ten.

That yields the fuzzy behaviour you'd expect: `attention`, `attention need`, `atten`, `aiayn` and
`atnisallyn` all find *Attention Is All You Need*, as do `LeCun, Yann`, `(LeCun 2015)`, a pasted
citation title ending in a period, and `uber` for *Über…*.

`src/opener.js` resolves the paper to its reader-openable attachment and calls
`Zotero.Reader.open()`, which **already does its own already-open detection** — it selects the
existing tab, loaded or unloaded, rather than duplicating it. So "switch to the existing tab" is
Zotero's own behaviour, not a reimplementation.

`src/overlay.js` builds the UI as a `position: fixed` XHTML div appended to `documentElement` — the
same construct as Zotero's `#zotero-tab-cover`, which demonstrably paints over a PDF reader. A XUL
`<panel>` was rejected: it hijacks Escape (Zotero's own source comments on working around this), and
on macOS it is a separate native window whose hide races the focus hook that runs when tabs switch.

The hotkey is a **capture-phase** `keydown` listener on the chrome window. The reader is an
in-process, non-remote `<browser>`, so its key events travel through the chrome window, and capture
runs before the reader's own handler can swallow the combo. This is the same mechanism Zotero uses
to make Cmd+W close a reader tab while the PDF has focus.

## Security

This runs with system privileges inside Zotero, and **item metadata is attacker-controlled** — it
arrives via BibTeX/RIS import, DOI lookup, the browser connector, and group libraries other people
can write to. The design accounts for that:

- **The SQL is entirely static.** Your query never reaches SQL, so injection is impossible by
  construction rather than by escaping.
- **Every indexed field is length-capped.** An uncapped 10 MB title costs 1,261 ms and 22 MB for a
  single item; capped, it is 1 ms and bounded. Query length and token count are capped too.
- **Rendering is `textContent` only** — no `innerHTML` anywhere — and titles are stripped of
  bidirectional overrides and zero-width characters, which could otherwise make a row read as a
  different paper than the one Enter opens.
- **Only My Library is indexed.** Group libraries are excluded in SQL. Anyone with write access to a
  shared library could otherwise craft a title that outranks your own paper for a query you type
  daily, leaving a link of their choosing under your reflexive Enter. Group papers remain findable
  through Zotero's own search. (A library-name badge remains in the render path as a backstop, in
  case that filter is ever wrong.)
- **Entries carry the item's stable key.** SQLite reuses rowids after deletion, so an id cached at
  index time is re-checked before anything is opened.
- **Debug output never contains item titles.** Zotero's Debug Output is routinely submitted to
  support, and your library is your private research.
- `update_url` deliberately points at an unroutable address. It is a required manifest field, but
  pointing it at a namespace that could later be re-registered would let whoever claimed it push
  system-privileged JavaScript to this plugin.

## Known limitations

- **Very large libraries are capped at 200,000 papers**, most-recently-modified first (~75 MB).
  Beyond that the older tail is not searchable here. The status line says so when it applies.
- **Fuzzy matching is a fallback, not always-on.** When the word index already finds 50+ ordinary
  matches, the fuzzy pass is skipped — so a mid-word substring match can occasionally be ranked
  differently than it would be under an exhaustive scan. This is the trade that keeps common words
  at ~2–10 ms.
- **Group libraries are not searchable** from the switcher. See Security.
- The index rebuilds wholesale when items change, rate-limited to once every 5 seconds. Patching
  individual items incrementally would be faster during a large sync but is not implemented.
- A reader opened in its **own window** (rather than a tab) doesn't get the overlay — that's a
  separate window type which never receives `onMainWindowLoad`.
- If a paper is already open in a reader *window* rather than a tab, Enter matches that window and
  no tab appears, so nothing visibly happens in the main window.
- With two main windows open, activation is ignored in the non-focused one: `Zotero.Reader.open`
  hardcodes the most-recent window, so acting from a background window would open the tab somewhere
  unexpected.
- Feeds are excluded from the index — this is a switcher for papers.

## Development install

If you'd rather run from source than from an `.xpi`, Zotero supports a proxy file — but two shipped
defaults make it fail *silently*, which is worth knowing before you lose an hour:

1. Create `<profile>/extensions/quick-switcher@zotero-search.app` (filename must equal the plugin ID
   exactly, no extension) containing one line: the absolute path to this repo.
2. Zotero ships `extensions.startupScanScopes = 0`, so the extensions directory **is not scanned**
   on a normal restart. With Zotero closed, remove `extensions.lastAppBuildId` from the profile's
   `prefs.js` to force a rescan.
3. Zotero ships `extensions.autoDisableScopes = 15`, so a directory-detected plugin installs
   **user-disabled**. Either set `user_pref("extensions.autoDisableScopes", 0);` in `prefs.js`, or
   just enable it once in Tools → Plugins.

Unsigned plugins need no pref changes — Zotero sets `xpinstall.signatures.required = false` by
default.

## Troubleshooting

Plugin hook errors are swallowed by Zotero and never surface in the UI, so a failure looks like
"nothing happened". To see what went wrong:

- **Help → Debug Output Logging → View Output**, then reproduce. All plugin messages are prefixed
  `[quick-switcher]`.
- **Tools → Developer → Error Console** for thrown exceptions.

If the plugin doesn't appear in Tools → Plugins at all, the cause is almost always the manifest:
`manifest_version` must be `2`, and `applications.zotero` must carry `id`, an `https:` `update_url`,
and a `strict_max_version` that covers your Zotero version.

## Layout

```
manifest.json           plugin metadata (manifest_version 2, applications.zotero)
bootstrap.js            lifecycle hooks; attaches/detaches per main window
prefs.js                default prefs (hotkey, open-in-tab behaviour)
src/engine.js           in-memory index + fuzzy relevance ranking
src/opener.js           item -> attachment -> tab, incl. already-open switching
src/overlay.js          the overlay UI, hotkey capture, keyboard navigation
skin/quickSwitcher.css  theme-aware styling via Zotero's CSS variables
build.sh                packages the .xpi
```

## Status

Written against Zotero **9.0.6** (Gecko 140 ESR), with every API call verified against the shipped
source in `omni.ja` rather than from documentation — most public Zotero plugin advice targets the
Zotero 6 overlay architecture and is wrong for 7+.

`SPEC.md` is the implementation spec derived from that source reading. `REVIEW-FINDINGS.md` records
an adversarial review pass. `strict_min_version` is set to `7.0`, but this has only been checked
against 9.0.6.
