# Zotero Quick Switcher

An Obsidian-style quick switcher for Zotero 9. Press **Cmd+O** from any tab — the library tab or a
PDF you're reading — type a few words, and jump straight to a paper.

- Overlay search bar, available from any tab
- Fuzzy, relevance-ranked results as you type; 10 visible, scrolls past 10
- First result preselected; arrow keys move the selection (wrapping at the ends)
- **Enter** opens the paper in a tab, or switches to its tab if it's already open

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

That writes `build/zotero-quick-switcher-0.1.0.xpi`. Then, in Zotero:

1. **Tools → Plugins**
2. Gear icon (top right) → **Install Plugin From File…**
3. Pick `build/zotero-quick-switcher-0.1.0.xpi`
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

Zotero's search returns matching item IDs with **no relevance score and no ordering** — there's no
`ORDER BY` anywhere in `search.js`. Ranking has to happen client-side regardless, and once you're
ranking client-side, `Zotero.Search` costs more than it gives: its `contains` operator compiles to
SQL `LIKE '%token%'`, so a candidate must contain every token as a literal substring. That makes
fuzzy matching impossible — `aiayn` could never reach the ranker.

So the plugin keeps its own index instead:

1. **Index** (`src/engine.js`). Built once at startup from `Zotero.Items.getAll()` per library, and
   rebuilt when the Notifier reports item changes. For each paper it stores lowercased title,
   title initials, short title, creators (in *both* name orders), year, venue and citation key —
   plus the id of the attachment that would open, resolved synchronously so the `open` badge needs
   no async work per row.
2. **Rank.** Per token, per field, strongest match wins: exact > prefix > word-start > substring >
   subsequence. Title outweighs creators, which outweigh venue and year. Whole-query bonuses push an
   exact or prefix title match to the top, and a mild brevity preference keeps a short precise title
   above a long one containing the same words. Every token must match something, so multi-word
   queries narrow rather than broaden. Ties break on most-recently-modified.

That yields the fuzzy behaviour you'd expect: `attention`, `attention need`, `atten`, `aiayn` and
`atnisallyn` all find *Attention Is All You Need*.

`src/opener.js` resolves the paper to its reader-openable attachment and calls
`Zotero.Reader.open()`, which **already does its own already-open detection** — it selects the
existing tab, loaded or unloaded, rather than duplicating it. So "switch to the existing tab" is
Zotero's own behaviour, not a reimplementation. Papers with no openable attachment fall back to
Zotero's url/DOI handling, and finally to revealing the item in the library, so Enter always does
something visible.

`src/overlay.js` builds the UI as a `position: fixed` XHTML div appended to `documentElement` —
the same construct as Zotero's `#zotero-tab-cover`, which demonstrably paints over a PDF reader. A
XUL `<panel>` was the other candidate and was rejected: it hijacks Escape (Zotero's own source
comments on having to work around this), and on macOS it's a separate native window whose hide
races the focus hook that runs when tabs switch.

The hotkey is a **capture-phase** `keydown` listener on the chrome window. The reader is an
in-process, non-remote `<browser>`, so its key events travel through the chrome window, and capture
runs before the reader's own handler can swallow the combo. This is the same mechanism Zotero uses
to make Cmd+W close a reader tab while the PDF has focus.

## Tests

```sh
./test/run.sh
```

The harnesses execute `src/engine.js` and `src/overlay.js` in Node against stubbed Zotero and DOM
objects. They need no Zotero install and never touch your profile. 55 assertions covering:

- ranking, including the fuzzy and acronym cases (`aiayn` → *Attention Is All You Need*)
- text normalisation — pasted citation titles ending in a period, `Last, First` author form,
  parenthesised `(LeCun 2015)` citations, hyphenated queries, apostrophes, and diacritics
  (`uber` finds *Über…*)
- hotkey matching across keyboard layouts, including Dvorak and named keys like `alt+space`
- the overlay state machine — a dismissed query rendering into a reopened switcher, teardown
  during an in-flight search, a click on a stale row opening the wrong paper, and the synthesized
  mousemove that could steal the keyboard selection
- the index-rebuild race, where an item changing mid-scan must leave the index dirty

## Known limitations

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
