# Zotero Quick Switcher

An Obsidian-style quick switcher for Zotero 9. Press **Cmd+O** from any tab — the library tab or a
PDF you're reading — type a few words, and jump straight to a paper.

- Overlay search bar, available from any tab
- Results ranked by relevance as you type, 10 visible, scrolls past 10
- First result preselected; arrow keys move the selection (wrapping at the ends)
- **Enter** opens the paper in a new tab, or switches to its tab if it's already open
- **Esc** dismisses

Rows already open in a tab are badged `open`.

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

## Changing the hotkey

The hotkey is a preference, not hardcoded. In **Advanced → Config Editor**, edit:

```
extensions.quickswitcher.hotkey
```

Format is modifiers joined by `+`, then the key — e.g. `accel+O`, `accel+shift+P`, `alt+space`.
`accel` means Cmd on macOS and Ctrl elsewhere. Restart Zotero (or disable/re-enable the plugin)
after changing it.

`accel+O` is the default because it's genuinely unclaimed in Zotero 9: it isn't in any main-window
keyset, isn't one of the `extensions.zotero.keys.*` shortcuts (those all require accel+**shift**),
and isn't in the PDF reader's own key table. Note that `Cmd+Shift+O` *is* taken (New Note) and
`Cmd+Shift+K` is taken (focus quick search), so avoid those.

## How it works

Zotero's search returns matching item IDs with **no relevance score and no ordering** — there's no
`ORDER BY` anywhere in `search.js`. So the plugin splits the work:

1. **Narrowing (SQLite).** `src/engine.js` runs the same `quicksearch-titleCreatorYear` condition
   Zotero's own search box uses. It tokenises the query, ORs each token across
   title / publicationTitle / shortTitle / court / year / citationKey / creator, ANDs the tokens
   together, and excludes child notes and attachments.
2. **Ranking (JS).** Results are then scored here. Per token, per field, strongest match wins:
   exact field > field prefix > word-start prefix > substring > subsequence. Title outweighs
   creators, which outweigh year and publication. Whole-query bonuses push an exact or
   prefix title match to the top, and a mild brevity preference keeps a short precise title above a
   long one containing the same words. Ties break on most-recently-modified.

`src/opener.js` resolves the selected paper to the attachment that actually opens
(`getBestAttachment()`), then calls `Zotero.Reader.open()`. That call already does its own
already-open detection, so "switch to the existing tab" is Zotero's behavior, not a reimplementation
of it. Papers with no openable attachment fall back to Zotero's own url/DOI handling, and finally to
revealing the item in the library tab — so Enter always does something visible.

`src/overlay.js` builds the UI as a XUL `<panel>`, the same primitive Zotero uses for its tabs menu.
A panel renders in its own popup layer, which is what makes it reliably paint *above* a PDF reader
tab; an absolutely-positioned `<div>` sharing the stack with the reader's `<browser>` is not
dependable for that. The hotkey is a **capture-phase** `keydown` listener on the chrome document —
the same mechanism Zotero itself uses to make Cmd+W close a reader tab while the PDF has focus.

## Known limitations

- **Matching is per-word substring, not true fuzzy.** Typing `attention need` or `atten` finds
  "Attention Is All You Need"; typing `aiayn` does not. This is a consequence of stage 1: Zotero's
  SQL filter uses `LIKE '%token%'`, so a subsequence-only candidate never reaches the ranker. Real
  fuzzy matching would need a client-side index of the whole library. The ranker already contains a
  subsequence scorer for when that changes.
- **Minimum query length is 2 characters.** A single character matches almost everything.
- **Very broad queries are capped** at 5000 candidates before ranking, and the status line says
  `narrowed` when that happens.
- A reader opened in its *own window* (rather than a tab) doesn't get the overlay — that window is a
  separate window type and never receives `onMainWindowLoad`.

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
prefs.js                default hotkey pref
src/engine.js           Zotero.Search narrowing + relevance ranking
src/opener.js           item -> attachment -> tab, incl. already-open switching
src/overlay.js          the panel UI, hotkey capture, keyboard navigation
skin/quickSwitcher.css  theme-aware styling via Zotero's CSS variables
build.sh                packages the .xpi
```

## Status

Written against Zotero **9.0.6** (Gecko 140 ESR), with every API call verified against the shipped
source in `omni.ja` rather than from documentation. `strict_min_version` is set to `7.0`, but it has
only been checked against 9.0.6.
